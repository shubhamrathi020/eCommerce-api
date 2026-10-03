import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { API_CONFIG, type ApiConfig } from '../config';
import { RedisService } from '../cache/redis.service';
import { OrderService } from '../commerce/order.service';
import { fromJson } from '../commerce/json';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxService } from './outbox.service';

const SWEEP_INTERVAL_MS = 30_000;
const ABANDONED_CART_CHECK_INTERVAL_MS = 5 * 60_000;

/**
 * Scheduled jobs (BRD 23, MQ-05), active instead of the lazy "run on the next request" pattern BRD 21/22
 * used. Each job is guarded by a Redis lock (`SET ... NX EX`) that's released right after the job finishes
 * (see `withLock`) — with several API replicas running the same interval, only whichever one wins the
 * lock for a given tick actually queries and writes; the rest see the `SET` fail and skip that tick. The
 * TTL is only a crash-safety net (an instance that dies mid-job doesn't wedge the lock until it expires),
 * not the normal release path. That's "runs once across multiple instances" (MQ-05's acceptance
 * criterion) without a separate cron pod or leader election.
 */
@Injectable()
export class SchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Scheduler');
  private sweepTimer?: ReturnType<typeof setInterval>;
  private abandonedTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly db: PrismaService,
    private readonly redis: RedisService,
    private readonly orders: OrderService,
    private readonly outbox: OutboxService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  onApplicationBootstrap(): void {
    this.sweepTimer = setInterval(() => {
      this.withLock('sweep-expired', 20, () => this.orders.sweepExpired()).catch((error) => this.logger.error(`reservation-expiry sweep failed: ${(error as Error).message}`));
    }, SWEEP_INTERVAL_MS);
    this.abandonedTimer = setInterval(() => {
      this.withLock('abandoned-cart', 60, () => this.remindAbandonedCarts()).catch((error) => this.logger.error(`abandoned-cart reminder failed: ${(error as Error).message}`));
    }, ABANDONED_CART_CHECK_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    clearInterval(this.sweepTimer);
    clearInterval(this.abandonedTimer);
  }

  private async withLock(name: string, crashSafetyTtlSeconds: number, job: () => Promise<void>): Promise<void> {
    const got = await this.redis.raw.set(`lock:${name}`, '1', 'EX', crashSafetyTtlSeconds, 'NX');
    if (!got) return;
    try {
      await job();
    } finally {
      await this.redis.raw.del(`lock:${name}`).catch(() => undefined);
    }
  }

  /** One reminder email per cart per "abandoned" episode (BRD 23, MQ-05): a signed-in customer's cart
   * that has sat untouched, non-empty, for `abandonedCartMinutes`, and hasn't already been reminded since
   * its last real change (`CartService.mutate` clears `reminderSentAt` on the next content change, not on
   * a plain read — see the model comment in schema.prisma). Guest carts are skipped: there's no email to
   * send to until checkout, by which point the cart isn't abandoned any more. */
  private async remindAbandonedCarts(): Promise<void> {
    const cutoff = new Date(Date.now() - this.config.abandonedCartMinutes * 60_000);
    const candidates = await this.db.cart.findMany({
      where: { updatedAt: { lt: cutoff }, reminderSentAt: null, ownerKey: { startsWith: 'user:' }, items: { not: [] } },
      take: 50,
    });
    for (const cart of candidates) {
      const userId = cart.ownerKey.slice('user:'.length);
      const user = await this.db.user.findUnique({ where: { id: userId } });
      if (!user) continue;
      const items = fromJson<Array<{ quantity: number }>>(cart.items);
      const itemCount = items.reduce((n, i) => n + i.quantity, 0);
      if (itemCount === 0) continue;
      await this.outbox.writeStandalone('cart.abandoned', { email: user.email, name: user.name, itemCount });
      await this.db.cart.update({ where: { id: cart.id }, data: { reminderSentAt: new Date() } });
    }
  }
}
