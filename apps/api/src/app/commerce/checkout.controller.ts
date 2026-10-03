import { Controller, Get, Inject, Param, Req, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { PaymentOption, ShippingOption } from '@ecom/contracts';
import { EXPRESS_SHIPPING, codEligibility, computeServiceability, deliverabilityProblem, shippingFee } from '@ecom/contracts';
import type { Request, Response } from 'express';
import { AppError } from '../common/app-error';
import { OptionalAuthGuard, OptionalUser, type AuthUser } from '../common/auth';
import { API_CONFIG, type ApiConfig } from '../config';
import { CartService } from './cart.service';
import { ensureGuestCartToken, ownerKeyFor } from './guest-cart-cookie';

const DAY_MS = 86_400_000;

function assertDeliverable(pincode: string): void {
  const problem = deliverabilityProblem(pincode, (p) => computeServiceability(p).serviceable);
  if (problem === 'invalid') throw new AppError('validation', 'Enter a valid 6-digit pin code', { pincode: 'Invalid pin code' });
  if (problem === 'not_deliverable') throw new AppError('validation', 'Sorry, we do not deliver to this pin code yet.', { pincode: 'Not deliverable' });
}

/** Delivery and payment choices for the current cart (BF-.../CM21-01 support), guest or signed in. */
@ApiTags('checkout')
@Controller('checkout')
@UseGuards(OptionalAuthGuard)
export class CheckoutController {
  constructor(
    private readonly cart: CartService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get('shipping-options/:pincode')
  async shippingOptions(
    @OptionalUser() user: AuthUser | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('pincode') pincode: string,
  ): Promise<ShippingOption[]> {
    assertDeliverable(pincode);
    const cart = await this.cart.get(ownerKeyFor(user?.id, ensureGuestCartToken(req, res, this.config.production)));
    const base = computeServiceability(pincode);
    const afterDiscount = cart.totals.subtotal.amount - cart.totals.couponDiscount.amount;
    const free = cart.coupon?.freeShipping ?? false;
    const standardDays = base.estimatedDays ?? 3;
    const expressDays = Math.max(1, standardDays - 2);
    const on = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString();
    return [
      { id: 'standard', label: 'Standard delivery', price: { amount: shippingFee('standard', afterDiscount, free), currency: 'INR' }, estimatedDays: standardDays, estimatedDate: on(standardDays) },
      { id: 'express', label: 'Express delivery', price: { amount: free ? 0 : EXPRESS_SHIPPING, currency: 'INR' }, estimatedDays: expressDays, estimatedDate: on(expressDays) },
    ];
  }

  @Get('payment-options/:pincode')
  async paymentOptions(
    @OptionalUser() user: AuthUser | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('pincode') pincode: string,
  ): Promise<PaymentOption[]> {
    assertDeliverable(pincode);
    const cart = await this.cart.get(ownerKeyFor(user?.id, ensureGuestCartToken(req, res, this.config.production)));
    const cod = codEligibility(pincode, cart.totals.total.amount);
    return [
      { method: 'razorpay', label: 'Pay online (UPI, cards, net banking, wallets)', enabled: true },
      { method: 'cod', label: 'Cash on delivery', enabled: cod.enabled, ...(cod.reason ? { reason: cod.reason } : {}) },
    ];
  }
}
