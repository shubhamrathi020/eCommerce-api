import { type INestApplication, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import type { ApiConfig } from './config';

/**
 * Everything applied around the Nest app, shared by `main.ts` and the integration tests so the tests exercise
 * exactly the production pipeline (headers, CORS, cookie parsing, validation).
 */
export function configureApp(app: INestApplication, config: ApiConfig): void {
  const express = app as NestExpressApplication;
  express.disable('x-powered-by');
  // Behind Docker / the Kubernetes ingress: trust one proxy hop for the client IP (rate limiting uses it).
  express.set('trust proxy', 1);

  // A JSON API needs no CSP beyond "nothing"; the docs page gets its own, looser policy.
  const apiHeaders = helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } });
  const docsHeaders = helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'] } } });
  express.use((req: Request, res: Response, next: NextFunction) => (req.path.startsWith('/docs') ? docsHeaders : apiHeaders)(req, res, next));

  express.use(cookieParser());
  // Credentials only for the listed origins (BF-09). Anything else gets no CORS headers at all.
  express.enableCors({ origin: config.corsOrigins, credentials: true, allowedHeaders: ['content-type', 'authorization', 'x-csrf', 'x-request-id'], exposedHeaders: ['x-request-id'], maxAge: 600 });
  // `verify` stashes the exact raw bytes on the request (BRD 21's Razorpay webhook needs to check its
  // signature against the untouched body, not a re-serialised copy of the parsed JSON).
  express.useBodyParser('json', { limit: '100kb', verify: (req: Request & { rawBody?: string }, _res: Response, buf: Buffer) => (req.rawBody = buf.toString('utf8')) });
  express.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  express.enableShutdownHooks();

  if (config.docs) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('eCommerce API').setDescription('Identity (BRD 19), catalog and search (BRD 20), cart/checkout/orders/payments (BRD 21). Errors use the `{ code, message, fields?, requestId? }` shape.').setVersion('0.3').addBearerAuth().build(),
    );
    SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs/openapi.json' });
  }
}
