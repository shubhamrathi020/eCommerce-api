import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Correlation id and structured access log (BF-06). A caller-supplied `x-request-id` is reused only when it
 * looks like an id (so a client cannot inject arbitrary text into our logs); otherwise a fresh one is made.
 * Every log line is JSON with that id. No bodies, headers or query strings are logged: they can carry PII.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : randomUUID();
    req.headers['x-request-id'] = id;
    res.setHeader('x-request-id', id);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      this.logger.log(JSON.stringify({ requestId: id, method: req.method, path: req.path, status: res.statusCode, ms: Math.round(ms * 10) / 10 }));
    });
    next();
  }
}
