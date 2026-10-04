import { writeFileSync } from 'node:fs';
import { type TestApp, ORIGIN, createTestApp, resetDatabase } from './test-app';

// Differential probe: records how a server answers odd requests (malformed JSON, unknown routes, CORS preflight, HEAD, conditional GETs,
// missing CSRF headers ...) so two implementations of this API can be diffed. Skipped unless PROBE_OUT names the output file:
//   PROBE_OUT=nest.json pnpm exec vitest run test/parity-probe.spec.ts                         (this Nest app)
//   PROBE_OUT=other.json API_BIN=<server> pnpm exec vitest run test/parity-probe.spec.ts      (another implementation)
// then compare the two JSON files ignoring key order.
const normalise = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (k, v) => (k === 'requestId' || k === 'expiresAt' || k === 'createdAt' || k === 'accessToken' || k === 'id' || k === 'sentAt' ? '<x>' : v)));

describe.skipIf(!process.env['PROBE_OUT'])('parity probe', () => {
  let t: TestApp;
  const out: Record<string, unknown> = {};
  beforeAll(async () => (t = await createTestApp()));
  afterAll(async () => {
    writeFileSync(process.env['PROBE_OUT'] as string, JSON.stringify(out, null, 2));
    await t.close();
  });
  beforeEach(() => resetDatabase(t.db));

  const record = (name: string, res: { status: number; headers: Record<string, unknown>; body?: unknown; text?: string }) => {
    const headers = Object.fromEntries(Object.entries(res.headers).filter(([k]) => !['date', 'etag', 'content-length', 'connection', 'keep-alive', 'set-cookie', 'x-request-id'].includes(k)).sort());
    out[name] = normalise({ status: res.status, headers, hasEtag: !!res.headers['etag'], etagWeak: String(res.headers['etag'] ?? '').startsWith('W/'), hasRequestId: !!res.headers['x-request-id'], setCookie: ((res.headers['set-cookie'] as string[] | undefined) ?? []).map((c) => c.replace(/=[^;]*/, '=<v>').replace(/Expires=[^;]*/, 'Expires=<d>')), body: res.body && Object.keys(res.body as object).length ? res.body : res.text?.slice(0, 200) });
  };

  it('records', async () => {
    record('malformed-json', await t.http().post('/auth/login').set('content-type', 'application/json').send('{bad json'));
    record('big-body', await t.http().post('/auth/login').set('content-type', 'application/json').send(JSON.stringify({ email: 'a'.repeat(200_000), password: 'x' })));
    record('unknown-route', await t.http().get('/nope'));
    record('unknown-route-post', await t.http().post('/nope').send({}));
    record('options-preflight', await t.http().options('/auth/login').set('Origin', ORIGIN).set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'content-type,x-csrf'));
    record('options-bad-origin', await t.http().options('/auth/login').set('Origin', 'http://evil.test').set('Access-Control-Request-Method', 'POST'));
    record('healthz-origin', await t.http().get('/healthz').set('Origin', ORIGIN));
    record('readyz', await t.http().get('/readyz'));
    record('head-healthz', await t.http().head('/healthz'));
    record('array-body', await t.http().post('/auth/login').set('content-type', 'application/json').send('[]'));
    record('string-body', await t.http().post('/auth/login').set('content-type', 'application/json').send('"hi"'));
    record('text-body', await t.http().post('/auth/login').set('content-type', 'text/plain').send('hello'));
    record('extra-key', await t.http().post('/auth/login').send({ email: 'a@b.co', password: 'x', extra: 1 }));
    record('null-body-field', await t.http().post('/auth/login').send({ email: null, password: 'x' }));
    const home = await t.http().get('/catalog/home');
    record('catalog-home', home);
    record('catalog-home-304', await t.http().get('/catalog/home').set('If-None-Match', String(home.headers['etag'])));
    record('me-no-token', await t.http().get('/auth/me'));
    record('me-bad-token', await t.http().get('/auth/me').set('authorization', 'Bearer nope'));
    record('cart-get', await t.http().get('/cart'));
    record('cart-no-csrf', await t.http().post('/cart/items').send({ variantId: 'v', quantity: 1 }));
    record('cart-bad-quantity', await t.http().post('/cart/items').set('x-csrf', '1').send({ variantId: 'v', quantity: 1.5 }));
    record('cart-unknown-variant', await t.http().post('/cart/items').set('x-csrf', '1').send({ variantId: 'nope', quantity: 1 }));
    record('orders-guest', await t.http().get('/orders'));
    record('order-missing', await t.http().get('/orders/ORD-NOPE'));
    record('stream-missing', await t.http().get('/orders/ORD-NOPE/stream'));
    record('metrics', await t.http().get('/metrics'));
    record('dev-outbox', await t.http().get('/dev/outbox'));
    record('suggest-array', await t.http().get('/search/suggest?q=a&q=b'));
    record('suggest-empty', await t.http().get('/search/suggest'));
    record('serviceability-bad', await t.http().get('/catalog/serviceability/12'));
    record('product-missing', await t.http().get('/catalog/products/nope'));
    record('listing-bad-category', await t.http().get('/catalog/listing?categorySlug=nope'));
    record('by-ids-bad', await t.http().post('/catalog/products/by-ids').send({ ids: 'x' }));
    record('by-ids-array-body', await t.http().post('/catalog/products/by-ids').set('content-type', 'application/json').send('[1]'));
    record('webhook-no-sig', await t.http().post('/webhooks/razorpay').send({ a: 1 }));
    record('admin-no-token', await t.http().get('/admin/orders'));
    record('trailing-slash', await t.http().get('/healthz/'));
    record('case-insensitive', await t.http().get('/HEALTHZ'));
    record('docs-page', await t.http().get('/docs'));
    record('docs-page-slash', await t.http().get('/docs/'));
    record('docs-json', Object.assign(await t.http().get('/docs/openapi.json'), { body: { paths: 'omitted' } }));
    record('docs-init-js', await t.http().get('/docs/swagger-ui-init.js'));
    record('docs-bundle-js', await t.http().get('/docs/swagger-ui-bundle.js'));
    record('docs-css', await t.http().get('/docs/swagger-ui.css'));
    record('docs-missing', await t.http().get('/docs/nope.js'));
    record('double-encoded-param', await t.http().get('/catalog/products/%E0%A4%A'));
  });
});
