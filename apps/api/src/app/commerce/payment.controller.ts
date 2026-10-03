import { Body, Controller, Headers, HttpCode, Logger, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { Order, PaymentResult, PaymentSession } from '@ecom/contracts';
import { IsString } from 'class-validator';
import type { Request } from 'express';
import { CsrfGuard, OptionalAuthGuard, OptionalUser, type AuthUser } from '../common/auth';
import { PrismaService } from '../prisma/prisma.service';
import { readGuestCartToken } from './guest-cart-cookie';
import { InventoryService } from './inventory.service';
import { fromJson, toJson } from './json';
import { stockLinesOf } from './order.service';
import { PaymentService } from './payment.service';
import { RazorpayService } from './razorpay.service';

export class ConfirmPaymentDto implements PaymentResult {
  @IsString() providerPaymentId!: string;
  @IsString() providerOrderId!: string;
  @IsString() signature!: string;
}

export class FailPaymentDto {
  @IsString() reason!: string;
}

/** Payments (BRD 21, CM21-05), guest or signed in for the customer-facing endpoints, plus a webhook that
 * only Razorpay itself can call (verified by its own signature, no session at all). */
@ApiTags('payments')
@Controller()
export class PaymentController {
  private readonly logger = new Logger('RazorpayWebhook');

  constructor(
    private readonly payments: PaymentService,
    private readonly inventory: InventoryService,
    private readonly razorpay: RazorpayService,
    private readonly db: PrismaService,
  ) {}

  @Post('orders/:id/payment/initiate')
  @UseGuards(OptionalAuthGuard, CsrfGuard)
  initiate(@OptionalUser() user: AuthUser | undefined, @Req() req: Request, @Param('id') id: string): Promise<PaymentSession> {
    return this.payments.initiate(id, user ? { userId: user.id } : { guestToken: readGuestCartToken(req) ?? '' });
  }

  @Post('orders/:id/payment/confirm')
  @UseGuards(OptionalAuthGuard, CsrfGuard)
  confirm(@OptionalUser() user: AuthUser | undefined, @Req() req: Request, @Param('id') id: string, @Body() body: ConfirmPaymentDto): Promise<Order> {
    return this.payments.confirm(id, user ? { userId: user.id } : { guestToken: readGuestCartToken(req) ?? '' }, body);
  }

  @Post('orders/:id/payment/fail')
  @HttpCode(200)
  @UseGuards(OptionalAuthGuard, CsrfGuard)
  fail(@OptionalUser() user: AuthUser | undefined, @Req() req: Request, @Param('id') id: string, @Body() body: FailPaymentDto): Promise<Order> {
    return this.payments.fail(id, user ? { userId: user.id } : { guestToken: readGuestCartToken(req) ?? '' }, body.reason);
  }

  /** Razorpay calls this directly (Settings > Webhooks in the dashboard); it never goes through a
   * browser, so there is no cookie/bearer session and no CSRF concern — the webhook signature itself
   * (verified against the untouched raw body) is the only authentication. Kept idempotent: an event
   * already applied (order already paid/cancelled) is acknowledged again without re-applying it. */
  @Post('webhooks/razorpay')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async webhook(@Req() req: Request & { rawBody?: string }, @Headers('x-razorpay-signature') signature: string | undefined): Promise<{ ok: true }> {
    if (!signature || !req.rawBody || !this.razorpay.verifyWebhookSignature(req.rawBody, signature)) {
      this.logger.warn('Rejected a webhook call with a missing or invalid signature.');
      return { ok: true }; // 200 either way: never give an attacker a signal about what a valid signature looks like.
    }
    const event = JSON.parse(req.rawBody) as { event?: string; payload?: { payment?: { entity?: { id?: string; order_id?: string } } } };
    const payment = event.payload?.payment?.entity;
    if (!payment?.order_id) return { ok: true };
    const order = await this.db.order.findFirst({ where: { providerOrderId: payment.order_id } });
    if (!order) return { ok: true };

    if (event.event === 'payment.captured' && order.paymentStatus !== 'paid' && order.status === 'pending_payment') {
      const now = new Date().toISOString();
      const timeline = [...fromJson<{ status: string; label: string; at?: string }[]>(order.timeline), { status: 'paid', label: 'Payment received', at: now }, { status: 'confirmed', label: 'Order confirmed', at: now }];
      await this.db.order.update({ where: { id: order.id }, data: { status: 'confirmed', paymentStatus: 'paid', providerPaymentId: payment.id ?? null, timeline: toJson(timeline) } });
      this.logger.log(`Webhook confirmed payment for order ${order.id}`);
    } else if (event.event === 'payment.failed' && order.paymentStatus === 'pending') {
      await this.inventory.giveBack(stockLinesOf(order));
      await this.db.order.update({ where: { id: order.id }, data: { paymentStatus: 'failed' } });
      this.logger.log(`Webhook recorded a failed payment for order ${order.id}`);
    }
    return { ok: true };
  }
}
