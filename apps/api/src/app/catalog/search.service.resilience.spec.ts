import { loadConfig } from '../config';
import { AppError } from '../common/app-error';
import { SearchService } from './search.service';

const base = { DATABASE_URL: 'postgresql://x', MONGODB_URL: 'mongodb://x', REDIS_URL: 'redis://x', RABBITMQ_URL: 'amqp://x', JWT_ACCESS_SECRET: 'a'.repeat(32), JWT_REFRESH_SECRET: 'b'.repeat(32) };

/** Real resilience (BRD 24, OB-05): a `SearchService` pointed at a port nothing listens on behaves
 * exactly like a Meilisearch outage would — every call genuinely fails over the network, not a mock. */
describe('SearchService resilience', () => {
  it('degrades gracefully: a few failures return a clear network error fast, then the circuit opens and stops even trying', async () => {
    const service = new SearchService(loadConfig({ ...base, MEILI_URL: 'http://127.0.0.1:1' }));

    // First 3 calls: each genuinely attempts the (unreachable) request, retries once, and fails — every
    // one surfaces as the same friendly AppError, not the raw fetch/Meilisearch exception underneath.
    // These 3 are what trip the breaker (failureThreshold: 3 in SearchService's own constructor).
    for (let i = 0; i < 3; i++) {
      await expect(service.count(['x = 1'])).rejects.toMatchObject({ code: 'network' });
    }
    expect(service.breakerStats().state).toBe('open');

    // Now open: the 4th call fails immediately (well under the 3s per-call timeout), proving it never
    // actually attempted the network call this time.
    const start = Date.now();
    await expect(service.count(['x = 1'])).rejects.toMatchObject({ code: 'network', message: expect.stringContaining('temporarily unavailable') });
    expect(Date.now() - start).toBeLessThan(500);
  }, 30_000);

  it('suggestProducts and search both go through the same breaker as count', async () => {
    const service = new SearchService(loadConfig({ ...base, MEILI_URL: 'http://127.0.0.1:1' }));
    await expect(service.suggestProducts('phone', 4)).rejects.toThrow(AppError);
    await expect(service.search({ scope: [], facetFilters: [], facetFields: [], sort: 'relevance', page: 1, pageSize: 20 })).rejects.toThrow(AppError);
    expect(service.breakerStats().consecutiveFailures).toBe(2);
    await expect(service.count(['x = 1'])).rejects.toMatchObject({ code: 'network' }); // 3rd failure: breaker now open
    expect(service.breakerStats().state).toBe('open');
  }, 30_000);
});
