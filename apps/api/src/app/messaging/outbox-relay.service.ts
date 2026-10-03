import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { RedisService } from '../cache/redis.service';
import { PrismaService } from '../prisma/prisma.service';
import { RabbitService } from './rabbit.service';

const POLL_MS = 2_000;
const LOCK_TTL_SECONDS = 10;
const BATCH_SIZE = 20;

/**
 * Polls `outbox_events` for unpublished rows and publishes each to RabbitMQ (BRD 23, MQ-02). Guarded by
 * a Redis lock (`SET ... NX EX`), the same "only one instance actually does the work" pattern as
 * `SchedulerService` — with several API replicas running this relay, only whichever one holds the lock
 * for a given tick queries and publishes; the others skip that tick entirely. The lock is released right
 * after the tick's work finishes, not left to expire — `LOCK_TTL_SECONDS` is a crash-safety net (so a
 * replica that dies mid-tick doesn't wedge the lock forever), not the normal release path; releasing
 * early is what lets this same instance's *own* next tick, two seconds later, actually run instead of
 * being blocked by its own leftover lock for the rest of the TTL. If the broker is down, `publish()`
 * rejects, the row's `attempts`/`lastError` are recorded and `publishedAt` stays null, so the very next
 * tick (on whichever instance then holds the lock) tries the same row again — no event is ever silently
 * dropped, only delayed until the broker comes back.
 */
@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('OutboxRelay');
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly db: PrismaService,
    private readonly rabbit: RabbitService,
    private readonly redis: RedisService,
  ) {}

  // `onApplicationBootstrap` (see the same comment in `NotificationConsumerService`) so the first tick
  // can never race `RabbitService.onModuleInit` declaring the topology this relay publishes into.
  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      this.tick().catch((error) => this.logger.error(`tick failed: ${(error as Error).message}`));
    }, POLL_MS);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    const gotLock = await this.redis.raw.set('lock:outbox-relay', '1', 'EX', LOCK_TTL_SECONDS, 'NX');
    if (!gotLock) return;
    try {
      const rows = await this.db.outboxEvent.findMany({ where: { publishedAt: null }, orderBy: { createdAt: 'asc' }, take: BATCH_SIZE });
      for (const row of rows) {
        try {
          await this.rabbit.publish(row.routingKey, row.payload, { messageId: row.id });
          await this.db.outboxEvent.update({ where: { id: row.id }, data: { publishedAt: new Date(), attempts: row.attempts + 1 } });
        } catch (error) {
          await this.db.outboxEvent
            .update({ where: { id: row.id }, data: { attempts: row.attempts + 1, lastError: (error as Error).message.slice(0, 500) } })
            .catch(() => undefined);
          this.logger.warn(`publish failed for outbox event ${row.id} (${row.routingKey}): ${(error as Error).message}`);
        }
      }
    } finally {
      await this.redis.raw.del('lock:outbox-relay').catch(() => undefined);
    }
  }
}
