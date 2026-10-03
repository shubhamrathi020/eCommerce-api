import { Injectable } from '@nestjs/common';
import type { Cart, Product, ShippingMethodId } from '@ecom/contracts';
import { EMPTY_STORED_CART, MAX_LINE_QUANTITY, type PricedCart, type StoredCart, evaluateCoupon, priceCart } from '@ecom/contracts';
import { MongoService } from '../catalog/mongo.service';
import { AppError } from '../common/app-error';
import { PrismaService } from '../prisma/prisma.service';
import { fromJson, toJson } from './json';

/** Server-side cart (BRD 21, CM21-01): one row per owner ("user:<id>" or "guest:<token>"), priced fresh
 * from the real catalog on every read — the client never computes money, same rule as the mock. */
@Injectable()
export class CartService {
  constructor(
    private readonly db: PrismaService,
    private readonly mongo: MongoService,
  ) {}

  private async products(): Promise<Product[]> {
    const docs = await this.mongo.products.find({ status: 'published' }).toArray();
    return docs.map(({ _id, status, updatedAt, ...rest }) => rest);
  }

  private async readRow(ownerKey: string): Promise<StoredCart> {
    const row = await this.db.cart.findUnique({ where: { ownerKey } });
    if (!row) return { ...EMPTY_STORED_CART, items: [] };
    return { items: fromJson<StoredCart['items']>(row.items), shippingMethod: row.shippingMethod as ShippingMethodId, ...(row.couponCode ? { couponCode: row.couponCode } : {}) };
  }

  private async writeRow(ownerKey: string, stored: StoredCart, resetReminder = false): Promise<void> {
    const data = { items: toJson(stored.items), shippingMethod: stored.shippingMethod, couponCode: stored.couponCode ?? null, ...(resetReminder ? { reminderSentAt: null } : {}) };
    await this.db.cart.upsert({ where: { ownerKey }, create: { ownerKey, ...data }, update: data });
  }

  async priced(ownerKey: string): Promise<PricedCart> {
    const products = await this.products();
    const result = priceCart(await this.readRow(ownerKey), products, Date.now());
    await this.writeRow(ownerKey, result.stored);
    return result;
  }

  /** Applies `change`, then re-prices (acknowledging current prices, same as the mock's `mutate`). */
  private async mutate(ownerKey: string, change: (stored: StoredCart, products: Product[]) => StoredCart): Promise<PricedCart> {
    const products = await this.products();
    const stored = await this.readRow(ownerKey);
    const next = change(stored, products);
    const acknowledged: StoredCart = {
      ...next,
      items: next.items.map((item) => {
        const variant = products.flatMap((p) => p.variants).find((v) => v.id === item.variantId);
        return variant ? { ...item, seenPrice: variant.price.amount } : item;
      }),
    };
    const result = priceCart(acknowledged, products, Date.now());
    // A real content change (add/remove/quantity/coupon/shipping) means this cart is being actively used
    // right now, not sitting abandoned — clear any pending reminder flag so a later re-abandonment can
    // still send one more (BRD 23, MQ-05). A plain re-price on read (`priced()`) does not call this.
    await this.writeRow(ownerKey, result.stored, true);
    return result;
  }

  async get(ownerKey: string): Promise<Cart> {
    return (await this.priced(ownerKey)).cart;
  }

  async add(ownerKey: string, variantId: string, quantity: number): Promise<Cart> {
    const result = await this.mutate(ownerKey, (stored, products) => {
      const variant = products.flatMap((p) => p.variants).find((v) => v.id === variantId);
      if (!variant) throw new AppError('not_found', 'This product is no longer available.');
      if (variant.stock === 0 && !variant.backorder) throw new AppError('validation', 'Sorry, this item is out of stock.');
      const existing = stored.items.find((i) => i.variantId === variantId);
      const max = variant.backorder ? MAX_LINE_QUANTITY : Math.min(MAX_LINE_QUANTITY, variant.stock);
      if (existing && existing.quantity >= max) throw new AppError('validation', `You already have the maximum quantity (${max}) of this item.`);
      const items = existing
        ? stored.items.map((i) => (i.variantId === variantId ? { ...i, quantity: Math.min(max, i.quantity + quantity) } : i))
        : [...stored.items, { variantId, quantity: Math.min(max, Math.max(1, quantity)), seenPrice: variant.price.amount }];
      return { ...stored, items };
    });
    return result.cart;
  }

  async setQuantity(ownerKey: string, variantId: string, quantity: number): Promise<Cart> {
    const result = await this.mutate(ownerKey, (stored) => ({
      ...stored,
      items: quantity <= 0 ? stored.items.filter((i) => i.variantId !== variantId) : stored.items.map((i) => (i.variantId === variantId ? { ...i, quantity: Math.min(quantity, MAX_LINE_QUANTITY) } : i)),
    }));
    return result.cart;
  }

  remove(ownerKey: string, variantId: string): Promise<Cart> {
    return this.setQuantity(ownerKey, variantId, 0);
  }

  async applyCoupon(ownerKey: string, code: string): Promise<Cart> {
    const current = await this.priced(ownerKey);
    const evaluated = evaluateCoupon(code, current.cart.totals.subtotal.amount, Date.now());
    if (!evaluated.ok) throw new AppError('validation', evaluated.message, { code: evaluated.message });
    const result = await this.mutate(ownerKey, (stored) => ({ ...stored, couponCode: evaluated.coupon.code }));
    return result.cart;
  }

  async removeCoupon(ownerKey: string): Promise<Cart> {
    const result = await this.mutate(ownerKey, ({ couponCode: _removed, ...rest }) => rest);
    return result.cart;
  }

  async setShippingMethod(ownerKey: string, method: ShippingMethodId): Promise<Cart> {
    const result = await this.mutate(ownerKey, (stored) => ({ ...stored, shippingMethod: method }));
    return result.cart;
  }

  async clear(ownerKey: string): Promise<Cart> {
    const result = await this.mutate(ownerKey, (stored) => ({ items: [], shippingMethod: stored.shippingMethod }));
    return result.cart;
  }

  /** Called right after a successful login/register: moves the guest cart's items into the account's
   * cart (quantities add up, capped) and empties the guest cart — the server-side version of the mock's
   * `MockCartState.mergeGuestIntoUser`. No-op when there was no guest cart cookie or it was empty. */
  async mergeGuestIntoUser(guestOwnerKey: string | undefined, userId: string): Promise<void> {
    if (!guestOwnerKey) return;
    const guest = await this.readRow(guestOwnerKey);
    if (guest.items.length === 0) return;
    const userKey = `user:${userId}`;
    const mine = await this.readRow(userKey);
    const items = mine.items.map((i) => ({ ...i }));
    for (const g of guest.items) {
      const existing = items.find((i) => i.variantId === g.variantId);
      if (existing) existing.quantity = Math.min(MAX_LINE_QUANTITY, existing.quantity + g.quantity);
      else items.push({ ...g });
    }
    await this.writeRow(userKey, { ...mine, items });
    await this.db.cart.delete({ where: { ownerKey: guestOwnerKey } }).catch(() => undefined);
  }

  /** Empties a cart outright (used after an order is placed/paid). */
  async replaceWithEmpty(ownerKey: string, shippingMethod: ShippingMethodId): Promise<void> {
    await this.writeRow(ownerKey, { items: [], shippingMethod });
  }
}
