// Seeds the catalog store (BRD 20, CS-01/CS-02): the same 252 generated products, categories, brands,
// collections, home content and reviews the frontend mock was built against. The JSON fixtures in
// apps/api/seed-data were copied from the frontend repository's mock data when the repositories were split
// (eCommerce: libs/shared/data-access/src/mock/data), so both sides started from one dataset; from then on they
// are independent, and the frontend's `pnpm mock-data` does not update these. Also builds
// the Meilisearch index (CS-03). Safe to re-run: every write is an upsert/replace.
import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MongoClient } from 'mongodb';
import { Meilisearch } from 'meilisearch';
import type { Brand, Category, Collection, Product, Review } from '@ecom/contracts';

config({ path: resolve(import.meta.dirname, '../.env') });

const FIXTURES = resolve(import.meta.dirname, '../seed-data');
const readJson = <T>(name: string): T => JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf-8')) as T;

function toSearchDoc(p: Product) {
  const totalStock = p.variants.reduce((sum, v) => sum + v.stock, 0);
  const cheapest = Math.min(...p.variants.map((v) => v.price.amount));
  const dearest = Math.max(...p.variants.map((v) => v.price.amount));
  const bestDiscount = Math.max(
    ...p.variants.map((v) => (v.mrp && v.mrp.amount > v.price.amount ? Math.round(((v.mrp.amount - v.price.amount) / v.mrp.amount) * 100) : 0)),
  );
  const attrFields: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(p.attributes)) attrFields[`attr_${key}`] = [String(value)];
  for (const axis of p.variantAxes) {
    const values = [...new Set(p.variants.map((v) => v.options[axis]).filter((v): v is string => v !== undefined))];
    if (values.length) attrFields[`attr_${axis}`] = values;
  }
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    brandName: p.brandName,
    brandSlug: p.brandId.replace(/^brand-/, ''),
    categoryId: p.categoryId,
    tags: p.tags,
    priceMin: cheapest,
    priceMax: dearest,
    ratingAverage: p.rating.average,
    bestDiscount,
    totalStock,
    popularity: p.popularity,
    createdAtTs: new Date(p.createdAt).getTime(),
    ...attrFields,
  };
}

async function main(): Promise<void> {
  const mongoUrl = process.env['MONGODB_URL'];
  const meiliUrl = process.env['MEILI_URL'];
  if (!mongoUrl || !meiliUrl) throw new Error('MONGODB_URL and MEILI_URL are not set (copy apps/api/.env.example to apps/api/.env)');
  const dbName = process.env['MONGODB_DB_NAME'] ?? 'ecommerce_catalog';
  const meiliIndexSuffix = process.env['NODE_ENV'] === 'test' ? '_test' : '';

  const [products, categories, brands, collections, home, reviews] = await Promise.all([
    readJson<Product[]>('products.json'),
    readJson<Category[]>('categories.json'),
    readJson<Brand[]>('brands.json'),
    readJson<Collection[]>('collections.json'),
    readJson<{ banners: unknown[]; categoryTiles: unknown[] }>('home.json'),
    readJson<Review[]>('reviews.json'),
  ]);

  const client = new MongoClient(mongoUrl);
  await client.connect();
  try {
    const db = client.db(dbName);
    const productDocs = products.map((p) => ({ ...p, _id: p.id, status: 'published' as const, updatedAt: new Date().toISOString() }));
    await db.collection('products').deleteMany({});
    await db.collection('products').insertMany(productDocs);
    await db.collection('categories').deleteMany({});
    await db.collection('categories').insertMany(categories.map((c) => ({ ...c, _id: c.id })));
    await db.collection('brands').deleteMany({});
    await db.collection('brands').insertMany(brands.map((b) => ({ ...b, _id: b.id })));
    await db.collection('collections').deleteMany({});
    await db.collection('collections').insertMany(collections.map((c) => ({ ...c, _id: c.id })));
    await db.collection('reviews').deleteMany({});
    await db.collection('reviews').insertMany(reviews.map((r) => ({ ...r, _id: r.id })));
    await db.collection('home').replaceOne({ _id: 'home' }, { _id: 'home', ...home }, { upsert: true });
    console.log(`Mongo: ${productDocs.length} products, ${categories.length} categories, ${brands.length} brands, ${collections.length} collections, ${reviews.length} reviews`);

    // Every attribute/variant-axis key across the whole catalog, so Meilisearch's index settings declare
    // every `attr_<key>` field as filterable up front (see SearchService.ensureIndex).
    const attrKeys = new Set<string>();
    for (const c of categories) for (const def of c.attributeDefs ?? []) attrKeys.add(def.key);
    for (const p of products) {
      for (const key of Object.keys(p.attributes)) attrKeys.add(key);
      for (const axis of p.variantAxes) attrKeys.add(axis);
    }
    const attrFields = [...attrKeys].map((k) => `attr_${k}`);

    const meili = new Meilisearch({ host: meiliUrl, apiKey: process.env['MEILI_MASTER_KEY'] || undefined });
    const indexName = `products${meiliIndexSuffix}`;
    const createTask = await meili.createIndex(indexName, { primaryKey: 'id' });
    await meili.tasks.waitForTask(createTask.taskUid).catch(() => undefined);
    const index = meili.index(indexName);
    const numeric = ['priceMin', 'priceMax', 'ratingAverage', 'bestDiscount', 'totalStock', 'popularity', 'createdAtTs'];
    const SYNONYM_GROUPS: string[][] = [
      ['tee', 'tshirt'],
      ['mobile', 'phone', 'smartphone', 'cellphone'],
      ['laptop', 'notebook', 'ultrabook'],
      ['tv', 'television'],
      ['sofa', 'couch'],
      ['sneaker', 'shoe', 'trainer'],
      ['earbud', 'earphone', 'headphone'],
      ['bag', 'backpack'],
      ['kid', 'child'],
      ['jean', 'denim'],
    ];
    await index.updateSettings({
      searchableAttributes: ['title', 'brandName', 'tags', ...attrFields],
      filterableAttributes: ['categoryId', 'brandSlug', 'tags', ...numeric, ...attrFields],
      sortableAttributes: numeric,
      synonyms: Object.fromEntries(SYNONYM_GROUPS.flatMap((group) => group.map((word) => [word, group.filter((w) => w !== word)]))),
    });
    await index.deleteAllDocuments();
    const docs = products.map(toSearchDoc);
    const BATCH = 500;
    for (let i = 0; i < docs.length; i += BATCH) {
      const task = await index.addDocuments(docs.slice(i, i + BATCH));
      await meili.tasks.waitForTask(task.taskUid);
    }
    console.log(`Meilisearch: indexed ${docs.length} products into "${indexName}"`);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
