import { Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController } from '@nestjs/swagger';
import { AuthGuard, RequirePermissions } from '../common/auth';
import { RabbitService } from './rabbit.service';

/** MQ-03's "a tool to inspect and replay" (BRD 23) poison messages: a message that failed processing
 * three times (see `NotificationConsumerService`) lands here instead of being lost. `list` is a
 * non-destructive peek (documented limitation: a concurrent peek can reorder the queue slightly, since
 * `basic.get` has no dedicated non-destructive browse mode); `replay` re-publishes the single oldest
 * dead letter back onto the main exchange under its original routing key, for another real attempt. */
@ApiExcludeController()
@ApiBearerAuth()
@Controller('admin/system')
@UseGuards(AuthGuard)
export class DeadLetterController {
  constructor(private readonly rabbit: RabbitService) {}

  @Get('dead-letters')
  @RequirePermissions('system:read')
  list(@Query('limit') limit?: string): Promise<Array<{ routingKey: string; body: unknown; retryCount: number; lastError: string | undefined }>> {
    return this.rabbit.peek(this.rabbit.dlq, Math.min(100, Number(limit) || 20));
  }

  @Post('dead-letters/replay')
  @HttpCode(200)
  @RequirePermissions('system:write')
  async replay(): Promise<{ replayed: boolean; routingKey?: string }> {
    const popped = await this.rabbit.popOldest(this.rabbit.dlq);
    if (!popped) return { replayed: false };
    await this.rabbit.publish(popped.routingKey, popped.body);
    return { replayed: true, routingKey: popped.routingKey };
  }
}
