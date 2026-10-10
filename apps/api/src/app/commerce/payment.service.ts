import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { CartTotals, Order, OrderNote, PaymentResult, PaymentSession, ShippingMethodId, TimelineEntry } from '@ecom/contracts';
import type { Order as OrderRow } from '../../../generated/prisma';
import { API_CONFIG, type ApiConfig } from '../config';
import { AppError } from '../common/app-error';
import { PrismaService } from '../prisma/prisma.service';
import { CartService } from './cart.service';
import { InventoryService } from './inventory.service';
import { fromJson, toJson } from './json';
import { OrderService, type OwnerContext, PAYMENT_WINDOW_MINUTES, stockLinesOf } from './order.service';
import { ownerKeyFor } from './guest-cart-cookie';
import { RazorpayService } from './razorpay.service';
import { OutboxService } from '../messaging/outbox.service';
import { OrderEventsService } from '../messaging/order-events.service';

/** Payments (BRD 21, CM21-05): initiate creates the Razorpay order the checkout widget needs; confirm
 * verifies the signature server-side before an order is ever marked paid — the amount always comes from
 * the order the server already priced, never from anything the client sends. */
@Injectable()
export class PaymentService {
  constructor(
    private readonly db: PrismaService,
    private readonly orders: OrderService,
    private readonly cart: CartService,
    private readonly inventory: InventoryService,
    private readonly razorpay: RazorpayService,
    private readonly outbox: OutboxService,
    private readonly orderEvents: OrderEventsService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  async initiate(orderId: string, owner: OwnerContext): Promise<PaymentSession> {
    await this.orders.sweepExpired();
    let row = await this.orders.getRowForOwner(orderId, owner);
    if (row.status !== 'pending_payment') throw new AppError('validation', 'This order does not need a payment.');
    if (row.paymentStatus === 'failed') {
      // A previous attempt released the stock hold; reclaim it before letting them try again.
      await this.inventory.take(stockLinesOf(row));
      row = await this.db.order.update({
        where: { id: orderId },
        data: { paymentStatus: 'pending', paymentDeadline: new Date(Date.now() + PAYMENT_WINDOW_MINUTES * 60_000) },
      });
    }
    const amount = fromJson<CartTotals>(row.totals).total.amount;
    const provider = await this.razorpay.createOrder(amount, row.id);
    await this.db.order.update({ where: { id: orderId }, data: { providerOrderId: provider.id } });
    return { orderId, providerOrderId: provider.id, keyId: this.config.razorpayKeyId, amount, currency: 'INR' };
  }

  async confirm(orderId: string, owner: OwnerContext, result: PaymentResult): Promise<Order> {
    await this.orders.sweepExpired();
    const row = await this.orders.getRowForOwner(orderId, owner);
    if (row.paymentStatus === 'paid') return this.orders.toContract(row);
    if (row.status === 'cancelled') throw new AppError('validation', 'The payment window for this order expired and its items were released. Please place the order again.');
    if (row.status !== 'pending_payment') throw new AppError('validation', 'This order can no longer be paid.');
    const valid = result.providerOrderId === row.providerOrderId && this.razorpay.verifyPaymentSignature(result.providerOrderId, result.providerPaymentId, result.signature);
    if (!valid) throw new AppError('validation', 'Payment verification failed. If money was deducted it will be refunded.');
    const contract = await this.markPaid(row, result.providerPaymentId);
    await this.cart.replaceWithEmpty(ownerKeyFor(owner.userId, owner.guestToken ?? ''), row.shippingMethod as ShippingMethodId);
    return contract;
  }

  /**
   * Razorpay's webhook: the safety net for a payment the browser never reported (closed tab, lost connection, a UPI request
   * approved later). Only a captured payment changes anything. Razorpay sends `payment.failed` for every failed attempt, also
   * while its window is still open and the shopper tries another method, so a failure here must not give the stock back (the
   * browser reports a real give-up through `fail`, and the payment-deadline sweep releases an abandoned order).
   */
  async applyWebhook(event: string, providerOrderId: string, providerPaymentId: string): Promise<void> {
    if (event !== 'payment.captured') return;
    const row = await this.db.order.findFirst({ where: { providerOrderId } });
    if (!row || row.paymentStatus === 'paid' || row.status !== 'pending_payment') return;
    let shortfall: OrderNote | undefined;
    if (row.paymentStatus === 'failed') {
      // The browser reported a failure, which released the stock hold, before this payment was captured: take it again.
      try {
        await this.inventory.take(stockLinesOf(row));
      } catch {
        // The money is taken, so the order is confirmed anyway; staff see why it may not be shippable.
        shortfall = systemNote('Paid after its stock hold was released, and the items could not be reserved again. Check stock before shipping, or cancel and refund.');
      }
    }
    await this.markPaid(row, providerPaymentId, shortfall);
  }

  /** Marks an order paid and confirmed once, however many times the browser and the webhook report the same payment. */
  private async markPaid(row: OrderRow, providerPaymentId: string, note?: OrderNote): Promise<Order> {
    const now = new Date().toISOString();
    const timeline: TimelineEntry[] = [...fromJson<TimelineEntry[]>(row.timeline), { status: 'paid', label: 'Payment received', at: now }, { status: 'confirmed', label: 'Order confirmed', at: now }];
    const notes = note ? [note, ...fromJson<OrderNote[]>(row.notes)] : undefined;
    const { changed, updated } = await this.db.$transaction(async (tx) => {
      const { count } = await tx.order.updateMany({
        where: { id: row.id, paymentStatus: { not: 'paid' } },
        data: { status: 'confirmed', paymentStatus: 'paid', providerPaymentId, timeline: toJson(timeline), ...(notes ? { notes: toJson(notes) } : {}) },
      });
      if (count === 1) await this.outbox.write(tx, 'payment.confirmed', { orderId: row.id, email: row.contactEmail, name: row.contactName, amount: fromJson<CartTotals>(row.totals).total });
      return { changed: count === 1, updated: await tx.order.findUniqueOrThrow({ where: { id: row.id } }) };
    });
    const contract = this.orders.toContract(updated);
    if (changed) await this.orderEvents.publish(contract);
    return contract;
  }

  async fail(orderId: string, owner: OwnerContext, reason: string): Promise<Order> {
    const row = await this.orders.getRowForOwner(orderId, owner);
    if (row.paymentStatus === 'paid') return this.orders.toContract(row);
    // A failed payment gives its stock back; a retry (via initiate) claims it again.
    await this.inventory.giveBack(stockLinesOf(row));
    const note = systemNote(`Payment attempt failed: ${reason}`);
    const updated = await this.db.order.update({ where: { id: orderId }, data: { paymentStatus: 'failed', notes: toJson([note, ...fromJson<OrderNote[]>(row.notes)]) } });
    return this.orders.toContract(updated);
  }
}

function systemNote(text: string): OrderNote {
  return { id: `note_${Date.now().toString(36)}${randomBytes(2).toString('hex')}`, at: new Date().toISOString(), author: 'system', text };
}
