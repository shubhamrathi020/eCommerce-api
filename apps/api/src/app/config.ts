/** Typed, validated configuration read once from the environment. The app refuses to start without it. */
export interface ApiConfig {
  port: number;
  production: boolean;
  databaseUrl: string;
  /** Catalog store (BRD 20): flexible product/category/brand/collection documents. */
  mongoUrl: string;
  mongoDbName: string;
  /** Search engine (BRD 20): typo-tolerant, faceted product search. */
  meiliUrl: string;
  meiliMasterKey: string;
  /** Suffix appended to Meilisearch index names, so `pnpm exec nx test api` never touches dev/prod data. */
  meiliIndexSuffix: string;
  /** Cache-aside reads, coupon-redemption counters (BRD 22). */
  redisUrl: string;
  /** Prefix on every Redis key, so `pnpm exec nx test api` never touches dev/prod cache entries. */
  redisKeyPrefix: string;
  /** Message broker (BRD 23): the outbox relay, notification consumer and DLQ. */
  rabbitmqUrl: string;
  /** Every exchange/queue/lock name is prefixed with this, so `pnpm exec nx test api` never shares
   * topology (or the outbox-relay/scheduler locks) with dev/prod, mirroring `redisKeyPrefix`. */
  mqPrefix: string;
  /** Minutes an item can sit untouched in a cart before one reminder email is sent (BRD 23, MQ-05). */
  abandonedCartMinutes: number;
  /** Per-route rate limits (BRD 22), each `{ limit, windowSeconds }`. Configurable so ops can tune them
   * without a redeploy. `login` isn't here: the 5-attempts/15-minutes-per-email lockout in AuthService
   * already covers it (BRD 22's own proposed default), enforced per account, not per IP. */
  rateLimits: {
    /** The blanket per-IP ceiling on every route (BRD 19's original 300/minute, now tunable — BRD 25's load
     * tests found it was the first thing a single test client hit, far below real backend capacity). */
    global: { limit: number; windowSeconds: number };
    search: { limit: number; windowSeconds: number };
    coupon: { limit: number; windowSeconds: number };
    checkout: { limit: number; windowSeconds: number };
  };
  jwtAccessSecret: string;
  jwtRefreshSecret: string;
  /** Optional: online payments (BRD 21). Empty until you add your own test-mode keys to apps/api/.env;
   * the API still starts and cash-on-delivery still works without them, but PaymentApi.initiate refuses
   * with a clear error. Never a "live" key outside production (checked below). */
  razorpayKeyId: string;
  razorpayKeySecret: string;
  razorpayWebhookSecret: string;
  razorpayEnabled: boolean;
  /** Origins allowed to call the API with credentials (the storefront and admin apps). */
  corsOrigins: string[];
  accessTokenMinutes: number;
  refreshTokenDays: number;
  /** Rate limiting is on everywhere except the automated test run (unless a test switches it back on). */
  rateLimit: boolean;
  /** OpenAPI docs at `/docs`: always outside production, opt-in (`API_DOCS=on`) in production. */
  docs: boolean;
}

export const API_CONFIG = Symbol('API_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const problems: string[] = [];
  const need = (key: string): string => {
    const value = env[key]?.trim();
    if (!value) problems.push(`${key} is required`);
    return value ?? '';
  };
  const databaseUrl = need('DATABASE_URL');
  const mongoUrl = need('MONGODB_URL');
  const meiliUrl = need('MEILI_URL');
  const meiliMasterKey = env['MEILI_MASTER_KEY']?.trim() ?? '';
  const redisUrl = need('REDIS_URL');
  const rabbitmqUrl = need('RABBITMQ_URL');
  const int = (key: string, fallback: number): number => {
    const raw = env[key]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) problems.push(`${key} must be a positive number`);
    return n;
  };
  const jwtAccessSecret = need('JWT_ACCESS_SECRET');
  const jwtRefreshSecret = need('JWT_REFRESH_SECRET');
  for (const [key, value] of [['JWT_ACCESS_SECRET', jwtAccessSecret], ['JWT_REFRESH_SECRET', jwtRefreshSecret]] as const) {
    if (value && value.length < 32) problems.push(`${key} must be at least 32 characters`);
  }
  if (jwtAccessSecret && jwtAccessSecret === jwtRefreshSecret) problems.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ');
  const production = env['NODE_ENV'] === 'production';
  if (production && jwtAccessSecret.startsWith('dev-only-')) {
    // Still allowed so `docker compose up` works out of the box, but never silently.
    console.warn('[config] Using the dev-only JWT secrets from .env.example. Set real secrets before deploying anywhere.');
  }
  const razorpayKeyId = env['RAZORPAY_KEY_ID']?.trim() ?? '';
  const razorpayKeySecret = env['RAZORPAY_KEY_SECRET']?.trim() ?? '';
  const razorpayWebhookSecret = env['RAZORPAY_WEBHOOK_SECRET']?.trim() ?? '';
  if (razorpayKeyId && !razorpayKeyId.startsWith('rzp_test_')) {
    // This project only ever runs in test mode; a live key here would mean real money. Never proceed.
    problems.push("RAZORPAY_KEY_ID must be a test-mode key (starts with 'rzp_test_'); live keys are refused");
  }
  if (razorpayKeyId && !razorpayKeySecret) problems.push('RAZORPAY_KEY_SECRET is required when RAZORPAY_KEY_ID is set');
  const rateLimits = {
    global: { limit: int('RATE_LIMIT_GLOBAL_PER_MIN', 300), windowSeconds: 60 },
    search: { limit: int('RATE_LIMIT_SEARCH_PER_MIN', 60), windowSeconds: 60 },
    coupon: { limit: int('RATE_LIMIT_COUPON_PER_MIN', 20), windowSeconds: 60 },
    checkout: { limit: int('RATE_LIMIT_CHECKOUT_PER_MIN', 20), windowSeconds: 60 },
  };
  const abandonedCartMinutes = int('ABANDONED_CART_MINUTES', 60);
  // Every `int()` call above can push to `problems`; the throw check has to come after all of them, not
  // before — the same ordering mistake BRD 22 made and fixed once already (see steering/memory.md).
  if (problems.length) throw new Error(`Invalid API configuration:\n - ${problems.join('\n - ')}`);
  return {
    port: Number(env['PORT'] ?? 3333),
    production,
    databaseUrl,
    mongoUrl,
    mongoDbName: env['NODE_ENV'] === 'test' ? 'ecommerce_catalog_test' : (env['MONGODB_DB_NAME']?.trim() ?? 'ecommerce_catalog'),
    meiliUrl,
    meiliMasterKey,
    meiliIndexSuffix: env['NODE_ENV'] === 'test' ? '_test' : '',
    redisUrl,
    redisKeyPrefix: env['NODE_ENV'] === 'test' ? 'ecom:test:' : 'ecom:',
    rabbitmqUrl,
    mqPrefix: env['NODE_ENV'] === 'test' ? 'ecom.test.' : 'ecom.',
    abandonedCartMinutes,
    rateLimits,
    jwtAccessSecret,
    jwtRefreshSecret,
    razorpayKeyId,
    razorpayKeySecret,
    razorpayWebhookSecret,
    razorpayEnabled: !!razorpayKeyId,
    corsOrigins: (env['CORS_ORIGINS'] ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    accessTokenMinutes: 15,
    refreshTokenDays: 30,
    rateLimit: env['NODE_ENV'] !== 'test' || env['RATE_LIMIT'] === 'on',
    docs: !production || env['API_DOCS'] === 'on',
  };
}
