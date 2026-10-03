import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Cart, ShippingMethodId } from '@ecom/contracts';
import { IsIn, IsInt, IsString, Min } from 'class-validator';
import type { Request, Response } from 'express';
import { CsrfGuard, OptionalAuthGuard, OptionalUser, type AuthUser } from '../common/auth';
import { API_CONFIG, type ApiConfig } from '../config';
import { RateLimitBucket } from '../cache/rate-limit.guard';
import { CartService } from './cart.service';
import { ensureGuestCartToken, ownerKeyFor } from './guest-cart-cookie';

const SHIPPING_METHODS: ShippingMethodId[] = ['standard', 'express'];

export class AddToCartDto {
  @IsString() variantId!: string;
  @IsInt() @Min(1) quantity!: number;
}

export class SetQuantityDto {
  @IsInt() @Min(0) quantity!: number;
}

export class ApplyCouponDto {
  @IsString() code!: string;
}

export class SetShippingDto {
  @IsIn(SHIPPING_METHODS) method!: ShippingMethodId;
}

/** Server-side cart (BF-01 / BRD 21 CM21-01): works both signed in (bearer token) and as a guest (a
 * long-lived, non-sensitive cookie identifies the cart) — `OptionalAuthGuard` never refuses the request
 * either way. Mutations additionally need the CSRF header (`CsrfGuard`), same defense-in-depth as the
 * auth module's cookie-authenticated endpoints, since the guest cart cookie is a cookie too. */
@ApiTags('cart')
@Controller('cart')
@UseGuards(OptionalAuthGuard)
export class CartController {
  constructor(
    private readonly cart: CartService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  private owner(user: AuthUser | undefined, req: Request, res: Response): string {
    return ownerKeyFor(user?.id, ensureGuestCartToken(req, res, this.config.production));
  }

  @Get()
  get(@OptionalUser() user: AuthUser | undefined, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<Cart> {
    return this.cart.get(this.owner(user, req, res));
  }

  @Post('items')
  @UseGuards(CsrfGuard)
  add(@OptionalUser() user: AuthUser | undefined, @Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: AddToCartDto): Promise<Cart> {
    return this.cart.add(this.owner(user, req, res), body.variantId, body.quantity);
  }

  @Put('items/:variantId')
  @UseGuards(CsrfGuard)
  setQuantity(
    @OptionalUser() user: AuthUser | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: SetQuantityDto,
    @Param('variantId') variantId: string,
  ): Promise<Cart> {
    return this.cart.setQuantity(this.owner(user, req, res), variantId, body.quantity);
  }

  @Delete('items/:variantId')
  @UseGuards(CsrfGuard)
  remove(@OptionalUser() user: AuthUser | undefined, @Req() req: Request, @Res({ passthrough: true }) res: Response, @Param('variantId') variantId: string): Promise<Cart> {
    return this.cart.remove(this.owner(user, req, res), variantId);
  }

  @Post('coupon')
  @UseGuards(CsrfGuard)
  @RateLimitBucket('coupon')
  applyCoupon(@OptionalUser() user: AuthUser | undefined, @Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: ApplyCouponDto): Promise<Cart> {
    return this.cart.applyCoupon(this.owner(user, req, res), body.code);
  }

  @Delete('coupon')
  @UseGuards(CsrfGuard)
  removeCoupon(@OptionalUser() user: AuthUser | undefined, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<Cart> {
    return this.cart.removeCoupon(this.owner(user, req, res));
  }

  @Put('shipping-method')
  @UseGuards(CsrfGuard)
  setShippingMethod(@OptionalUser() user: AuthUser | undefined, @Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: SetShippingDto): Promise<Cart> {
    return this.cart.setShippingMethod(this.owner(user, req, res), body.method);
  }

  @Delete()
  @UseGuards(CsrfGuard)
  clear(@OptionalUser() user: AuthUser | undefined, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<Cart> {
    return this.cart.clear(this.owner(user, req, res));
  }
}
