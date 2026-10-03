import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type ChannelModel, type ConfirmChannel, connect } from 'amqplib';
import { API_CONFIG, type ApiConfig } from '../config';

/**
 * The one RabbitMQ connection the API uses for the outbox relay, the notification consumer and the
 * scheduler's events (BRD 23, MQ-01). Declares the whole topology once at boot — exchange, retry queue,
 * dead-letter exchange/queue, and the notifications queue — so every other service just publishes or
 * consumes by name and never touches `amqplib` directly.
 *
 * Retry-with-backoff needs no delayed-message plugin: a message that failed processing is *republished*
 * to `<prefix>q.retry` with a per-message `expiration` (2s, 8s, 20s for attempts 1, 2, 3). That queue's own
 * `x-dead-letter-exchange` points back at the main events exchange with no routing-key override, so once
 * the TTL elapses RabbitMQ itself redelivers the message to the original queue — a real delay, not a
 * `setTimeout`, and it survives the API process restarting mid-wait. After the configured max attempts,
 * the message goes to the dead-letter queue instead, for `/admin/system/dead-letters` to inspect and replay.
 */
@Injectable()
export class RabbitService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Rabbit');
  private model!: ChannelModel;
  private confirmChannel!: ConfirmChannel;
  private consumeChannel!: import('amqplib').Channel;
  private connected = false;

  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  private name(suffix: string): string {
    return `${this.config.mqPrefix}${suffix}`;
  }

  get events(): string {
    return this.name('events');
  }
  get dlx(): string {
    return this.name('dlx');
  }
  get dlq(): string {
    return this.name('q.dlq');
  }
  get retryQueue(): string {
    return this.name('q.retry');
  }
  get notificationsQueue(): string {
    return this.name('q.notifications');
  }

  async onModuleInit(): Promise<void> {
    this.model = await connect(this.config.rabbitmqUrl);
    this.model.on('error', (error) => {
      this.connected = false;
      this.logger.error(`connection error: ${(error as Error).message}`);
    });
    this.model.on('close', () => (this.connected = false));
    this.confirmChannel = await this.model.createConfirmChannel();
    this.consumeChannel = await this.model.createChannel();
    await this.declareTopology(this.confirmChannel);
    this.connected = true;
  }

  async onModuleDestroy(): Promise<void> {
    await this.confirmChannel?.close().catch(() => undefined);
    await this.consumeChannel?.close().catch(() => undefined);
    await this.model?.close().catch(() => undefined);
  }

  /** For `/readyz` (BRD 24): checks the connection's own last known state — deliberately not an actual
   * round-trip call like `checkExchange`, which throws *and closes the channel* if it ever fails,
   * breaking real publishing/consuming just to answer a health probe. `connected` is kept up to date by
   * the connection's own `close`/`error` events, so this still reflects reality, just without the risk. */
  async ping(): Promise<void> {
    if (!this.connected) throw new Error('RabbitMQ connection is not open');
  }

  private async declareTopology(ch: ConfirmChannel): Promise<void> {
    await ch.assertExchange(this.events, 'topic', { durable: true });
    await ch.assertExchange(this.dlx, 'topic', { durable: true });
    await ch.assertQueue(this.dlq, { durable: true });
    await ch.bindQueue(this.dlq, this.dlx, '#');
    // No queue-level TTL: each retry publish sets its own `expiration` for a per-attempt backoff instead.
    await ch.assertQueue(this.retryQueue, { durable: true, arguments: { 'x-dead-letter-exchange': this.events } });
    await ch.assertQueue(this.notificationsQueue, { durable: true });
    await ch.bindQueue(this.notificationsQueue, this.events, 'order.*');
    await ch.bindQueue(this.notificationsQueue, this.events, 'payment.*');
    await ch.bindQueue(this.notificationsQueue, this.events, 'cart.*');
  }

  /** Publishes with a publisher confirm: resolves only once the broker has acknowledged the message,
   * which is what lets `OutboxRelay` mark a row published only when it is genuinely safe to. */
  publish(routingKey: string, payload: unknown, options: { messageId?: string; headers?: Record<string, unknown>; expirationMs?: number } = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      const ok = this.confirmChannel.publish(
        this.events,
        routingKey,
        Buffer.from(JSON.stringify(payload)),
        {
          persistent: true,
          contentType: 'application/json',
          ...(options.messageId ? { messageId: options.messageId } : {}),
          ...(options.headers ? { headers: options.headers } : {}),
          ...(options.expirationMs !== undefined ? { expiration: String(options.expirationMs) } : {}),
        },
        (error) => (error ? reject(error as Error) : resolve()),
      );
      if (!ok) this.logger.warn(`publish buffer full for ${routingKey}; waiting on confirm anyway`);
    });
  }

  /** Same publish-with-confirm, but straight to the retry queue (used by the notification consumer on a
   * transient failure) or the dead-letter queue (used after retries are exhausted, and by the admin
   * "replay" action) — both bypass the topic exchange since they target one specific queue by name. */
  publishToQueue(queue: string, routingKey: string, payload: unknown, options: { headers?: Record<string, unknown>; expirationMs?: number } = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      this.confirmChannel.sendToQueue(
        queue,
        Buffer.from(JSON.stringify(payload)),
        {
          persistent: true,
          contentType: 'application/json',
          headers: { ...options.headers, 'x-original-routing-key': routingKey },
          ...(options.expirationMs !== undefined ? { expiration: String(options.expirationMs) } : {}),
        },
        (error) => (error ? reject(error as Error) : resolve()),
      );
    });
  }

  async consume(queue: string, prefetch: number, onMessage: (msg: import('amqplib').ConsumeMessage) => Promise<void>): Promise<void> {
    await this.consumeChannel.prefetch(prefetch);
    await this.consumeChannel.consume(queue, (msg) => {
      if (!msg) return; // consumer cancelled by the broker
      onMessage(msg).catch((error) => this.logger.error(`unhandled consumer error on ${queue}: ${(error as Error).message}`));
    });
  }

  ack(msg: import('amqplib').Message): void {
    this.consumeChannel.ack(msg);
  }

  /** Non-destructive peek: pulls up to `limit` messages off the queue and immediately nacks them back
   * with `requeue: true`, so `/admin/system/dead-letters` can list what's there without consuming it.
   * A concurrent peek can reorder the queue slightly (it's a genuine limitation of `basic.get`, not a
   * dedicated browse API) — acceptable for an inspection tool, not for exactly-once processing. */
  async peek(queue: string, limit: number): Promise<Array<{ routingKey: string; body: unknown; deadAt: string | undefined; retryCount: number; lastError: string | undefined }>> {
    const ch = this.consumeChannel;
    const seen: Array<{ routingKey: string; body: unknown; deadAt: string | undefined; retryCount: number; lastError: string | undefined }> = [];
    for (let i = 0; i < limit; i++) {
      const msg = await ch.get(queue, { noAck: false });
      if (!msg) break;
      const headers = msg.properties.headers ?? {};
      seen.push({
        routingKey: (headers['x-original-routing-key'] as string) ?? msg.fields.routingKey,
        body: JSON.parse(msg.content.toString('utf8')),
        deadAt: msg.properties.timestamp ? new Date(Number(msg.properties.timestamp) * 1000).toISOString() : undefined,
        retryCount: Number(headers['x-retry-count'] ?? 0),
        lastError: headers['x-last-error'] as string | undefined,
      });
      ch.nack(msg, false, true);
    }
    return seen;
  }

  /** Pops the single oldest message off `queue` (permanently, acked) for the caller to republish
   * elsewhere — used by the admin "replay" action. */
  async popOldest(queue: string): Promise<{ routingKey: string; body: unknown } | undefined> {
    const msg = await this.consumeChannel.get(queue, { noAck: false });
    if (!msg) return undefined;
    const headers = msg.properties.headers ?? {};
    this.consumeChannel.ack(msg);
    return { routingKey: (headers['x-original-routing-key'] as string) ?? msg.fields.routingKey, body: JSON.parse(msg.content.toString('utf8')) };
  }
}
