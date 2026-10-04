import jwt from 'jsonwebtoken';
import { type TestApp, createTestApp, resetDatabase } from './test-app';

const ACCESS_SECRET = 'test-access-secret-that-is-at-least-32-chars';
const adminToken = (permissions: string[]) => jwt.sign({ sub: 'admin-1', roles: ['admin'], permissions }, ACCESS_SECRET, { audience: 'ecom-api', issuer: 'ecom-api', expiresIn: '5m' });

describe('metrics and resilience endpoints (BRD 24)', () => {
  let t: TestApp;
  beforeAll(async () => (t = await createTestApp()));
  afterAll(() => t.close());
  beforeEach(() => resetDatabase(t.db));

  it('/metrics is a real Prometheus exposition, not a stub, and reflects an actual request that just happened', async () => {
    await t.http().get('/catalog/home'); // something real to show up in the counters below

    const res = await t.http().get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    const body = res.text as string;

    // The RED-method HTTP metrics, labelled by matched route pattern (not the raw URL, so cardinality
    // stays bounded) — and a real sample for the request made just above.
    expect(body).toMatch(/^# TYPE http_requests_total counter$/m);
    expect(body).toMatch(/^# TYPE http_request_duration_seconds histogram$/m);
    expect(body).toMatch(/http_requests_total\{method="GET",route="\/catalog\/home",status="200"\} \d/m);

    // The operational gauges pulled from BRD 22/23/24's own services at scrape time, not hardcoded.
    expect(body).toMatch(/^# TYPE cache_hit_ratio gauge$/m);
    expect(body).toMatch(/^# TYPE circuit_breaker_state gauge$/m);
    expect(body).toMatch(/circuit_breaker_state\{dependency="razorpay"\} 0/m); // closed, in a healthy test run
    expect(body).toMatch(/circuit_breaker_state\{dependency="meilisearch"\} 0/m);
    expect(body).toMatch(/^# TYPE outbox_unpublished_total gauge$/m);

    // Node's own baseline (event loop lag, memory, ...) via the Prometheus client's collectDefaultMetrics.
    expect(body).toMatch(/^# TYPE process_resident_memory_bytes gauge$/m);
  });

  it('a request that was never made does not show up as its own time series (bounded cardinality by design)', async () => {
    const res = await t.http().get('/metrics');
    expect(res.text).not.toMatch(/route="\/orders\/ORD-/); // a raw order id, not the route pattern
  });

  it('the resilience endpoint needs system:read and reports both breakers by name', async () => {
    const noPerm = await t.http().get('/admin/system/resilience').set('authorization', `Bearer ${adminToken([])}`);
    expect(noPerm.status).toBe(403);

    const res = await t.http().get('/admin/system/resilience').set('authorization', `Bearer ${adminToken(['system:read'])}`);
    expect(res.status).toBe(200);
    expect(res.body.circuitBreakers.map((c: { name: string }) => c.name)).toEqual(expect.arrayContaining(['razorpay', 'meilisearch']));
    expect(res.body.circuitBreakers.every((c: { state: string }) => c.state === 'closed')).toBe(true);
  });
});
