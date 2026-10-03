import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { API_CONFIG, type ApiConfig } from '../config';

/** The one Redis connection the API uses for caching, coupon-redemption counters and (later) sessions
 * shared across instances (BRD 22). A thin wrapper so nothing else in the app imports `ioredis` directly. */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client!: Redis;

  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  async onModuleInit(): Promise<void> {
    // `keyPrefix` means every key this app touches is namespaced automatically, so a test run (which uses
    // a different prefix, see config.ts) can never collide with development data in the same Redis.
    this.client = new Redis(this.config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2, keyPrefix: this.config.redisKeyPrefix });
    await this.client.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }

  get raw(): Redis {
    return this.client;
  }

  async ping(): Promise<void> {
    await this.client.ping();
  }
}
