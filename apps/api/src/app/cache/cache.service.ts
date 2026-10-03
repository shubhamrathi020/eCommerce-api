import { Injectable } from '@nestjs/common';
import { RedisService } from './redis.service';

export interface CacheStats {
  hits: number;
  misses: number;
  /** Concurrent callers for the same key that were coalesced onto one in-flight fetch instead of each
   * hitting the backend themselves (CR-02). */
  coalesced: number;
  /** Requests refused with 429, by rate-limit bucket (CR-04/CR-07). Not cache stats, strictly, but the
   * same "one small object the admin stats endpoint reads" home for both, rather than a second provider
   * that exists only to hold a counter. */
  rateLimitBlocked: Record<string, number>;
}

/**
 * Cache-aside reads with tagged invalidation (BRD 22, CR-01) and stampede protection (CR-02). Never used
 * for anything personalised or private (business rule 1) — only catalog reads (home, listing, product,
 * category tree), which are the same for every shopper.
 *
 * Stampede protection here is a per-process in-flight map: two requests on *this* instance for the same
 * key share one backend fetch. It does not coordinate across multiple API instances (that needs a
 * distributed lock, e.g. Redis `SET key val NX EX ttl`) — a scoped-down simplification for a project that
 * does not run more than one API instance yet, recorded here rather than silently assumed to be more than
 * it is.
 */
@Injectable()
export class CacheService {
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly stats: CacheStats = { hits: 0, misses: 0, coalesced: 0, rateLimitBlocked: {} };

  constructor(private readonly redis: RedisService) {}

  getStats(): CacheStats {
    return { ...this.stats, rateLimitBlocked: { ...this.stats.rateLimitBlocked } };
  }

  recordRateLimitBlocked(bucket: string): void {
    this.stats.rateLimitBlocked[bucket] = (this.stats.rateLimitBlocked[bucket] ?? 0) + 1;
  }

  /** Returns the cached value for `key`, or computes it with `factory`, caches it for `ttlSeconds`, and
   * records it under every tag in `tags` (so `invalidateTag` can find and drop it later) — `tags` can
   * depend on the computed value itself (e.g. a product's own id, only known once it's been fetched). */
  async getOrSet<T>(key: string, ttlSeconds: number, tags: string[] | ((value: T) => string[]), factory: () => Promise<T>): Promise<T> {
    // A Redis outage degrades to "always compute, never cache" rather than a 500 — treat a failed read
    // the same as a miss.
    const cached = await this.redis.raw.get(key).catch(() => null);
    if (cached !== null) {
      this.stats.hits++;
      return JSON.parse(cached) as T;
    }

    const existing = this.inFlight.get(key);
    if (existing) {
      this.stats.coalesced++;
      return existing as Promise<T>;
    }

    this.stats.misses++;
    const promise = (async () => {
      try {
        const value = await factory();
        // Best-effort: a Redis write failure should degrade to "computed but not cached", never break
        // the response that's already correctly computed.
        try {
          const serialised = JSON.stringify(value);
          const pipeline = this.redis.raw.pipeline().set(key, serialised, 'EX', ttlSeconds);
          for (const tag of typeof tags === 'function' ? tags(value) : tags) pipeline.sadd(`tag:${tag}`, key);
          await pipeline.exec();
        } catch {
          // Swallow: the caller still gets the freshly computed value.
        }
        return value;
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, promise);
    return promise;
  }

  /** Drops every cache entry ever tagged with `tag` (e.g. `product:p-0001`, or the coarser `catalog:listings`
   * bucket every home/listing entry carries) — called after any catalog write. */
  async invalidateTag(tag: string): Promise<void> {
    try {
      const tagKey = `tag:${tag}`;
      const keys = await this.redis.raw.smembers(tagKey);
      if (keys.length === 0) return;
      await this.redis.raw.del(...keys, tagKey);
    } catch {
      // Best-effort: a cache that fails to invalidate goes stale until its TTL expires, never blocks the
      // write itself. TTLs on every catalog entry (see catalog.service.ts) are the backstop for this.
    }
  }
}
