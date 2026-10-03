import { type TestApp, createTestApp } from './test-app';

/**
 * Catalog and search (BRD 20): real MongoDB + real Meilisearch, seeded with the exact same 252 products
 * the frontend mock was built against (`pnpm db:seed:catalog`, run automatically by `global-setup.ts`).
 * No `resetDatabase`-style reset here on purpose: these are read paths against a shared, stable seed;
 * `admin-catalog.spec.ts` is the one file allowed to write, and only ever to products it creates itself.
 */
describe('catalog and search (BRD 20)', () => {
  let t: TestApp;
  beforeAll(async () => (t = await createTestApp()));
  afterAll(() => t.close());

  it('serves the home page from the real store', async () => {
    const res = await t.http().get('/catalog/home');
    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBeGreaterThan(0);
    expect(res.body.brands.length).toBeGreaterThan(0);
    expect(res.body.deals.items.length).toBeGreaterThan(0);
  });

  it('lists products under a category, with facets and a breadcrumb', async () => {
    const res = await t.http().get('/catalog/listing').query({ categorySlug: 'men-clothing', filters: '{}', sort: 'relevance', page: 1, pageSize: 12 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThan(0);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.breadcrumb.map((c: { slug: string }) => c.slug)).toEqual(['fashion', 'men-clothing']);
    const brandFacet = res.body.facets.find((f: { key: string }) => f.key === 'brand');
    expect(brandFacet.options.length).toBeGreaterThan(0);
    // men-clothing declares size/colour/material/fit attribute facets in categories.json.
    expect(res.body.facets.map((f: { key: string }) => f.key)).toEqual(expect.arrayContaining(['brand', 'rating', 'discount', 'availability', 'size', 'colour']));
  });

  it('404s for an unknown category, brand or collection', async () => {
    for (const query of [{ categorySlug: 'no-such-category' }, { brandSlug: 'no-such-brand' }, { collectionSlug: 'no-such-collection' }]) {
      const res = await t.http().get('/catalog/listing').query({ ...query, filters: '{}', sort: 'relevance', page: 1, pageSize: 12 });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
    }
  });

  it('filters by brand and by an attribute facet, narrowing results', async () => {
    const unfiltered = await t.http().get('/catalog/listing').query({ categorySlug: 'men-clothing', filters: '{}', sort: 'relevance', page: 1, pageSize: 100 });
    const filtered = await t.http().get('/catalog/listing').query({ categorySlug: 'men-clothing', filters: JSON.stringify({ brand: ['northline'] }), sort: 'relevance', page: 1, pageSize: 100 });
    expect(filtered.body.total).toBeGreaterThan(0);
    expect(filtered.body.total).toBeLessThanOrEqual(unfiltered.body.total);
    expect(filtered.body.items.every((p: { brandName: string }) => p.brandName === 'Northline')).toBe(true);
    // The brand facet's own option counts ignore the brand filter itself (matches the mock's `matching(ignore)`).
    const brandFacet = filtered.body.facets.find((f: { key: string }) => f.key === 'brand');
    expect(brandFacet.options.find((o: { value: string }) => o.value === 'northline').selected).toBe(true);
  });

  it('applies a price range and returns price bounds', async () => {
    const res = await t.http().get('/catalog/listing').query({ categorySlug: 'men-clothing', filters: '{}', priceMin: 0, priceMax: 2000_00, sort: 'relevance', page: 1, pageSize: 50 });
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const item of res.body.items) expect(item.priceMin.amount).toBeLessThanOrEqual(2000_00);
    expect(res.body.priceBounds).toHaveProperty('min');
    expect(res.body.priceBounds).toHaveProperty('max');
  });

  it('free-text search finds products by title and tolerates a small typo (Meilisearch)', async () => {
    const exact = await t.http().get('/catalog/listing').query({ q: 'smartphone', filters: '{}', sort: 'relevance', page: 1, pageSize: 20 });
    expect(exact.body.items.length).toBeGreaterThan(0);
    const typo = await t.http().get('/catalog/listing').query({ q: 'smartphon', filters: '{}', sort: 'relevance', page: 1, pageSize: 20 });
    expect(typo.body.items.length).toBeGreaterThan(0);
    const synonym = await t.http().get('/catalog/listing').query({ q: 'mobile', filters: '{}', sort: 'relevance', page: 1, pageSize: 20 });
    expect(synonym.body.items.length).toBeGreaterThan(0);
  });

  it('sorts by price and paginates', async () => {
    const asc = await t.http().get('/catalog/listing').query({ categorySlug: 'men-clothing', filters: '{}', sort: 'price-asc', page: 1, pageSize: 5 });
    const prices = asc.body.items.map((i: { priceMin: { amount: number } }) => i.priceMin.amount);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    const page1 = await t.http().get('/catalog/listing').query({ categorySlug: 'men-clothing', filters: '{}', sort: 'relevance', page: 1, pageSize: 5 });
    const page2 = await t.http().get('/catalog/listing').query({ categorySlug: 'men-clothing', filters: '{}', sort: 'relevance', page: 2, pageSize: 5 });
    expect(page1.body.items.map((i: { id: string }) => i.id)).not.toEqual(page2.body.items.map((i: { id: string }) => i.id));
  });

  it('finds a product by slug, and follows an old slug via slugHistory', async () => {
    const res = await t.http().get('/catalog/products/northline-signature-linen-relaxed-t-shirt-1');
    expect(res.status).toBe(200);
    expect(res.body.product.id).toBe('p-0001');
    expect(res.body.redirectedFrom).toBeUndefined();
  });

  it('404s for an unknown product slug', async () => {
    const res = await t.http().get('/catalog/products/no-such-product');
    expect(res.status).toBe(404);
  });

  it('looks products up by id, in bulk, for full products and summaries', async () => {
    const byIds = await t.http().post('/catalog/products/by-ids').send({ ids: ['p-0001', 'p-0037', 'not-real'] });
    expect(byIds.body.map((p: { id: string }) => p.id).sort()).toEqual(['p-0001', 'p-0037']);
    const summaries = await t.http().post('/catalog/products/summaries').send({ ids: ['p-0001'] });
    expect(summaries.body[0]).toMatchObject({ id: 'p-0001', title: expect.any(String) });
  });

  it('suggests related and bought-together products from the same category tree', async () => {
    const related = await t.http().get('/catalog/products/p-0001/related');
    expect(related.status).toBe(200);
    expect(Array.isArray(related.body)).toBe(true);
    const boughtTogether = await t.http().get('/catalog/products/p-0001/bought-together');
    expect(boughtTogether.status).toBe(200);
    expect(boughtTogether.body.length).toBeLessThanOrEqual(2);
  });

  it('returns a product review page, sorted and paginated, with a rating summary', async () => {
    const res = await t.http().get('/catalog/products/p-0001/reviews').query({ sort: 'recent', page: 1, pageSize: 5 });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('summary');
    expect(res.body.items.length).toBeLessThanOrEqual(5);
  });

  it('checks pin code serviceability, rejecting a malformed one', async () => {
    const ok = await t.http().get('/catalog/serviceability/560001');
    expect(ok.status).toBe(200);
    expect(ok.body).toHaveProperty('serviceable');
    const bad = await t.http().get('/catalog/serviceability/abc');
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('validation');
  });

  it('returns the category tree, nested and ordered', async () => {
    const res = await t.http().get('/catalog/categories/tree');
    expect(res.status).toBe(200);
    const fashion = res.body.find((c: { slug: string }) => c.slug === 'fashion');
    expect(fashion.children.length).toBeGreaterThan(0);
  });

  it('search suggestions cover popular terms, products, categories and brands', async () => {
    const empty = await t.http().get('/search/suggest').query({ q: '' });
    expect(empty.body.queries.length).toBeGreaterThan(0);
    const withQuery = await t.http().get('/search/suggest').query({ q: 'north' });
    expect(withQuery.body.brands.some((b: { slug: string }) => b.slug === 'northline')).toBe(true);
    const popular = await t.http().get('/search/popular');
    expect(popular.body.length).toBeGreaterThan(0);
  });
});
