import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { HttpException, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { API_CONFIG, type ApiConfig } from '../config';
import { CacheService } from './cache.service';
import { RedisService } from './redis.service';

const RATE_LIMIT_BUCKET = 'rateLimitBucket';

/** Marks a route with one of `ApiConfig.rateLimits`'s named buckets (BRD 22, CR-04) — search, coupon or
 * checkout. Deliberately a separate mechanism from `@nestjs/throttler` (already used for auth, BF-09):
 * `@Throttle()`'s numbers are decorator arguments evaluated at import time, before `loadConfig()` has run,
 * so they can never actually read the configured value — only ever a hardcoded literal. This guard reads
 * `ApiConfig` at request time instead, so `RATE_LIMIT_SEARCH_PER_MIN` etc. in `.env` genuinely take effect
 * without a code change. */
export const RateLimitBucket = (bucket: keyof ApiConfig['rateLimits']) => SetMetadata(RATE_LIMIT_BUCKET, bucket);

/** A plain fixed-window counter (`INCR` + `EXPIRE NX`), not a sliding window or token bucket — simpler,
 * and precise enough at this traffic scale; the BRD names either as acceptable. Per client IP, per bucket,
 * per window: `ratelimit:<bucket>:<window-start>:<ip>`, so old windows expire and are never cleaned up by
 * hand. Fails open on a Redis outage (a rate limiter that itself takes the site down on a cache blip is
 * worse than a brief lapse in limiting). */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly redis: RedisService,
    private readonly reflector: Reflector,
    private readonly cache: CacheService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const bucket = this.reflector.getAllAndOverride<keyof ApiConfig['rateLimits'] | undefined>(RATE_LIMIT_BUCKET, [context.getHandler(), context.getClass()]);
    if (!bucket || !this.config.rateLimit) return true;
    const { limit, windowSeconds } = this.config.rateLimits[bucket];
    const req = context.switchToHttp().getRequest<Request>();
    const windowStart = Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
    const key = `ratelimit:${bucket}:${windowStart}:${req.ip}`;

    let count: number;
    try {
      count = await this.redis.raw.incr(key);
      if (count === 1) await this.redis.raw.expire(key, windowSeconds);
    } catch {
      return true; // Redis unavailable: fail open rather than block all traffic on a cache outage.
    }

    if (count > limit) {
      this.cache.recordRateLimitBlocked(bucket);
      const res = context.switchToHttp().getResponse<Response>();
      res.setHeader('Retry-After', String(windowStart + windowSeconds - Math.floor(Date.now() / 1000)));
      throw new HttpException('Too many requests. Please wait a moment and try again.', 429);
    }
    return true;
  }
}
