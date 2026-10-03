import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { AdminOrderDetail, AdminOrderQuery, AdminOrderRow, CartLine, OrderNote, OrderStatus, TimelineEntry } from '@ecom/contracts';
import { ORDER_TRANSITIONS } from '@ecom/contracts';
import type { Prisma } from '../../../generated/prisma';
import { AppError } from '../common/app-error';
import { CouponRedemptionService } from '../cache/coupon-redemption.service';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from './inventory.service';
import { fromJson, toJson } from './json';
import { OrderService, stockLinesOf } from './order.service';
import { RazorpayService } from './razorpay.service';
import { OutboxService } from '../messaging/outbox.service';
import { OrderEventsService } from '../messaging/order-events.service';

const STATUS_LABEL: Partial<Record<OrderStatus, string>> = { packed: 'Packed', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Order cancelled' };

/** Back-office order management (BRD 06's `AdminOrderApi`, now against real orders — BRD 21, CM21-09).
 * Reuses `ORDER_TRANSITIONS`, the exact same state machine the customer-facing cancel already enforces. */
@Injectable()
export class AdminOrderService {
  constructor(
    private readonly db: PrismaService,
    private readonly orders: OrderService,
    private readonly inventory: InventoryService,
    private readonly razorpay: RazorpayService,
    private readonly coupons: CouponRedemptionService,
    private readonly outbox: OutboxService,
    private readonly orderEvents: OrderEventsService,
  ) {}

  async list(query: AdminOrderQuery): Promise<{ items: AdminOrderRow[]; total: number; page: number; pageSize: number }> {
    const where: Prisma.OrderWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.paymentMethod) where.paymentMethod = query.paymentMethod;
    if (query.from || query.to) where.createdAt = { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lte: new Date(`${query.to}T23:59:59.999Z`) } : {}) };
    if (query.q?.trim()) {
      const q = query.q.trim();
      where.OR = [{ id: { contains: q, mode: 'insensitive' } }, { contactName: { contains: q, mode: 'insensitive' } }, { contactEmail: { contains: q, mode: 'insensitive' } }];
    }
    const pageSize = Math.max(1, query.pageSize);
    const total = await this.db.order.count({ where });
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(1, query.page), pages);
    const rows = await this.db.order.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize });
    const items: AdminOrderRow[] = rows.map((r) => {
      const lines = fromJson<CartLine[]>(r.lines);
      return {
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        customerName: r.contactName,
        itemCount: lines.reduce((n, l) => n + l.quantity, 0),
        total: fromJson<{ total: { amount: number; currency: 'INR' } }>(r.totals).total,
        status: r.status as OrderStatus,
        paymentStatus: r.paymentStatus as AdminOrderRow['paymentStatus'],
        paymentMethod: r.paymentMethod as AdminOrderRow['paymentMethod'],
      };
    });
    return { items, total, page, pageSize };
  }

  async get(id: string): Promise<AdminOrderDetail> {
    const row = await this.db.order.findUnique({ where: { id } });
    if (!row) throw new AppError('not_found', 'Order not found');
    const order = this.orders.toContract(row);
    return { ...order, notes: fromJson<OrderNote[]>(row.notes), allowedNext: ORDER_TRANSITIONS[order.status] };
  }

  async advance(id: string, status: OrderStatus, actor: string): Promise<AdminOrderDetail> {
    const row = await this.db.order.findUnique({ where: { id } });
    if (!row) throw new AppError('not_found', 'Order not found');
    const current = row.status as OrderStatus;
    if (!ORDER_TRANSITIONS[current].includes(status)) throw new AppError('validation', `An order that is ${current.replace('_', ' ')} cannot move to ${status.replace('_', ' ')}.`);

    if (status === 'cancelled') {
      await this.inventory.giveBack(stockLinesOf(row));
      if (row.couponCode) await this.coupons.release(row.couponCode);
      // A real refund, automatically, when this was a captured online payment and Razorpay keys are
      // configured; otherwise (COD, or no keys yet) the order is left `refund_pending` for a manual refund,
      // same as before — CM21-05/CM21-07's reconciliation job is not built yet (documented gap).
      let paymentStatus = row.paymentStatus;
      if (row.paymentStatus === 'paid') {
        paymentStatus = 'refund_pending';
        if (this.razorpay.enabled && row.providerPaymentId) {
          // Best-effort: a refund failure should not block the cancellation itself from recording.
          void this.attemptRefund(row.id, row.providerPaymentId, fromJson<{ total: { amount: number } }>(row.totals).total.amount);
        }
      }
      const timeline = [...fromJson<TimelineEntry[]>(row.timeline).filter((t) => t.status === 'placed' || t.status === 'paid' || t.status === 'confirmed'), { status: 'cancelled' as const, label: `${STATUS_LABEL[status]} (by staff)`, at: new Date().toISOString() }];
      await this.db.$transaction(async (tx) => {
        await tx.order.update({ where: { id }, data: { status, paymentStatus, timeline: toJson(timeline) } });
        await this.outbox.write(tx, 'order.cancelled', { orderId: id, email: row.contactEmail, name: row.contactName, byStaff: true });
      });
    } else {
      const timeline = [...fromJson<TimelineEntry[]>(row.timeline), { status, label: STATUS_LABEL[status] ?? status, at: new Date().toISOString() }];
      await this.db.order.update({ where: { id }, data: { status, timeline: toJson(timeline) } });
    }
    await this.addNoteInternal(id, actor, `Status changed to ${status.replace('_', ' ')}.`);
    const updatedRow = await this.db.order.findUniqueOrThrow({ where: { id } });
    await this.orderEvents.publish(this.orders.toContract(updatedRow));
    return this.get(id);
  }

  /** Records the refund; does not fail the caller if Razorpay is briefly unreachable — worth a note either way. */
  private async attemptRefund(orderId: string, providerPaymentId: string, amount: number): Promise<void> {
    try {
      await this.razorpay.refund(providerPaymentId, amount);
      await this.addNoteInternal(orderId, 'system', 'Refund issued via Razorpay.');
      const row = await this.db.order.findUnique({ where: { id: orderId } });
      if (row) await this.outbox.writeStandalone('payment.refunded', { orderId, email: row.contactEmail, name: row.contactName, amount: { amount, currency: 'INR' } });
    } catch (error) {
      await this.addNoteInternal(orderId, 'system', `Automatic refund failed (${error instanceof Error ? error.message : 'unknown error'}); refund it manually in the Razorpay dashboard.`);
    }
  }

  async addNote(id: string, actor: string, text: string): Promise<AdminOrderDetail> {
    if (!(await this.db.order.findUnique({ where: { id } }))) throw new AppError('not_found', 'Order not found');
    await this.addNoteInternal(id, actor, text);
    return this.get(id);
  }

  private async addNoteInternal(id: string, actor: string, text: string): Promise<void> {
    const row = await this.db.order.findUnique({ where: { id } });
    if (!row) return;
    const note: OrderNote = { id: `note_${Date.now().toString(36)}${randomBytes(2).toString('hex')}`, at: new Date().toISOString(), author: actor, text };
    await this.db.order.update({ where: { id }, data: { notes: toJson([note, ...fromJson<OrderNote[]>(row.notes)]) } });
  }
}
