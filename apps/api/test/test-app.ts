import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app/app.module';
import { configureApp } from '../src/app/configure-app';
import { type ApiConfig, loadConfig } from '../src/app/config';
import { PrismaService } from '../src/app/prisma/prisma.service';
import { MailService } from '../src/app/auth/mail.service';
import { MongoService } from '../src/app/catalog/mongo.service';
import { SearchService } from '../src/app/catalog/search.service';
import { RabbitService } from '../src/app/messaging/rabbit.service';
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

/**
 * When `GO_API_BIN` points at the compiled Go server (eCommerce-go), the very same specs run against it instead of
 * the in-process Nest app: a separate process per test file, configured through the environment, talking to the same
 * databases. Tests that reach into the Nest app's internals (`t.app.get(...)`) are skipped in that mode.
 */
export const REMOTE = !!process.env['GO_API_BIN'];
/** `it` for tests that need the in-process Nest app. */
export const itInProcess = REMOTE ? it.skip : it;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function createRemoteApp(bin: string, overrides: Partial<ApiConfig>): Promise<TestApp> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    DATABASE_URL: TEST_DATABASE_URL,
    MONGODB_URL: TEST_MONGODB_URL,
    MEILI_URL: TEST_MEILI_URL,
    REDIS_URL: TEST_REDIS_URL,
    RABBITMQ_URL: TEST_RABBITMQ_URL,
    JWT_ACCESS_SECRET: 'test-access-secret-that-is-at-least-32-chars',
    JWT_REFRESH_SECRET: 'test-refresh-secret-that-is-at-least-32-char',
    CORS_ORIGINS: ORIGIN,
    ...(overrides.rateLimit ? { RATE_LIMIT: 'on' } : {}),
  };
  const child = spawn(bin, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (output += d.toString()));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if (child.exitCode !== null) throw new Error(`The Go server exited at startup:
${output}`);
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {
      /* not listening yet */
    }
    if (i > 300) throw new Error(`The Go server did not start:
${output}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const dbConfig = { databaseUrl: TEST_DATABASE_URL, mongoUrl: TEST_MONGODB_URL, mongoDbName: 'ecommerce_catalog_test' } as ApiConfig;
  const db = new PrismaService(dbConfig);
  const mongo = new MongoService(dbConfig);
  await mongo.onModuleInit();
  // The Go server keeps its dev mailbox in memory, like the Nest one; read it over HTTP (synchronously, as the specs do).
  const mail = {
    list: () => JSON.parse(execFileSync(process.execPath, ['-e', 'fetch(process.argv[1]).then((r) => r.text()).then((t) => process.stdout.write(t))', `${base}/dev/outbox`], { encoding: 'utf8' })),
  } as unknown as MailService;
  // A few specs poke the search index and the broker directly; give them real clients on the same test stores.
  const fullConfig = loadConfig(env);
  const search = new SearchService(fullConfig);
  const rabbit = new RabbitService(fullConfig);
  let rabbitReady = false;
  const app = {
    get: (token: unknown) => {
      if (token === SearchService) return search;
      if (token === RabbitService) {
        if (!rabbitReady) throw new Error('call connectRabbit() first');
        return rabbit;
      }
      throw new Error('This test needs the in-process Nest app');
    },
  } as unknown as INestApplication;
  await rabbit.onModuleInit();
  rabbitReady = true;
  return {
    app,
    db,
    mongo,
    mail,
    http: () => request(base) as unknown as ReturnType<typeof request>,
    close: async () => {
      child.kill();
      await rabbit.onModuleDestroy();
      await db.$disconnect();
      await mongo.onModuleDestroy();
    },
  };
}

/** The real app (same pipeline as `main.ts`) against the test database. */
export async function createTestApp(overrides: Partial<ApiConfig> = {}): Promise<TestApp> {
  if (process.env['GO_API_BIN']) return createRemoteApp(process.env['GO_API_BIN'], overrides);
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
