import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController } from '@nestjs/swagger';
import { AuthGuard, RequirePermissions } from '../common/auth';
import { RazorpayService } from '../commerce/razorpay.service';
import { SearchService } from '../catalog/search.service';
import type { CircuitStats } from '../resilience/circuit-breaker';
import { CacheService, type CacheStats } from './cache.service';

/** CR-07's "hit ratio and blocked requests are visible" (BRD 22) — a small in-process stats endpoint, not
 * the full Prometheus/Grafana dashboard that request describes; that's real observability-stack work,
 * more naturally built alongside BRD 24, which builds the rest of that stack. This is genuinely useful
 * today without it: `hitRatio` here is exactly the number the BRD's own "hit ratio above 80%" target
 * (§6) is checked against. Counters reset on every restart (in-process, not persisted) — good enough for
 * "is this working right now", not a substitute for real historical metrics. */
@ApiExcludeController()
@ApiBearerAuth()
@Controller('admin/system')
@UseGuards(AuthGuard)
export class CacheStatsController {
  constructor(
    private readonly cache: CacheService,
    private readonly razorpay: RazorpayService,
    private readonly search: SearchService,
  ) {}

  @Get('cache-stats')
  @RequirePermissions('system:read')
  stats(): CacheStats & { hitRatio: number } {
    const stats = this.cache.getStats();
    const total = stats.hits + stats.misses;
    return { ...stats, hitRatio: total === 0 ? 0 : Math.round((stats.hits / total) * 100) / 100 };
  }

  /** Circuit-breaker state for the two external dependencies wrapped in BRD 24, OB-05 — "closed" means
   * normal, "open" means calls are currently failing fast instead of being attempted. */
  @Get('resilience')
  @RequirePermissions('system:read')
  resilience(): { circuitBreakers: CircuitStats[] } {
    return { circuitBreakers: [this.razorpay.breakerStats(), this.search.breakerStats()] };
  }
}
