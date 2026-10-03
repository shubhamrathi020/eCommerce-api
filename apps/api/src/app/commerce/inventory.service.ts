import { Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error';
import { CacheService } from '../cache/cache.service';
import { MongoService } from '../catalog/mongo.service';

export interface StockLine {
  variantId: string;
  quantity: number;
}

/**
 * Atomic stock movement directly on the catalog store (BRD 21, CM21-04). There is no separate reservation
 * ledger (BRD 11's mock feature) here — a variant's `stock` field in Mongo is the one source of truth,
 * the same simplification BRD 20 already made for the catalog itself.
 *
 * Each line is decremented with `findOneAndUpdate({ ..., stock: { $gte: quantity } }, { $inc: ... })`,
 * which MongoDB guarantees is atomic per document: two concurrent shoppers can never both take the last
 * unit. Multiple lines in one order are not atomic as a *group* (standalone MongoDB, as run here, does
 * not support multi-document transactions — that needs a replica set) — if a later line fails, the
 * earlier ones in the same order are rolled back with compensating increments, so the process still
 * never oversells, only very rarely (a genuine race between two orders on different lines of a
 * multi-item order) does a customer see "some items are no longer available" instead of a clean
 * decrement. Documented as a scoped-down simplification, not a silent gap.
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly mongo: MongoService,
    private readonly cache: CacheService,
  ) {}

  /** Atomically takes `quantity` units of one variant; throws if not enough is left. The `$` in the
   * update refers to the array element matched by `$elemMatch` in the filter — the query itself can't
   * reference `variants.$.stock` (the positional operator only exists in the update document), so the
   * "enough stock" condition has to live inside `$elemMatch` alongside the id, not as a sibling filter. */
  private async takeOne(line: StockLine): Promise<void> {
    const result = await this.mongo.products.updateOne(
      { variants: { $elemMatch: { id: line.variantId, stock: { $gte: line.quantity } } } },
      { $inc: { 'variants.$.stock': -line.quantity } },
    );
    if (result.matchedCount === 0) throw new AppError('validation', 'Some items in your cart are no longer available.');
    await this.invalidateCaches(line.variantId);
  }

  private async giveBackOne(line: StockLine): Promise<void> {
    await this.mongo.products.updateOne({ 'variants.id': line.variantId }, { $inc: { 'variants.$.stock': line.quantity } });
    await this.invalidateCaches(line.variantId);
  }

  /** An order moving stock is exactly as much a catalog write as an admin edit is (BRD 22, CR-01): the
   * cached product page and every cached listing can now show a stale stock status/quick-add button if
   * this isn't invalidated too, not just `AdminCatalogService`'s own writes. */
  private async invalidateCaches(variantId: string): Promise<void> {
    await Promise.all([this.cache.invalidateTag(`variant:${variantId}`), this.cache.invalidateTag('catalog:listings')]);
  }

  /** Decrements every line, or none: rolls back whatever already succeeded if a later line fails. */
  async take(lines: StockLine[]): Promise<void> {
    const taken: StockLine[] = [];
    try {
      for (const line of lines) {
        await this.takeOne(line);
        taken.push(line);
      }
    } catch (error) {
      await Promise.all(taken.map((line) => this.giveBackOne(line).catch(() => undefined)));
      throw error;
    }
  }

  /** Returns stock, e.g. on cancellation or a payment-window timeout. Never fails on a partial list. */
  async giveBack(lines: StockLine[]): Promise<void> {
    await Promise.all(lines.map((line) => this.giveBackOne(line)));
  }
}
