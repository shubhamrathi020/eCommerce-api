import type { AccountExport, ApiError, CategoryNode, HomeData, ListingResult, Product, ProductSummary, SavedAddress, SearchSuggestions, Session, User } from '@ecom/contracts';
import { type TestApp, createTestApp, resetDatabase } from './test-app';

/**
 * Contract tests (BF-05): the API's responses have exactly the fields of the shared frontend models, no more
 * (nothing internal leaks) and no fewer (nothing the pages rely on is missing). The key lists are typed against
 * the models, so renaming a model field without updating the API fails compilation here.
 */
const USER_KEYS: (keyof User)[] = ['id', 'name', 'email', 'phone', 'roles', 'permissions', 'emailVerified', 'createdAt'];
const SESSION_KEYS: (keyof Session)[] = ['user', 'expiresAt'];
const ADDRESS_KEYS: (keyof SavedAddress)[] = ['id', 'label', 'name', 'phone', 'address', 'isDefault'];
const EXPORT_KEYS: (keyof AccountExport)[] = ['exportedAt', 'profile', 'addresses', 'orderIds'];
const ERROR_KEYS: (keyof ApiError)[] = ['code', 'message', 'fields', 'requestId'];
const PRODUCT_KEYS: (keyof Product)[] = [
  'id', 'slug', 'title', 'brandId', 'brandName', 'categoryId', 'categoryPath', 'description', 'highlights', 'images',
  'attributes', 'variantAxes', 'variants', 'rating', 'tags', 'createdAt', 'popularity', 'slugHistory', 'sellerId', 'seo',
];
const SUMMARY_KEYS: (keyof ProductSummary)[] = [
  'id', 'slug', 'title', 'brandName', 'categoryName', 'image', 'hoverImage', 'priceMin', 'priceMax', 'mrpMin', 'rating',
  'stockStatus', 'stockLeft', 'variantCount', 'quickAddVariantId',
];
const LISTING_KEYS: (keyof ListingResult)[] = ['items', 'total', 'page', 'pageSize', 'facets', 'priceBounds', 'title', 'breadcrumb', 'correctedFrom'];
const HOME_KEYS: (keyof HomeData)[] = ['banners', 'categoryTiles', 'deals', 'rows', 'brands'];
const CATEGORY_NODE_KEYS: (keyof CategoryNode)[] = ['id', 'slug', 'name', 'parentId', 'imageUrl', 'order', 'attributeDefs', 'children'];
const SUGGESTIONS_KEYS: (keyof SearchSuggestions)[] = ['queries', 'products', 'categories', 'brands'];

const keysOf = (o: object) => Object.keys(o).sort();
const within = (actual: object, allowed: string[]) => keysOf(actual).every((k) => allowed.includes(k));

describe('API <-> frontend model contract', () => {
  let t: TestApp;
  beforeAll(async () => (t = await createTestApp()));
  afterAll(() => t.close());
  beforeEach(() => resetDatabase(t.db));

  it('session, user, address and export responses match the shared models exactly', async () => {
    const reg = await t.http().post('/auth/register').send({ name: 'Asha Rao', email: 'asha@example.com', password: 'Str0ngPass' });
    expect(keysOf(reg.body)).toEqual(['accessToken', 'session']);
    expect(keysOf(reg.body.session)).toEqual([...SESSION_KEYS].sort());
    // `phone` is optional and absent until set; everything else is always present.
    expect(keysOf(reg.body.session.user)).toEqual(USER_KEYS.filter((k) => k !== 'phone').sort());

    const token = reg.body.accessToken as string;
    const withPhone = await t.http().patch('/account/profile').set('authorization', `Bearer ${token}`).send({ name: 'Asha', phone: '9876543210' });
    expect(keysOf(withPhone.body)).toEqual([...USER_KEYS].sort());

    const [address] = (await t.http().post('/account/addresses').set('authorization', `Bearer ${token}`).send({ label: 'Home', name: 'Asha', phone: '9876543210', address: { line1: '1 Road', city: 'Pune', state: 'MH', pincode: '411001' } })).body;
    expect(keysOf(address)).toEqual([...ADDRESS_KEYS].sort());
    expect(keysOf(address.address)).toEqual(['city', 'line1', 'pincode', 'state']);

    const exported = (await t.http().get('/account/export').set('authorization', `Bearer ${token}`)).body;
    expect(keysOf(exported)).toEqual([...EXPORT_KEYS].sort());
    expect(within(exported.profile, USER_KEYS.filter((k) => k !== 'permissions'))).toBe(true);
  });

  it('catalog responses (home, listing, product, categories, search) match the shared models exactly', async () => {
    const home = (await t.http().get('/catalog/home')).body;
    expect(keysOf(home)).toEqual([...HOME_KEYS].sort());
    expect(within(home.rows[0].items[0], SUMMARY_KEYS)).toBe(true);

    const listing = (await t.http().get('/catalog/listing').query({ filters: '{}', sort: 'relevance', page: 1, pageSize: 5 })).body;
    expect(within(listing, LISTING_KEYS)).toBe(true);
    expect(within(listing.items[0], SUMMARY_KEYS)).toBe(true);

    const product = (await t.http().get('/catalog/products/northline-signature-linen-relaxed-t-shirt-1')).body.product;
    expect(within(product, PRODUCT_KEYS)).toBe(true);
    expect(keysOf(product)).toEqual(expect.arrayContaining(['id', 'slug', 'title', 'variants']));

    const tree = (await t.http().get('/catalog/categories/tree')).body;
    expect(within(tree[0], CATEGORY_NODE_KEYS)).toBe(true);

    const suggest = (await t.http().get('/search/suggest').query({ q: 'north' })).body;
    expect(keysOf(suggest)).toEqual([...SUGGESTIONS_KEYS].sort());
  });

  it('every error body stays within the ApiError shape', async () => {
    const responses = [await t.http().get('/account/export'), await t.http().post('/auth/login').send({ email: 'a@b.co', password: 'x' }), await t.http().post('/auth/register').send({}), await t.http().get('/no-such-route')];
    for (const res of responses) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(within(res.body, ERROR_KEYS)).toBe(true);
      expect(res.body.code).toEqual(expect.any(String));
      expect(res.body.message).toEqual(expect.any(String));
    }
  });
});
