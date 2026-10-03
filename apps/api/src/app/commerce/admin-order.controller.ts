import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import type { AdminOrderDetail, AdminOrderQuery, AdminOrderRow, OrderStatus, Paged, PaymentMethod } from '@ecom/contracts';
import { IsIn, IsString, MaxLength } from 'class-validator';
import { AuthGuard, CurrentUser, RequirePermissions, type AuthUser } from '../common/auth';
import { AdminOrderService } from './admin-order.service';

const STATUSES: OrderStatus[] = ['pending_payment', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled'];
const PAYMENT_METHODS: PaymentMethod[] = ['razorpay', 'cod'];

export class AdvanceOrderDto {
  @ApiProperty({ enum: STATUSES }) @IsIn(STATUSES) status!: OrderStatus;
}

export class AddNoteDto {
  @ApiProperty() @IsString() @MaxLength(2000) text!: string;
}

const int = (v: unknown, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

/** Back-office order management (BRD 06's `AdminOrderApi`, now against real orders — BRD 21 CM21-09). */
@ApiTags('admin-orders')
@ApiBearerAuth()
@Controller('admin/orders')
@UseGuards(AuthGuard)
export class AdminOrderController {
  constructor(private readonly admin: AdminOrderService) {}

  @Get()
  @RequirePermissions('order:read:any')
  list(@Query() q: Record<string, string>): Promise<Paged<AdminOrderRow>> {
    const query: AdminOrderQuery = {
      ...(q['q'] ? { q: q['q'] } : {}),
      ...(q['status'] && STATUSES.includes(q['status'] as OrderStatus) ? { status: q['status'] as OrderStatus } : {}),
      ...(q['paymentMethod'] && PAYMENT_METHODS.includes(q['paymentMethod'] as PaymentMethod) ? { paymentMethod: q['paymentMethod'] as PaymentMethod } : {}),
      ...(q['from'] ? { from: q['from'] } : {}),
      ...(q['to'] ? { to: q['to'] } : {}),
      page: int(q['page'], 1),
      pageSize: Math.min(200, int(q['pageSize'], 20)),
    };
    return this.admin.list(query);
  }

  @Get(':id')
  @RequirePermissions('order:read:any')
  get(@Param('id') id: string): Promise<AdminOrderDetail> {
    return this.admin.get(id);
  }

  @Patch(':id/status')
  @RequirePermissions('order:refund')
  advance(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: AdvanceOrderDto): Promise<AdminOrderDetail> {
    return this.admin.advance(id, body.status, user.id);
  }

  @Post(':id/notes')
  @RequirePermissions('order:read:any')
  addNote(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: AddNoteDto): Promise<AdminOrderDetail> {
    return this.admin.addNote(id, user.id, body.text);
  }
}
