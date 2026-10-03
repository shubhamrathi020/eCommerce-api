import { Injectable } from '@nestjs/common';
import type {
  AdminCategoryOption,
  AdminProductDetail,
  AdminProductInput,
  AdminProductQuery,
  AdminProductRow,
  AdminVariantInput,
  Paged,
  Product,
  ProductStatus,
  Variant,
} from '@ecom/contracts';
import { AppError, assertNoFieldErrors } from '../common/app-error';
import { CacheService } from '../cache/cache.service';
import { toSearchDoc } from './catalog.mapper';
import type { ProductDoc } from './catalog.types';
import { MongoService } from './mongo.service';
import { SearchService } from './search.service';

const inr = (amount: number) => ({ amount: Math.round(amount), currency: 'INR' as const });
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const paragraphs = (text: string) =>
  text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${escapeHtml(p)}</p>`).join('');
const plainText = (html: string) => html.replace(/<\/p>\s*<p>/g, '\n\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const nowIso = () => new Date().toISOString();

function validateInput(input: AdminProductInput, categoryIds: Set<string>, others: Variant[]): void {
  const fields: Record<string, string> = {};
  if (!input.title.trim()) fields['title'] = 'Title is required';
  else if (input.title.length > 120) fields['title'] = 'Title is too long (120 characters at most)';
  if (!input.brandName.trim()) fields['brandName'] = 'Brand is required';
  if (!categoryIds.has(input.categoryId)) fields['categoryId'] = 'Choose a category';
  if (input.description.length > 2000) fields['description'] = 'Description is too long (2,000 characters at most)';
  if (input.variants.length === 0) fields['variants'] = 'Add at least one variant';
  const skus = new Set<string>();
  input.variants.forEach((v, i) => {
    if (!v.sku.trim()) fields[`variants.${i}.sku`] = 'SKU is required';
    else if (skus.has(v.sku.trim()) || others.some((o) => o.sku === v.sku.trim() && o.id !== v.id)) fields[`variants.${i}.sku`] = 'SKU must be unique';
    skus.add(v.sku.trim());
    if (!(v.price > 0)) fields[`variants.${i}.price`] = 'Price must be greater than zero';
    if (v.mrp !== undefined && v.mrp < v.price) fields[`variants.${i}.mrp`] = 'MRP cannot be lower than the price';
    if (!Number.isInteger(v.stock) || v.stock < 0) fields[`variants.${i}.stock`] = 'Stock must be a whole number, 0 or more';
  });
  assertNoFieldErrors(fields);
}

function buildVariants(productId: string, input: AdminProductInput, existing: Variant[]): Variant[] {
  return input.variants.map((v: AdminVariantInput, i) => {
    const previous = existing.find((e) => e.id === v.id);
    return {
      id: previous?.id ?? `${productId}-v${Date.now().toString(36)}${i}`,
      sku: v.sku.trim(),
      options: v.options,
      price: inr(v.price),
      ...(v.mrp && v.mrp > v.price ? { mrp: inr(v.mrp) } : {}),
      // No stock ledger on the real backend yet (BRD 21/22 territory); the admin form's number is the
      // direct source of truth in Mongo, unlike the mock's opening-movement dance through a ledger.
      stock: v.stock,
      ...(previous?.images ? { images: previous.images } : {}),
    };
  });
}

function toRow(doc: ProductDoc): AdminProductRow {
  const price = Math.min(...doc.variants.map((v) => v.price.amount));
  const stock = doc.variants.reduce((s, v) => s + v.stock, 0);
  return {
    id: doc.id,
    slug: doc.slug,
    title: doc.title,
    brandName: doc.brandName,
    categoryName: doc.categoryPath[doc.categoryPath.length - 1].name,
    status: doc.status,
    priceMin: inr(price),
    stockTotal: stock,
    variantCount: doc.variants.length,
    image: doc.images[0],
    updatedAt: doc.updatedAt,
  };
}

function toDetail(doc: ProductDoc): AdminProductDetail {
  return {
    id: doc.id,
    slug: doc.slug,
    title: doc.title,
    brandName: doc.brandName,
    categoryId: doc.categoryId,
    categoryName: doc.categoryPath[doc.categoryPath.length - 1].name,
    description: plainText(doc.description),
    highlights: doc.highlights,
    tags: doc.tags,
    status: doc.status,
    variantAxes: doc.variantAxes,
    updatedAt: doc.updatedAt,
    variants: doc.variants.map((v) => ({ id: v.id, sku: v.sku, options: v.options, price: v.price.amount, ...(v.mrp ? { mrp: v.mrp.amount } : {}), stock: v.stock })),
  };
}

/** Back-office product management (CS-01, CS-07): the same Mongo store the shop reads, plus keeping
 * Meilisearch in sync on every write (published in, anything else out) — a direct write-through rather
 * than the outbox-and-queue pattern CS-03 describes, since BRD 23 (messaging) has not landed yet; noted
 * as a scoped-down simplification, not a silent gap (see brds/20-catalog-search-services.md). */
@Injectable()
export class AdminCatalogService {
  constructor(
    private readonly mongo: MongoService,
    private readonly search: SearchService,
    private readonly cache: CacheService,
  ) {}

  private async syncIndex(doc: ProductDoc): Promise<void> {
    if (doc.status === 'published') {
      const { _id, status, updatedAt, ...product } = doc;
      await this.search.indexProducts([toSearchDoc(product as Product)]);
    } else {
      await this.search.deleteProduct(doc.id).catch(() => undefined);
    }
    // Every cached view of this product, plus the broad home/listing bucket (BRD 22, CR-01): a status
    // or price change can move this product in or out of listings the cache has no per-entry record of.
    await Promise.all([this.cache.invalidateTag(`product:${doc.id}`), this.cache.invalidateTag('catalog:listings')]);
  }

  async list(query: AdminProductQuery): Promise<Paged<AdminProductRow>> {
    const q = query.q?.trim().toLowerCase();
    let rows = await this.mongo.products.find(query.status ? { status: query.status } : {}).toArray();
    if (q) rows = rows.filter((d) => `${d.title} ${d.brandName} ${d.variants.map((v) => v.sku).join(' ')}`.toLowerCase().includes(q));
    const price = (d: ProductDoc) => Math.min(...d.variants.map((v) => v.price.amount));
    const stock = (d: ProductDoc) => d.variants.reduce((s, v) => s + v.stock, 0);
    const cmp: Record<AdminProductQuery['sort'], (a: ProductDoc, b: ProductDoc) => number> = {
      updated: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
      title: (a, b) => a.title.localeCompare(b.title),
      price: (a, b) => price(a) - price(b),
      stock: (a, b) => stock(a) - stock(b),
    };
    rows = [...rows].sort((a, b) => (cmp[query.sort](a, b) || a.id.localeCompare(b.id)) * (query.dir === 'asc' ? 1 : -1));
    const pageSize = Math.max(1, query.pageSize);
    const page = Math.min(Math.max(1, query.page), Math.max(1, Math.ceil(rows.length / pageSize)));
    return { total: rows.length, page, pageSize, items: rows.slice((page - 1) * pageSize, page * pageSize).map(toRow) };
  }

  async categories(): Promise<AdminCategoryOption[]> {
    return (await this.mongo.categories.find({ parentId: { $exists: true } }).toArray()).map((c) => ({ id: c.id, name: c.name }));
  }

  async get(id: string): Promise<AdminProductDetail> {
    const doc = await this.mongo.products.findOne({ id });
    if (!doc) throw new AppError('not_found', 'Product not found');
    return toDetail(doc);
  }

  async create(input: AdminProductInput): Promise<AdminProductDetail> {
    const categories = await this.mongo.categories.find().toArray();
    const leafIds = new Set(categories.filter((c) => c.parentId).map((c) => c.id));
    const existingVariants = (await this.mongo.products.find({}, { projection: { variants: 1 } }).toArray()).flatMap((p) => p.variants);
    validateInput(input, leafIds, existingVariants);
    const leaf = categories.find((c) => c.id === input.categoryId);
    const parent = categories.find((c) => c.id === leaf?.parentId);
    if (!leaf || !parent) throw new AppError('validation', 'Choose a category', { categoryId: 'Choose a category' });
    // No media upload pipeline yet (CS-05, deferred); a same-category product's images stand in, exactly
    // as the mock does, until real uploads exist.
    const donor = await this.mongo.products.findOne({ categoryId: leaf.id });
    const anyProduct = donor ?? (await this.mongo.products.findOne({}));
    if (!anyProduct) throw new AppError('conflict', 'Catalog is empty; seed it before creating products.');
    const id = `p-new-${Date.now().toString(36)}`;
    const doc: ProductDoc = {
      _id: id,
      id,
      slug: `${slugify(input.title)}-${id.slice(-4)}`,
      title: input.title.trim(),
      brandId: `brand-${slugify(input.brandName)}`,
      brandName: input.brandName.trim(),
      categoryId: leaf.id,
      categoryPath: [
        { id: parent.id, slug: parent.slug, name: parent.name },
        { id: leaf.id, slug: leaf.slug, name: leaf.name },
      ],
      description: paragraphs(input.description),
      highlights: input.highlights,
      images: anyProduct.images,
      attributes: {},
      variantAxes: Object.keys(input.variants[0].options),
      variants: buildVariants(id, input, []),
      rating: { average: 0, count: 0, distribution: [0, 0, 0, 0, 0] },
      tags: input.tags,
      createdAt: nowIso(),
      popularity: 0,
      status: input.status,
      updatedAt: nowIso(),
    };
    await this.mongo.products.insertOne(doc);
    await this.syncIndex(doc);
    return toDetail(doc);
  }

  async update(id: string, input: AdminProductInput): Promise<AdminProductDetail> {
    const existing = await this.mongo.products.findOne({ id });
    if (!existing) throw new AppError('not_found', 'Product not found');
    const categories = await this.mongo.categories.find().toArray();
    const leafIds = new Set(categories.filter((c) => c.parentId).map((c) => c.id));
    const others = await this.mongo.products.find({ id: { $ne: id } }).toArray();
    validateInput(input, leafIds, others.flatMap((o) => o.variants));
    const updated: ProductDoc = {
      ...existing,
      title: input.title.trim(),
      brandName: input.brandName.trim(),
      description: paragraphs(input.description),
      highlights: input.highlights,
      tags: input.tags,
      variants: buildVariants(existing.id, input, existing.variants),
      status: input.status,
      updatedAt: nowIso(),
    };
    await this.mongo.products.replaceOne({ id }, updated);
    await this.syncIndex(updated);
    return toDetail(updated);
  }

  async bulkSetStatus(ids: string[], status: ProductStatus): Promise<number> {
    const targets = await this.mongo.products.find({ id: { $in: ids } }).toArray();
    if (targets.length === 0) return 0;
    await this.mongo.products.updateMany({ id: { $in: targets.map((t) => t.id) } }, { $set: { status, updatedAt: nowIso() } });
    await Promise.all(targets.map((t) => this.syncIndex({ ...t, status, updatedAt: nowIso() })));
    return targets.length;
  }

  async bulkDeleteDrafts(ids: string[]): Promise<number> {
    const drafts = await this.mongo.products.find({ id: { $in: ids }, status: 'draft' }).toArray();
    if (drafts.length === 0) return 0;
    await this.mongo.products.deleteMany({ id: { $in: drafts.map((d) => d.id) } });
    await Promise.all([
      ...drafts.map((d) => this.search.deleteProduct(d.id).catch(() => undefined)),
      ...drafts.map((d) => this.cache.invalidateTag(`product:${d.id}`)),
      this.cache.invalidateTag('catalog:listings'),
    ]);
    return drafts.length;
  }
}
