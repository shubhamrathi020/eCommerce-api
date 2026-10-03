import { Injectable } from '@nestjs/common';
import type {
  AttributeDef,
  CategoryNode,
  CategoryRef,
  Facet,
  FacetOption,
  HomeData,
  ListingQuery,
  ListingResult,
  Product,
  ProductSummary,
  Review,
  ReviewPage,
  ReviewQuery,
  Serviceability,
} from '@ecom/contracts';
import { bestDiscount, computeServiceability, sortProducts, stockStatusOf, toSummary } from '@ecom/contracts';
import type { WithId } from 'mongodb';
import { createHash } from 'node:crypto';
import { AppError } from '../common/app-error';
import { CacheService } from '../cache/cache.service';
import { MongoService } from './mongo.service';
import { SearchService } from './search.service';
import type { BrandDoc, CategoryDoc, ProductDoc, ReviewDoc } from './catalog.types';

const RATING_STEPS = [4, 3, 2, 1];
const DISCOUNT_STEPS = [10, 25, 40];
/** Every home/listing entry carries this tag, so any catalog write can invalidate all of them at once
 * without tracking exactly which listing queries happened to include the changed product (BRD 22, CR-01) —
 * correct always, occasionally clears a little more than strictly necessary. A single product's own page
 * (`catalog:product:<slug>`) is invalidated precisely, by its own id. */
const LISTINGS_TAG = 'catalog:listings';

