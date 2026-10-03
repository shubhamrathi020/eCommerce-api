import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { ConsumeMessage } from 'amqplib';
import type { Money } from '@ecom/contracts';
import { formatMoney } from '@ecom/contracts';
import { MailService } from '../auth/mail.service';
import { RedisService } from '../cache/redis.service';
import { RabbitService } from './rabbit.service';

/** Attempt 1/2/3 wait 2s/8s/20s in the retry queue before coming back; the 4th failure goes to the DLQ. */
const RETRY_DELAYS_MS = [2_000, 8_000, 20_000];
const DEDUPE_TTL_SECONDS = 7 * 24 * 60 * 60;

interface OrderPlacedPayload {
  orderId: string;
  email: string;
  name: string;
  total: Money;
  itemCount: number;
  cod: boolean;
}
interface OrderStatusPayload {
  orderId: string;
  email: string;
  name: string;
  byStaff?: boolean;
}
interface PaymentPayload {
  orderId: string;
  email: string;
  name: string;
  amount: Money;
}
interface CartAbandonedPayload {
  email: string;
  name: string;
  itemCount: number;
}

/**
 * The one consumer of `<prefix>q.notifications` (BRD 23, MQ-04/MQ-07): turns an outbox event into an
 * email via the existing dev `MailService`. Swapping in a real provider (Postmark, SendGrid, SES, ...)
 * later is a change to `MailService` alone — this consumer, the outbox and the retry/DLQ plumbing around
 * it don't know or care that the current "provider" is an in-memory dev outbox, the same posture BRD 21
 * took with Razorpay (real integration code, a mock-friendly stand-in until real credentials exist).
 *
 * Idempotency (MQ-07): each event's own outbox-row id is used as the AMQP `messageId`, and a Redis
 * `SETNX` on that id is the dedupe check — a message redelivered after a crash between "send the mail"
 * and "ack" (or one replayed from the dead-letter queue after actually having succeeded once) is a no-op
 * the second time, not a second email.
 */
@Injectable()
export class NotificationConsumerService implements OnApplicationBootstrap {
  private readonly logger = new Logger('NotificationConsumer');

  constructor(
    private readonly rabbit: RabbitService,
    private readonly mail: MailService,
    private readonly redis: RedisService,
  ) {}

  // `onApplicationBootstrap`, not `onModuleInit`: Nest runs every provider's `onModuleInit` first and
  // only then starts calling `onApplicationBootstrap` on any of them, which is what actually guarantees
  // `RabbitService.onModuleInit` (declaring the topology this consumes) has finished before this runs —
  // provider registration order alone does not guarantee that for `onModuleInit` hooks specifically.
  async onApplicationBootstrap(): Promise<void> {
    await this.rabbit.consume(this.rabbit.notificationsQueue, 5, (msg) => this.handle(msg));
  }

  private async handle(msg: ConsumeMessage): Promise<void> {
    const messageId = msg.properties.messageId;
    if (messageId) {
      const isNew = await this.redis.raw.set(`dedupe:${messageId}`, '1', 'EX', DEDUPE_TTL_SECONDS, 'NX');
      if (!isNew) {
        this.rabbit.ack(msg);
        return;
      }
    }
    try {
      this.deliver(msg.fields.routingKey, JSON.parse(msg.content.toString('utf8')));
      this.rabbit.ack(msg);
    } catch (error) {
      await this.retryOrDeadLetter(msg, error as Error);
    }
  }

  private async retryOrDeadLetter(msg: ConsumeMessage, error: Error): Promise<void> {
    const retryCount = Number(msg.properties.headers?.['x-retry-count'] ?? 0);
    const routingKey = msg.fields.routingKey;
    const body = JSON.parse(msg.content.toString('utf8'));
    if (retryCount < RETRY_DELAYS_MS.length) {
      this.logger.warn(`${routingKey} failed (attempt ${retryCount + 1}): ${error.message}; retrying in ${RETRY_DELAYS_MS[retryCount]}ms`);
      await this.rabbit.publishToQueue(this.rabbit.retryQueue, routingKey, body, {
        headers: { 'x-retry-count': retryCount + 1, 'x-last-error': error.message.slice(0, 500) },
        expirationMs: RETRY_DELAYS_MS[retryCount],
      });
    } else {
      this.logger.error(`${routingKey} failed permanently after ${retryCount} retries: ${error.message}; moving to dead-letter queue`);
      await this.rabbit.publishToQueue(this.rabbit.dlq, routingKey, body, { headers: { 'x-retry-count': retryCount, 'x-last-error': error.message.slice(0, 500) } });
    }
    this.rabbit.ack(msg);
  }

  private deliver(routingKey: string, payload: unknown): void {
    switch (routingKey) {
      case 'order.placed': {
        const p = payload as OrderPlacedPayload;
        this.mail.send({
          to: p.email,
          subject: `Order confirmed: ${p.orderId}`,
          body: `Hi ${p.name}, we've received your order ${p.orderId} (${p.itemCount} item${p.itemCount === 1 ? '' : 's'}, ${formatMoney(p.total)})${p.cod ? ' to be paid on delivery' : ''}. We'll email you again once it ships.`,
          link: `/orders/${p.orderId}`,
        });
        return;
      }
      case 'order.cancelled': {
        const p = payload as OrderStatusPayload;
        this.mail.send({ to: p.email, subject: `Order cancelled: ${p.orderId}`, body: `Hi ${p.name}, your order ${p.orderId} has been cancelled${p.byStaff ? ' by our team' : ''}. Any payment taken will be refunded.`, link: `/orders/${p.orderId}` });
        return;
      }
      case 'order.expired': {
        const p = payload as OrderStatusPayload;
        this.mail.send({ to: p.email, subject: `Order cancelled: ${p.orderId}`, body: `Hi ${p.name}, we cancelled order ${p.orderId} because payment wasn't completed in time. No charge was made; please place it again if you'd still like it.`, link: `/orders/${p.orderId}` });
        return;
      }
      case 'payment.confirmed': {
        const p = payload as PaymentPayload;
        this.mail.send({ to: p.email, subject: `Payment received for order ${p.orderId}`, body: `Hi ${p.name}, we've received your payment of ${formatMoney(p.amount)} for order ${p.orderId}.`, link: `/orders/${p.orderId}` });
        return;
      }
      case 'payment.refunded': {
        const p = payload as PaymentPayload;
        this.mail.send({ to: p.email, subject: `Refund issued for order ${p.orderId}`, body: `Hi ${p.name}, we've issued a refund of ${formatMoney(p.amount)} for order ${p.orderId}. It should reach your original payment method within a few business days.`, link: `/orders/${p.orderId}` });
        return;
      }
      case 'cart.abandoned': {
        const p = payload as CartAbandonedPayload;
        this.mail.send({ to: p.email, subject: 'You left something in your cart', body: `Hi ${p.name}, you still have ${p.itemCount} item${p.itemCount === 1 ? '' : 's'} waiting in your cart. Come back and finish checking out whenever you're ready.`, link: '/cart' });
        return;
      }
      default:
        this.logger.warn(`no handler for routing key "${routingKey}"; dropping (acked)`);
    }
  }
}
