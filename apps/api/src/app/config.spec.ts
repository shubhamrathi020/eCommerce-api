import { loadConfig } from './config';

const base = { DATABASE_URL: 'postgresql://x', MONGODB_URL: 'mongodb://x', MEILI_URL: 'http://x', REDIS_URL: 'redis://x', RABBITMQ_URL: 'amqp://x', JWT_ACCESS_SECRET: 'a'.repeat(32), JWT_REFRESH_SECRET: 'b'.repeat(32) };

describe('loadConfig', () => {
  it('refuses to start without the required settings, listing every problem', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL is required[\s\S]*MONGODB_URL is required[\s\S]*MEILI_URL is required[\s\S]*REDIS_URL is required[\s\S]*RABBITMQ_URL is required[\s\S]*JWT_ACCESS_SECRET is required[\s\S]*JWT_REFRESH_SECRET is required/);
  });

  it('rejects a non-numeric or non-positive rate limit override', () => {
    expect(() => loadConfig({ ...base, RATE_LIMIT_SEARCH_PER_MIN: 'lots' })).toThrow(/RATE_LIMIT_SEARCH_PER_MIN must be a positive number/);
    expect(() => loadConfig({ ...base, RATE_LIMIT_COUPON_PER_MIN: '0' })).toThrow(/RATE_LIMIT_COUPON_PER_MIN must be a positive number/);
    const config = loadConfig({ ...base, RATE_LIMIT_CHECKOUT_PER_MIN: '5' });
    expect(config.rateLimits.checkout).toEqual({ limit: 5, windowSeconds: 60 });
    expect(config.rateLimits.search).toEqual({ limit: 60, windowSeconds: 60 });
    expect(config.rateLimits.global).toEqual({ limit: 300, windowSeconds: 60 });
    expect(loadConfig({ ...base, RATE_LIMIT_GLOBAL_PER_MIN: '5000' }).rateLimits.global.limit).toBe(5000);
  });

  it('rejects a non-numeric or non-positive abandoned-cart override, and namespaces MQ topology for tests', () => {
    expect(() => loadConfig({ ...base, ABANDONED_CART_MINUTES: 'never' })).toThrow(/ABANDONED_CART_MINUTES must be a positive number/);
    expect(loadConfig({ ...base, ABANDONED_CART_MINUTES: '30' }).abandonedCartMinutes).toBe(30);
    expect(loadConfig(base).mqPrefix).toBe('ecom.');
    expect(loadConfig({ ...base, NODE_ENV: 'test' }).mqPrefix).toBe('ecom.test.');
  });

  it('rejects short or identical secrets', () => {
    expect(() => loadConfig({ ...base, JWT_ACCESS_SECRET: 'short' })).toThrow(/at least 32 characters/);
    expect(() => loadConfig({ ...base, JWT_REFRESH_SECRET: base.JWT_ACCESS_SECRET })).toThrow(/must differ/);
  });

  it('parses the origin list and keeps docs off in production unless asked', () => {
    const config = loadConfig({ ...base, CORS_ORIGINS: ' http://a , http://b ,', NODE_ENV: 'production' });
    expect(config.corsOrigins).toEqual(['http://a', 'http://b']);
    expect(config.docs).toBe(false);
    expect(loadConfig({ ...base, NODE_ENV: 'production', API_DOCS: 'on' }).docs).toBe(true);
    expect(loadConfig({ ...base, NODE_ENV: 'test' }).rateLimit).toBe(false);
  });
});
