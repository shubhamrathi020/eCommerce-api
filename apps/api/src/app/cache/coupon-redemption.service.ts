import { Injectable } from '@nestjs/common';
import { RedisService } from './redis.service';

/** Coupons with a hard cap on total redemptions, demonstrating the distributed-counter mechanism CR-05
 * asks for (BRD 22). No coupon in `@ecom/contracts`'s `COUPONS` list has an admin-configurable
 * "maximum redemptions" field yet — that is a product decision (should every coupon get one? is it
 * admin-editable?) for whoever owns the coupon feature, not something to invent unilaterally here. This
 * demonstrates the real, working infrastructure on one coupon; extending it to more (or making the cap
 * admin-editable) is a small follow-up once that decision is made. */
const CAPPED_COUPONS: Record<string, number> = { WELCOME10: 500 };

/** Atomic Redis counter, so redemptions across concurrent checkouts (or, later, multiple API instances)
 * can never exceed the cap — the same "guard the check-and-increment as one atomic step" idea as
 * `InventoryService`'s stock decrement, just backed by Redis's `INCR` instead of a Mongo document. */
@Injectable()
export class CouponRedemptionService {
  constructor(private readonly redis: RedisService) {}

  private key(code: string): string {
    return `coupon:redemptions:${code.toUpperCase()}`;
  }

  capFor(code: string): number | undefined {
    return CAPPED_COUPONS[code.toUpperCase()];
  }

  /** Atomically claims one redemption slot; returns whether it was available. Never exceeds the cap even
   * under concurrent calls: `INCR` is atomic, and this only accepts the result if it's still within cap
   * (the one caller that pushes the counter over it gives its slot straight back). */
  async tryClaim(code: string): Promise<boolean> {
    const cap = this.capFor(code);
    if (cap === undefined) return true;
    const count = await this.redis.raw.incr(this.key(code));
    if (count > cap) {
      await this.redis.raw.decr(this.key(code));
      return false;
    }
    return true;
  }

  /** Releases a claimed slot (an order using this coupon was cancelled). */
  async release(code: string): Promise<void> {
    if (this.capFor(code) === undefined) return;
    await this.redis.raw.decr(this.key(code));
  }

  async redemptionCount(code: string): Promise<number> {
    const raw = await this.redis.raw.get(this.key(code));
    return raw ? Number(raw) : 0;
  }
}
