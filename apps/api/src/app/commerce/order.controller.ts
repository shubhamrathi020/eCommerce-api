import { Body, Controller, Get, HttpCode, Inject, Injectable, Param, Post, Req, Res, Sse, UseGuards } from '@nestjs/common';
import type { CanActivate, ExecutionContext, MessageEvent } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Order, PlaceOrderRequest } from '@ecom/contracts';
import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import { CsrfGuard, OptionalAuthGuard, type AuthUser, type AuthedRequest, OptionalUser } from '../common/auth';
import { API_CONFIG, type ApiConfig } from '../config';
import { RateLimitBucket } from '../cache/rate-limit.guard';
import { ensureGuestCartToken, ownerKeyFor, readGuestCartToken } from './guest-cart-cookie';
import { OrderEventsService } from '../messaging/order-events.service';
import { OrderService, type OwnerContext } from './order.service';

/**
 * Checks order ownership as a Guard, not inside the `@Sse()` handler itself. This matters specifically
 * for SSE: Nest resolves an `@Sse()` method's returned `Observable` and starts piping a 200 response to
 * the client *before* that Observable is actually subscribed (i.e. before this route's own body runs) —
 * an error thrown from inside the handler after that point becomes an in-stream `{type:'error'}` SSE
 * message, not an HTTP 4xx. A `CanActivate` guard runs before any of that and rejects the normal way. */
@Injectable()
export class OrderStreamOwnershipGuard implements CanActivate {
  constructor(private readonly orders: OrderService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const owner = req.user ? { userId: req.user.id } : { guestToken: readGuestCartToken(req) ?? '' };
    await this.orders.get(req.params['id'], owner); // throws AppError('not_found') for a non-owner, same as GET /orders/:id
    return true;
  }
}

export class ContactDto {
  @IsString() @MaxLength(120) name!: string;
  @IsString() @MaxLength(200) email!: string;
  @IsString() @MaxLength(20) phone!: string;
}

export class AddressDto {
  @IsString() @MaxLength(200) line1!: string;
  @IsOptional() @IsString() @MaxLength(200) line2?: string;
  @IsString() @MaxLength(100) city!: string;
  @IsString() @MaxLength(100) state!: string;
  @IsString() @MaxLength(10) pincode!: string;
}

export class PlaceOrderDto implements PlaceOrderRequest {
  @IsString() @MaxLength(100) idempotencyKey!: string;
  @ValidateNested() @Type(() => ContactDto) contact!: ContactDto;
  @ValidateNested() @Type(() => AddressDto) address!: AddressDto;
  @IsIn(['razorpay', 'cod']) paymentMethod!: 'razorpay' | 'cod';
}

/** Orders (BRD 21, CM21-03/CM21-06), guest or signed in — same `OptionalAuthGuard` pattern as the cart. */
@ApiTags('orders')
@Controller('orders')
@UseGuards(OptionalAuthGuard)
export class OrderController {
  constructor(
    private readonly orders: OrderService,
    private readonly orderEvents: OrderEventsService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  private owner(user: AuthUser | undefined, guestToken: string): OwnerContext {
    return user ? { userId: user.id } : { guestToken };
  }

  @Post()
  @UseGuards(CsrfGuard)
  @RateLimitBucket('checkout')
  place(@OptionalUser() user: AuthUser | undefined, @Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: PlaceOrderDto): Promise<Order> {
    const guestToken = ensureGuestCartToken(req, res, this.config.production);
    const ownerKey = ownerKeyFor(user?.id, guestToken);
    return this.orders.place(ownerKey, this.owner(user, guestToken), body);
  }

  @Get(':id')
  get(@OptionalUser() user: AuthUser | undefined, @Req() req: Request, @Param('id') id: string): Promise<Order> {
    return this.orders.get(id, this.owner(user, readGuestCartToken(req) ?? ''));
  }

  /** Real-time order tracking (BRD 23, MQ-06): a status change (payment confirmed, packed, shipped,
   * cancelled, ...) reaches an open tracking page immediately over Server-Sent Events, no reload or
   * polling needed. Ownership is checked by `OrderStreamOwnershipGuard` *before* the stream opens — see
   * that guard's own comment for why this can't just be an `await` at the top of this method for an SSE
   * route. The current status is sent as the first event, so the page has something to show immediately. */
  @Sse(':id/stream')
  @UseGuards(OrderStreamOwnershipGuard)
  async stream(@OptionalUser() user: AuthUser | undefined, @Req() req: Request, @Param('id') id: string): Promise<Observable<MessageEvent>> {
    const owner = this.owner(user, readGuestCartToken(req) ?? '');
    const current = await this.orders.get(id, owner);
    return this.orderEvents.observe(id, current);
  }

  @Get()
  list(@OptionalUser() user: AuthUser | undefined, @Req() req: Request): Promise<Order[]> {
    return this.orders.list(this.owner(user, readGuestCartToken(req) ?? ''));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  cancel(@OptionalUser() user: AuthUser | undefined, @Req() req: Request, @Param('id') id: string): Promise<Order> {
    return this.orders.cancel(id, this.owner(user, readGuestCartToken(req) ?? ''));
  }
}
