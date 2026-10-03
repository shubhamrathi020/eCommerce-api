import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { MetricsService } from './metrics.service';

/**
 * Times every HTTP request and records it once the response finishes (BRD 24, OB-01). Reads `req.route`
 * only in the `finish` handler, after Express/Nest routing has already run and populated it with the
 * matched path *pattern* (`/orders/:id`), not `req.path`'s raw URL (`/orders/ORD-123`) — using the raw URL
 * would give every distinct order id its own Prometheus time series, growing without bound for as long as
 * the process runs (a well-known "cardinality explosion" mistake this deliberately avoids).
 */
@Injectable()
export class MetricsMiddleware implements NestMiddleware {
  constructor(@Inject(MetricsService) private readonly metrics: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    if (req.path === '/metrics') return next(); // scraping /metrics is not itself a metric worth recording
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      this.metrics.recordHttpRequest(req.method, route, res.statusCode, seconds);
    });
    next();
  }
}