/** Deterministic JSON: object keys sorted recursively, so two logically-identical queries (whatever
 * order their fields/filters happened to be built in) produce the same cache key. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function leafIdsUnder(category: CategoryDoc, categories: CategoryDoc[]): Set<string> {
  const children = categories.filter((c) => c.parentId === category.id);
  return new Set(children.length ? children.map((c) => c.id) : [category.id]);
}

@Injectable()
export class CatalogService {
  constructor(
    private readonly mongo: MongoService,
    private readonly search: SearchService,
    private readonly cache: CacheService,
  ) {}

  /** Strips the admin-only `_id`/`status`/`updatedAt` fields so nothing but the `Product` contract itself
   * ever reaches a shopper-facing response (see the doc comment on `ProductDoc`). */
  private toProduct(doc: ProductDoc): Product {
    const { _id, status, updatedAt, ...rest } = doc;
    return rest;
  }

  private async allProducts(): Promise<Product[]> {
    const docs = await this.mongo.products.find({ status: 'published' }).toArray();
    return docs.map((d) => this.toProduct(d));
  }

  home(): Promise<HomeData> {
    return this.cache.getOrSet('catalog:home', 60, [LISTINGS_TAG], () => this.homeUncached());
  }

  private async homeUncached(): Promise<HomeData> {
    const [products, brands, homeDoc] = await Promise.all([
      this.allProducts(),
      this.mongo.brands.find().sort({ name: 1 }).limit(12).toArray(),
      this.mongo.home.findOne({ _id: 'home' }),
    ]);
    const inStock = products.filter((p) => stockStatusOf(p).status !== 'out_of_stock');
    const summaries = (list: Product[], n: number) => list.slice(0, n).map(toSummary);
    const endOfDay = new Date();
    endOfDay.setUTCHours(23, 59, 59, 0);
    const deals = [...inStock].sort((a, b) => bestDiscount(b) - bestDiscount(a));
    return {
      banners: (homeDoc?.banners as HomeData['banners']) ?? [],
      categoryTiles: (homeDoc?.categoryTiles as HomeData['categoryTiles']) ?? [],
      deals: { endsAt: endOfDay.toISOString(), items: summaries(deals, 10) },
      rows: [
        { key: 'featured', title: 'Featured for you', items: summaries(sortProducts(inStock, 'featured'), 12) },
        { key: 'new', title: 'New arrivals', link: '/collections/trending', items: summaries(sortProducts(inStock, 'newest'), 12) },
        { key: 'best', title: 'Top rated', items: summaries(sortProducts(inStock.filter((p) => p.rating.count >= 5), 'rating'), 12) },
      ],
      brands: brands.map(({ _id, ...b }: WithId<BrandDoc>) => b),
    };
  }

  listing(query: ListingQuery): Promise<ListingResult> {
    // A stable key regardless of key order in `query.filters` — two requests for "the same" listing must
    // always hit the same cache entry, or the cache is useless.
    const key = `catalog:listing:${createHash('sha256').update(stableStringify(query)).digest('hex')}`;
    return this.cache.getOrSet(key, 30, [LISTINGS_TAG], () => this.listingUncached(query));
  }

  private async listingUncached(query: ListingQuery): Promise<ListingResult> {
    const categories = await this.mongo.categories.find().toArray();
    const scope: string[] = [];
    let heading = 'All products';
    let breadcrumb: CategoryRef[] = [];
    let attributeDefs: AttributeDef[] = [];

    if (query.categorySlug) {
      const category = categories.find((c) => c.slug === query.categorySlug);
      if (!category) throw new AppError('not_found', 'Category not found');
      const ids = leafIdsUnder(category, categories);
      scope.push(`categoryId IN [${[...ids].map((id) => JSON.stringify(id)).join(',')}]`);
      heading = category.name;
      const parent = category.parentId ? categories.find((c) => c.id === category.parentId) : undefined;
      breadcrumb = [...(parent ? [{ id: parent.id, slug: parent.slug, name: parent.name }] : []), { id: category.id, slug: category.slug, name: category.name }];
      if (category.attributeDefs) attributeDefs = category.attributeDefs.filter((d) => d.filterable);
    }
    if (query.brandSlug) {
      const brand = await this.mongo.brands.findOne({ slug: query.brandSlug });
      if (!brand) throw new AppError('not_found', 'Brand not found');
      scope.push(`brandSlug = ${JSON.stringify(query.brandSlug)}`);
      heading = brand.name;
    }
    if (query.collectionSlug) {
      const collection = await this.mongo.collections.findOne({ slug: query.collectionSlug });
      if (!collection) throw new AppError('not_found', 'Collection not found');
      scope.push(`tags = ${JSON.stringify(collection.tag)}`);
      heading = collection.name;
    }

    const sel = query.filters;
    type Group = { field: string; buildFilter: (values: string[]) => string; kind: 'categorical' } | { field: string; steps: number[]; op: string; kind: 'threshold' };
    const groups: Record<string, Group> = {
      brand: { field: 'brandSlug', kind: 'categorical', buildFilter: (v) => `brandSlug IN [${v.map((x) => JSON.stringify(x)).join(',')}]` },
      rating: { field: 'ratingAverage', kind: 'threshold', steps: RATING_STEPS, op: '>=' },
      discount: { field: 'bestDiscount', kind: 'threshold', steps: DISCOUNT_STEPS, op: '>=' },
      availability: { field: 'totalStock', kind: 'threshold', steps: [1], op: '>=' },
    };
    for (const def of attributeDefs) groups[def.key] = { field: `attr_${def.key}`, kind: 'categorical', buildFilter: (v) => `attr_${def.key} IN [${v.map((x) => JSON.stringify(x)).join(',')}]` };

    const facetFilters: { filter: string; field: string }[] = [];
    for (const [key, group] of Object.entries(groups)) {
      const chosen = sel[key];
      if (!chosen?.length) continue;
      if (group.kind === 'categorical') facetFilters.push({ filter: group.buildFilter(chosen), field: group.field });
      else {
        const min = Math.min(...chosen.map(Number));
        facetFilters.push({ filter: `${group.field} ${group.op} ${min}`, field: group.field });
      }
    }
    let priceFilter: string | undefined;
    if (query.priceMin !== undefined || query.priceMax !== undefined) {
      const lo = query.priceMin ?? 0;
      const hi = query.priceMax ?? Number.MAX_SAFE_INTEGER;
      priceFilter = `priceMin <= ${hi} AND priceMax >= ${lo}`;
    }

    const categoricalFacetFields = ['brandSlug', ...attributeDefs.map((d) => `attr_${d.key}`)];
    const result = await this.search.search({
      q: query.q,
      scope,
      facetFilters,
      facetFields: categoricalFacetFields,
      priceFilter,
      sort: query.q?.trim() ? 'relevance' : query.sort,
      page: query.page,
      pageSize: query.pageSize,
    });
    // Meilisearch's own typo tolerance resolves small misspellings inside the main query itself, so unlike
    // the mock there is no separate "corrected from" pass to run (ListingResult.correctedFrom stays unset).
    const title = query.q?.trim() ? `Results for "${query.q.trim()}"` : heading;

    const allSelectedExceptField = (excludeField: string) => [...scope, ...facetFilters.filter((f) => f.field !== excludeField).map((f) => f.filter), ...(priceFilter ? [priceFilter] : [])];

    // Brand facet
    const brandCounts = result.facetDistribution['brandSlug'] ?? ({} as Record<string, number>);
    const brandDocs = await this.mongo.brands.find({ slug: { $in: Object.keys(brandCounts) } }).toArray();
    const brandName = (slug: string) => brandDocs.find((b) => b.slug === slug)?.name ?? slug;
    const facets: Facet[] = [
      {
        key: 'brand',
        label: 'Brand',
        options: Object.entries(brandCounts)
          .map(([slug, count]) => ({ value: slug, label: brandName(slug), count, selected: !!sel['brand']?.includes(slug) }))
          .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
      },
    ];
    for (const def of attributeDefs) {
      const counts = result.facetDistribution[`attr_${def.key}`] ?? ({} as Record<string, number>);
      const options: FacetOption[] = Object.entries(counts)
        .map(([value, count]) => ({ value, label: value, count, selected: !!sel[def.key]?.includes(value) }))
        .sort((a, b) => (def.values ? def.values.indexOf(a.value) - def.values.indexOf(b.value) : a.label.localeCompare(b.label)));
      if (options.length > 1 || options.some((o) => o.selected)) facets.push({ key: def.key, label: def.label, options });
    }
    // Threshold facets: rating, discount, availability — one exact count query per step, ignoring that
    // group's own filter (see the class doc on SearchService.search for why).
    const ratingBase = allSelectedExceptField('ratingAverage');
    const ratingCounts = await Promise.all(RATING_STEPS.map((n) => this.search.count([...ratingBase, `ratingAverage >= ${n}`])));
    facets.push({ key: 'rating', label: 'Customer rating', options: RATING_STEPS.map((n, i) => ({ value: String(n), label: `${n} stars & up`, count: ratingCounts[i], selected: !!sel['rating']?.includes(String(n)) })) });
    const discountBase = allSelectedExceptField('bestDiscount');
    const discountCounts = await Promise.all(DISCOUNT_STEPS.map((n) => this.search.count([...discountBase, `bestDiscount >= ${n}`])));
    facets.push({ key: 'discount', label: 'Discount', options: DISCOUNT_STEPS.map((n, i) => ({ value: String(n), label: `${n}% or more`, count: discountCounts[i], selected: !!sel['discount']?.includes(String(n)) })) });
    const availabilityBase = allSelectedExceptField('totalStock');
    const inStockCount = await this.search.count([...availabilityBase, 'totalStock >= 1']);
    facets.push({ key: 'availability', label: 'Availability', options: [{ value: 'in_stock', label: 'In stock only', count: inStockCount, selected: !!sel['availability']?.includes('in_stock') }] });

    const pageSize = Math.max(1, query.pageSize);
    const pages = Math.max(1, Math.ceil(result.total / pageSize));
    const page = Math.min(Math.max(1, query.page), pages);
    const products: WithId<ProductDoc>[] = await this.mongo.products.find({ id: { $in: result.ids } }).toArray();
    const byId = new Map<string, Product>(products.map((p): [string, Product] => [p.id, this.toProduct(p)]));
    // Meilisearch already returned ids in the right order; Mongo's $in does not preserve it.
    const items = result.ids.map((id) => byId.get(id)).filter((p): p is Product => !!p).map(toSummary);

    return { items, total: result.total, page, pageSize, facets, priceBounds: result.priceBounds, title, breadcrumb };
  }

  product(slug: string): Promise<{ product: Product; redirectedFrom?: string }> {
    return this.cache.getOrSet(
      `catalog:product:${slug}`,
      120,
      // Tagged per variant too, so InventoryService (which only ever knows a variantId, from an order's
      // cart lines, never the product id) can invalidate this exact page precisely on every stock change.
      (result) => [LISTINGS_TAG, `product:${result.product.id}`, ...result.product.variants.map((v) => `variant:${v.id}`)],
      () => this.productUncached(slug),
    );
  }

  private async productUncached(slug: string): Promise<{ product: Product; redirectedFrom?: string }> {
    const direct = await this.mongo.products.findOne({ slug, status: 'published' });
    if (direct) return { product: this.toProduct(direct) };
    const moved = await this.mongo.products.findOne({ slugHistory: slug, status: 'published' });
    if (moved) return { product: this.toProduct(moved), redirectedFrom: slug };
    throw new AppError('not_found', 'Product not found');
  }

  async productsByIds(ids: string[]): Promise<Product[]> {
    if (ids.length === 0) return [];
    const docs: WithId<ProductDoc>[] = await this.mongo.products.find({ id: { $in: ids }, status: 'published' }).toArray();
    const byId = new Map<string, Product>(docs.map((d): [string, Product] => [d.id, this.toProduct(d)]));
    return ids.map((id) => byId.get(id)).filter((p): p is Product => !!p);
  }

  async summariesByIds(ids: string[]): Promise<ProductSummary[]> {
    return (await this.productsByIds(ids)).map(toSummary);
  }

  async related(productId: string): Promise<ProductSummary[]> {
    const product = await this.mongo.products.findOne({ id: productId, status: 'published' });
    if (!product) return [];
    const rootId = product.categoryPath[0].id;
    const candidates: WithId<ProductDoc>[] = await this.mongo.products
      .find({ id: { $ne: productId }, status: 'published', $or: [{ categoryId: product.categoryId }, { 'categoryPath.0.id': rootId }] })
      .toArray();
    const sameLeaf = candidates.filter((p) => p.categoryId === product.categoryId).map((p) => this.toProduct(p));
    const sameRoot = candidates.filter((p) => p.categoryId !== product.categoryId).map((p) => this.toProduct(p)).slice(0, 4);
    return sortProducts([...sameLeaf, ...sameRoot], 'featured').slice(0, 8).map(toSummary);
  }

  async boughtTogether(productId: string): Promise<ProductSummary[]> {
    const product = await this.mongo.products.findOne({ id: productId, status: 'published' });
    if (!product) return [];
    const rootId = product.categoryPath[0].id;
    const otherDocs: WithId<ProductDoc>[] = await this.mongo.products.find({ 'categoryPath.0.id': rootId, categoryId: { $ne: product.categoryId }, status: 'published' }).toArray();
    const others = otherDocs.map((p) => this.toProduct(p)).filter((p) => stockStatusOf(p).status !== 'out_of_stock');
    return sortProducts(others, 'featured').slice(0, 2).map(toSummary);
  }

  async reviews(productId: string, query: ReviewQuery): Promise<ReviewPage> {
    const product = await this.mongo.products.findOne({ id: productId, status: 'published' });
    if (!product) throw new AppError('not_found', 'Product not found');
    const all = (await this.mongo.reviews.find({ productId }).toArray()).map(({ _id, ...r }: WithId<ReviewDoc>): Review => r);
    const sorters: Record<ReviewQuery['sort'], (a: Review, b: Review) => number> = {
      recent: (a, b) => b.createdAt.localeCompare(a.createdAt),
      helpful: (a, b) => b.helpful - a.helpful,
      high: (a, b) => b.rating - a.rating,
      low: (a, b) => a.rating - b.rating,
    };
    const sorted = [...all].sort(sorters[query.sort]);
    const start = (Math.max(1, query.page) - 1) * query.pageSize;
    return { items: sorted.slice(start, start + query.pageSize), total: sorted.length, summary: (this.toProduct(product)).rating };
  }

  serviceability(pincode: string): Serviceability {
    if (!/^[1-9][0-9]{5}$/.test(pincode)) throw new AppError('validation', 'Enter a valid 6-digit pin code', { pincode: 'Invalid pin code' });
    return computeServiceability(pincode);
  }

  categoryTree(): Promise<CategoryNode[]> {
    // Categories change far less often than products, so a longer TTL; still under the same broad
    // "catalog:listings" bucket since a category rename affects breadcrumbs shown in listings too.
    return this.cache.getOrSet('catalog:category-tree', 300, [LISTINGS_TAG, 'catalog:categories'], () => this.categoryTreeUncached());
  }

  private async categoryTreeUncached(): Promise<CategoryNode[]> {
    const flat = (await this.mongo.categories.find().toArray()).map(({ _id, ...c }: WithId<CategoryDoc>) => c);
    const nodes = new Map<string, CategoryNode>(flat.map((c): [string, CategoryNode] => [c.id, { ...c, children: [] }]));
    const roots: CategoryNode[] = [];
    for (const node of nodes.values()) {
      const parent = node.parentId ? nodes.get(node.parentId) : undefined;
      (parent ? parent.children : roots).push(node);
    }
    const sort = (list: CategoryNode[]): CategoryNode[] => {
      list.sort((a, b) => a.order - b.order);
      list.forEach((n) => sort(n.children));
      return list;
    };
    return sort(roots);
  }
}
