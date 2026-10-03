import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { MetricsService } from './metrics.service';

/** Prometheus scrapes this (BRD 24, OB-01) — same "internal, unauthenticated, not for browsers" posture
 * as `/healthz`/`/readyz`, since a real deployment keeps it off the public internet at the network layer
 * (a Kubernetes `NetworkPolicy`/service mesh rule, not an application-level login) rather than asking
 * every Prometheus scrape to carry a bearer token. */
@ApiExcludeController()
@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  metricsText(): Promise<string> {
    return this.metrics.render();
  }
}
