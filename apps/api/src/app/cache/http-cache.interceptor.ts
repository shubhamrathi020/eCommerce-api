import { createHash } from 'node:crypto';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { EMPTY, type Observable, of, switchMap } from 'rxjs';

const HTTP_CACHE_MAX_AGE = 'httpCacheMaxAge';

/** Marks a GET route as publicly cacheable for `maxAgeSeconds` (BRD 22, CR-03): `HttpCacheInterceptor`
 * (registered globally) sets `Cache-Control`/`ETag` and answers a matching `If-None-Match` with 304.
 * Never put this on a route whose response differs per caller (business rule 1: nothing personalised or
 * private in a shared/public cache) — every route it's used on here is a plain catalog read. */
export const HttpCacheControl = (maxAgeSeconds: number) => SetMetadata(HTTP_CACHE_MAX_AGE, maxAgeSeconds);

@Injectable()
export class HttpCacheInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const maxAge = this.reflector.getAllAndOverride<number | undefined>(HTTP_CACHE_MAX_AGE, [context.getHandler(), context.getClass()]);
    if (maxAge === undefined) return next.handle();

    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    return next.handle().pipe(
      switchMap((body: unknown) => {
        const etag = `"${createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 27)}"`;
        res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
        res.setHeader('ETag', etag);
        if (req.headers['if-none-match'] === etag) {
          res.status(304);
          res.end();
          return EMPTY;
        }
        return of(body);
      }),
    );
  }
}
