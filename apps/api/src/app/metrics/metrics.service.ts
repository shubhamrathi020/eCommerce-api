import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from '@prometheus-io/client';
import { CacheService } from '../cache/cache.service';
import { RazorpayService } from '../commerce/razorpay.service';
import { SearchService } from '../catalog/search.service';
import { PrismaService } from '../prisma/prisma.service';

const CIRCUIT_STATE_VALUE: Record<string, number> = { closed: 0, half_open: 1, open: 2 };

/**
 * Prometheus metrics (BRD 24, OB-01) — the RED method (rate, errors, duration) for every HTTP request,
 * plus the operational numbers this project already tracks internally (BRD 22's cache hit ratio, BRD 24's
 * own circuit-breaker state, BRD 23's outbox backlog) republished in a format Prometheus can scrape and
 * Grafana can chart. Gauges that read from another service (cache, breakers, the outbox table) use
 * the Prometheus client's `collect()` hook, which runs at scrape time — nothing is pushed or duplicated, `/metrics`
 * always reflects the current numbers `/admin/system/cache-stats`/`resilience` would show right now.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  private readonly httpRequestDuration: Histogram<'method' | 'route' | 'status'>;
  private readonly httpRequestsTotal: Counter<'method' | 'route' | 'status'>;

  constructor(
    private readonly cache: CacheService,
    private readonly razorpay: RazorpayService,
    private readonly search: SearchService,
    private readonly db: PrismaService,
  ) {
    collectDefaultMetrics({ register: this.registry }); // process CPU/memory/event-loop-lag, Node's own baseline
    this.httpRequestDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry],
    });
    this.httpRequestsTotal = new Counter({
      name: 'http_requests_total',
      help: 'Total HTTP requests (rate and error-rate PromQL both derive from this: e.g. rate(http_requests_total{status=~"5.."}[5m]))',
      labelNames: ['method', 'route', 'status'],
      registers: [this.registry],
    });
    // Each gauge's `collect` references the gauge itself (`cacheHitRatio.set(...)` etc.) from inside its
    // own constructor call — safe despite looking circular, because `collect` is a callback stored for
    // later, not invoked while the `const` is still being initialized; by the time Prometheus actually
    // scrapes and calls it, the assignment below has long since completed.
    const cacheHitRatio: Gauge<never> = new Gauge({
      name: 'cache_hit_ratio',
      help: 'Catalog cache hit ratio since process start (BRD 22)',
      registers: [this.registry],
      collect: () => {
        const stats = this.cache.getStats();
        const total = stats.hits + stats.misses;
        cacheHitRatio.set(total === 0 ? 0 : stats.hits / total);
      },
    });

    const circuitBreakerState: Gauge<'dependency'> = new Gauge({
      name: 'circuit_breaker_state',
      help: 'Circuit breaker state per dependency: 0=closed, 1=half_open, 2=open (BRD 24, OB-05)',
      labelNames: ['dependency'],
      registers: [this.registry],
      collect: () => {
        for (const stats of [this.razorpay.breakerStats(), this.search.breakerStats()]) circuitBreakerState.set({ dependency: stats.name }, CIRCUIT_STATE_VALUE[stats.state] ?? -1);
      },
    });

    const outboxUnpublished: Gauge<never> = new Gauge({
      name: 'outbox_unpublished_total',
      help: 'Outbox events not yet relayed to RabbitMQ (BRD 23) — should stay near 0; a sustained rise means the relay or broker is stuck',
      registers: [this.registry],
      collect: async () => {
        const count = await this.db.outboxEvent.count({ where: { publishedAt: null } }).catch(() => -1);
        outboxUnpublished.set(count);
      },
    });
  }

  /** Called once per request by `MetricsMiddleware`. `route` is the matched path pattern (`/orders/:id`),
   * not the raw URL — otherwise every distinct order id would be its own time series and cardinality
   * would grow without bound for as long as the process runs. */
  recordHttpRequest(method: string, route: string, status: number, durationSeconds: number): void {
    const labels = { method, route, status: String(status) };
    this.httpRequestDuration.observe(labels, durationSeconds);
    this.httpRequestsTotal.inc(labels);
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }
}
