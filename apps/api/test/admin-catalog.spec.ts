import jwt from 'jsonwebtoken';
import { SearchService } from '../src/app/catalog/search.service';
import { type TestApp, createTestApp } from './test-app';

const ACCESS_SECRET = 'test-access-secret-that-is-at-least-32-chars';
const adminToken = () => jwt.sign({ sub: 'admin-1', roles: ['admin'], permissions: ['product:read', 'product:write'] }, ACCESS_SECRET, { audience: 'ecom-api', issuer: 'ecom-api', expiresIn: '5m' });
const readOnlyToken = () => jwt.sign({ sub: 'staff-1', roles: [], permissions: ['product:read'] }, ACCESS_SECRET, { audience: 'ecom-api', issuer: 'ecom-api', expiresIn: '5m' });

const validInput = (over: Record<string, unknown> = {}) => ({
  title: 'Test-only Admin Product',
  brandName: 'Test Brand',
  categoryId: 'cat-men-clothing',
  description: 'A product created only by admin-catalog.spec.ts.',
  highlights: ['Highlight one'],
  tags: ['test-fixture'],
  status: 'draft',
  variants: [{ sku: `TESTSKU-${Date.now()}`, options: { size: 'M', colour: 'Black' }, price: 999_00, stock: 3 }],
  ...over,
});

/**
 * Admin product management (BRD 06's `AdminProductApi`, now against the real catalog store, BRD 20).
 * Every test creates its own product(s) and deletes them again (or lets `bulkDeleteDrafts` do it) —
 * never touches the shared 252-product seed that `catalog.spec.ts` also reads.
 */
describe('admin catalog management (BRD 20)', () => {
  let t: TestApp;
  const as = (token: string) => ({
    get: (path: string, query: object = {}) => t.http().get(path).query(query).set('authorization', `Bearer ${token}`),
    post: (path: string, body?: object) => t.http().post(path).set('authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => t.http().put(path).set('authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => t.http().patch(path).set('authorization', `Bearer ${token}`).send(body),
  });

  beforeAll(async () => (t = await createTestApp()));
  afterAll(() => t.close());

  it('needs product:read/product:write; a signed-in user without them is refused', async () => {
    const anon = await t.http().get('/admin/products');
    expect(anon.body.code).toBe('unauthorized');
    const noPerm = jwt.sign({ sub: 'x', roles: [], permissions: [] }, ACCESS_SECRET, { audience: 'ecom-api', issuer: 'ecom-api', expiresIn: '5m' });
    const forbidden = await as(noPerm).get('/admin/products');
    expect(forbidden.status).toBe(403);
    const readOnlyWrite = await as(readOnlyToken()).post('/admin/products', validInput());
    expect(readOnlyWrite.status).toBe(403);
  });

  it('lists leaf categories to choose from', async () => {
    const res = await as(adminToken()).get('/admin/products/categories');
    expect(res.status).toBe(200);
    expect(res.body.some((c: { id: string }) => c.id === 'cat-men-clothing')).toBe(true);
  });

  it('validates a new product and reports every field problem at once', async () => {
    const res = await as(adminToken()).post('/admin/products', validInput({ title: '', brandName: '', categoryId: 'no-such-category', variants: [] }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation');
    expect(Object.keys(res.body.fields)).toEqual(expect.arrayContaining(['title', 'brandName', 'categoryId', 'variants']));
  });

  it('creates, reads, updates and deletes a draft product end to end, syncing (or not) with Meilisearch', async () => {
    const admin = as(adminToken());
    const created = await admin.post('/admin/products', validInput());
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: 'Test-only Admin Product', status: 'draft', variantAxes: ['size', 'colour'] });
    const id = created.body.id as string;

    // A draft is never in the shopper-facing catalog or the search index.
    const asShopper = await t.http().get(`/catalog/products/${created.body.slug}`);
    expect(asShopper.status).toBe(404);
    const search = t.app.get(SearchService);
    const found = await search.suggestProducts('Test-only Admin Product', 5);
    expect(found).not.toContain(id);

    const got = await admin.get(`/admin/products/${id}`);
    expect(got.body.id).toBe(id);

    const updated = await admin.put(`/admin/products/${id}`, validInput({ title: 'Test-only Admin Product (edited)', status: 'published' }));
    expect(updated.body.title).toBe('Test-only Admin Product (edited)');
    expect(updated.body.status).toBe('published');

    // Publishing indexes it into Meilisearch and makes it visible to shoppers.
    await new Promise((r) => setTimeout(r, 300)); // Meilisearch indexing is asynchronous even after the task resolves
    const nowShopper = await t.http().get(`/catalog/products/${updated.body.slug}`);
    expect(nowShopper.status).toBe(200);
    const nowFound = await search.suggestProducts('Test-only Admin Product', 5);
    expect(nowFound).toContain(id);

    // Set back to draft (removes it from the index again) and clean up.
    const setDraft = await admin.patch('/admin/products/bulk-status', { ids: [id], status: 'draft' });
    expect(setDraft.body.count).toBe(1);
    const deleted = await admin.patch('/admin/products/bulk-delete-drafts', { ids: [id] });
    expect(deleted.body.count).toBe(1);
    expect((await admin.get(`/admin/products/${id}`)).status).toBe(404);
  });

  it('rejects a duplicate SKU across products', async () => {
    const admin = as(adminToken());
    const sku = `DUPSKU-${Date.now()}`;
    const first = await admin.post('/admin/products', validInput({ variants: [{ sku, options: { size: 'M', colour: 'Black' }, price: 100_00, stock: 1 }] }));
    try {
      const second = await admin.post('/admin/products', validInput({ variants: [{ sku, options: { size: 'L', colour: 'White' }, price: 200_00, stock: 1 }] }));
      expect(second.status).toBe(400);
      expect(second.body.fields).toHaveProperty('variants.0.sku');
    } finally {
      await admin.patch('/admin/products/bulk-delete-drafts', { ids: [first.body.id] });
    }
  });

  it('bulk-sets status for several products at once, skipping unknown ids', async () => {
    const admin = as(adminToken());
    const a = await admin.post('/admin/products', validInput());
    const b = await admin.post('/admin/products', validInput());
    try {
      const res = await admin.patch('/admin/products/bulk-status', { ids: [a.body.id, b.body.id, 'not-a-real-id'], status: 'archived' });
      expect(res.body.count).toBe(2);
      expect((await admin.get(`/admin/products/${a.body.id}`)).body.status).toBe('archived');
    } finally {
      await admin.patch('/admin/products/bulk-status', { ids: [a.body.id, b.body.id], status: 'draft' });
      await admin.patch('/admin/products/bulk-delete-drafts', { ids: [a.body.id, b.body.id] });
    }
  });

  it('bulk-delete-drafts only ever deletes drafts, never a published product', async () => {
    const admin = as(adminToken());
    const published = await admin.post('/admin/products', validInput({ status: 'published' }));
    try {
      const res = await admin.patch('/admin/products/bulk-delete-drafts', { ids: [published.body.id] });
      expect(res.body.count).toBe(0);
      expect((await admin.get(`/admin/products/${published.body.id}`)).status).toBe(200);
    } finally {
      await admin.patch('/admin/products/bulk-status', { ids: [published.body.id], status: 'draft' });
      await admin.patch('/admin/products/bulk-delete-drafts', { ids: [published.body.id] });
    }
  });
});
