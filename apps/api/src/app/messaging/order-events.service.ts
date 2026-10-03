import { Inject, Injectable } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { Order } from '@ecom/contracts';
import { API_CONFIG, type ApiConfig } from '../config';
import { RedisService } from '../cache/redis.service';

/**
 * Real-time order tracking (BRD 23, MQ-06): Redis pub/sub, not RabbitMQ — this is a live, best-effort
 * push to whatever browser tab happens to be open on the order-tracking page right now, not a durable
 * event that must survive a broker restart or be replayed later (that's exactly what the outbox/RabbitMQ
 * pipeline is for). A tab that isn't connected when a status change happens simply sees the new status on
 * its next `GET /orders/:id` instead, same as before this BRD — no capability is lost, this only adds the
 * option of not needing to reload.
 */
@Injectable()
export class OrderEventsService {
  constructor(
    private readonly redis: RedisService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  private channel(orderId: string): string {
    return `${this.config.redisKeyPrefix}order-events:${orderId}`;
  }

  async publish(order: Order): Promise<void> {
    await this.redis.raw.publish(this.channel(order.id), JSON.stringify(order));
  }

  /** `initial` is sent immediately on subscribe (the order's current state), so a freshly opened stream
   * shows something right away instead of waiting for the next actual change. */
  observe(orderId: string, initial: Order): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      subscriber.next({ data: initial });
      const sub = this.redis.raw.duplicate();
      const channel = this.channel(orderId);
      const onMessage = (ch: string, message: string) => {
        if (ch === channel) subscriber.next({ data: JSON.parse(message) });
      };
      sub.on('message', onMessage);
      sub.subscribe(channel).catch((error) => subscriber.error(error));
      return () => {
        sub.removeListener('message', onMessage);
        sub.unsubscribe(channel).catch(() => undefined);
        sub.quit().catch(() => undefined);
      };
    });
  }
}
