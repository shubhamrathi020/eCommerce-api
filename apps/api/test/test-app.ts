import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app/app.module';
import { configureApp } from '../src/app/configure-app';
import { type ApiConfig, loadConfig } from '../src/app/config';
import { PrismaService } from '../src/app/prisma/prisma.service';
import { MailService } from '../src/app/auth/mail.service';
import { MongoService } from '../src/app/catalog/mongo.service';
import { TEST_DATABASE_URL, TEST_MEILI_URL, TEST_MONGODB_URL, TEST_RABBITMQ_URL, TEST_REDIS_URL } from './global-setup';

export const ORIGIN = 'http://localhost:4200';

export interface TestApp {
  app: INestApplication;
  db: PrismaService;
  mongo: MongoService;
  mail: MailService;
  http: () => ReturnType<typeof request>;
  close: () => Promise<void>;
}

/** The real app (same pipeline as `main.ts`) against the test database. */
export async function createTestApp(overrides: Partial<ApiConfig> = {}): Promise<TestApp> {
  const config: ApiConfig = {
    ...loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      MONGODB_URL: TEST_MONGODB_URL,
      MEILI_URL: TEST_MEILI_URL,
      REDIS_URL: TEST_REDIS_URL,
      RABBITMQ_URL: TEST_RABBITMQ_URL,
      JWT_ACCESS_SECRET: 'test-access-secret-that-is-at-least-32-chars',
      JWT_REFRESH_SECRET: 'test-refresh-secret-that-is-at-least-32-char',
      CORS_ORIGINS: ORIGIN,
    }),
    ...overrides,
  };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] }).compile();
  const app = moduleRef.createNestApplication({ bodyParser: false, logger: false });
  configureApp(app, config);
  await app.init();
  const db = app.get(PrismaService);
  return { app, db, mongo: app.get(MongoService), mail: app.get(MailService), http: () => request(app.getHttpServer()), close: () => app.close() };
}

export async function resetDatabase(db: PrismaService): Promise<void> {
  await db.$executeRawUnsafe('TRUNCATE TABLE saved_addresses, refresh_tokens, login_attempts, users, carts, orders, outbox_events CASCADE');
}

/** Pulls the refresh cookie value out of a `set-cookie` header list. */
export function refreshCookie(setCookie: string[] | string | undefined): string {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookie = list.find((c) => c.startsWith('rt='));
  if (!cookie) throw new Error('no refresh cookie was set');
  return cookie.split(';')[0];
}
