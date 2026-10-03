import { Inject, Injectable, Logger } from '@nestjs/common';
import { Meilisearch } from 'meilisearch';
import type { SortKey } from '@ecom/contracts';
import { API_CONFIG, type ApiConfig } from '../config';
import { AppError } from '../common/app-error';
import { CircuitBreaker, CircuitOpenError, type CircuitStats } from '../resilience/circuit-breaker';
import { withRetry } from '../resilience/retry';

/** The document shape written to the Meilisearch `products` index (BF-... / CS-03). Flattened and
 * denormalised on purpose: search and facet counting both need to run without touching Mongo per hit. */
export interface CatalogSearchDoc {
  id: string;
  slug: string;
  title: string;
  brandName: string;
  brandSlug: string;
  categoryId: string;
  tags: string[];
  priceMin: number;
  priceMax: number;
  ratingAverage: number;
  bestDiscount: number;
  totalStock: number;
  popularity: number;
  createdAtTs: number;
  /** One array field per attribute/variant-axis key across the whole catalog, e.g. `attr_size: ["S","M"]`. */
  [attrField: string]: unknown;
}

/** Interchangeable words, mirrored from the mock search engine's SYNONYM_GROUPS so real search behaves the
 * same way a shopper already saw in development (libs/shared/data-access/src/mock/search-engine.ts). */
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

export interface FacetClause {
  /** Meilisearch filter expression for just this one facet group, e.g. `brandSlug IN ["acme"]`. */
  filter: string;
  /** The field this facet counts, e.g. `brandSlug`. Passed to Meilisearch's `facets` list. */
  field: string;
}

export interface SearchQuery {
  q?: string;
  /** Clauses that are never toggled off (category/brand/collection page scope). Always applied. */
  scope: string[];
  /** One clause per togglable facet group that currently has a selection; used for "ignore this facet's
   * own filter when counting its own options" (matches the mock's `matching(ignore)` behaviour). */
  facetFilters: FacetClause[];
  /** Every facet field to return counts for for (selected or not). */
  facetFields: string[];
  priceFilter?: string;
  sort: SortKey;
  page: number;
  pageSize: number;
}

export interface SearchResult {
  ids: string[];
  scores: Map<string, number>;
  total: number;
  facetDistribution: Record<string, Record<string, number>>;
  priceBounds: { min: number; max: number };
}

const SORT_FIELD: Record<SortKey, string[] | undefined> = {
  relevance: undefined,
  featured: ['popularity:desc'],
  'price-asc': ['priceMin:asc'],
  'price-desc': ['priceMax:desc'],
  newest: ['createdAtTs:desc'],
  rating: ['ratingAverage:desc'],
  discount: ['bestDiscount:desc'],
};

@Injectable()
export class SearchService {
  private readonly client: Meilisearch;
  readonly indexName: string;
  /** Guards only the shopper-facing read paths (`search`/`suggestProducts`/`count`) — see the class doc
   * on `search()` for why (BRD 24, OB-05). Indexing calls (admin writes, the seed script) are not
   * guarded: those already run outside a request/response cycle and their own callers decide how to
   * handle a failure (e.g. `AdminCatalogService` logs and continues rather than blocking the write). */
  private readonly breaker = new CircuitBreaker('meilisearch', { failureThreshold: 3, cooldownMs: 20_000, timeoutMs: 3_000 });
  private readonly logger = new Logger('SearchService');

  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {
    this.client = new Meilisearch({ host: config.meiliUrl, apiKey: config.meiliMasterKey || undefined });
    this.indexName = `products${config.meiliIndexSuffix}`;
  }

  private get index() {
    return this.client.index<CatalogSearchDoc>(this.indexName);
  }

  breakerStats(): CircuitStats {
    return this.breaker.stats();
  }

  /** Every shopper-facing read goes through this: a couple of quick retries absorb a transient blip
   * (counted as *one* failure toward the breaker, not several — see the note on `withRetry`), and once
   * Meilisearch is genuinely down, the breaker fails fast with a clear, non-fatal error instead of every
   * request queuing up behind a slow or dead dependency. Catalog browsing by category/product-page still
   * works fine during an outage (that's plain Mongo reads); only search-driven results (this call) and
   * the standalone `/search/suggest` degrade, on purpose rather than silently — see OB-05's acceptance
   * criterion "a provider outage degrades gracefully, not fatally", not "invisibly". Every failure here
   * — a single call that failed even after retrying, or the breaker already open — surfaces as the same
   * friendly `AppError`, never the raw Meilisearch/fetch exception (which `ApiErrorFilter` would
   * otherwise turn into an opaque generic 500 instead of a clear, actionable 503). */
  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await this.breaker.exec(() => withRetry(fn, { attempts: 2, baseDelayMs: 150 }));
    } catch (error) {
      if (!(error instanceof CircuitOpenError)) this.logger.warn(`meilisearch call failed: ${(error as Error).message}`);
      throw new AppError('network', 'Search is temporarily unavailable. Please try again shortly.');
    }
  }

  /** Idempotent: safe to call every time the seed script runs. `attrFields` is every `attr_<key>` the
   * catalog currently uses (collected from all categories' attributeDefs plus every variant axis). */
  async ensureIndex(attrFields: string[]): Promise<void> {
    const task = await this.client.createIndex(this.indexName, { primaryKey: 'id' });
    await this.client.tasks.waitForTask(task.taskUid).catch(() => undefined); // already exists is fine
    const numeric = ['priceMin', 'priceMax', 'ratingAverage', 'bestDiscount', 'totalStock', 'popularity', 'createdAtTs'];
    await this.index.updateSettings({
      searchableAttributes: ['title', 'brandName', 'tags', ...attrFields],
      filterableAttributes: ['categoryId', 'brandSlug', 'tags', ...numeric, ...attrFields],
      sortableAttributes: numeric,
      // A word maps to every other word in its group; Meilisearch stores synonyms one-directionally per key.
      synonyms: Object.fromEntries(SYNONYM_GROUPS.flatMap((group) => group.map((word) => [word, group.filter((w) => w !== word)]))),
    });
  }

  async indexProducts(docs: CatalogSearchDoc[]): Promise<void> {
    if (docs.length === 0) return;
    const task = await this.index.addDocuments(docs);
    await this.client.tasks.waitForTask(task.taskUid);
  }

  async deleteProduct(id: string): Promise<void> {
    const task = await this.index.deleteDocument(id);
    await this.client.tasks.waitForTask(task.taskUid);
  }

  async health(): Promise<void> {
    await this.client.health();
  }

  async search(query: SearchQuery): Promise<SearchResult> {
    return this.guarded(async () => {
      const allFilter = [...query.scope, ...query.facetFilters.map((f) => f.filter), ...(query.priceFilter ? [query.priceFilter] : [])];
      const mainFilter = allFilter.length ? allFilter.join(' AND ') : undefined;
      const main = await this.index.search(query.q ?? '', {
        filter: mainFilter,
        facets: query.facetFields.length ? [...query.facetFields, 'priceMin', 'priceMax'] : ['priceMin', 'priceMax'],
        sort: SORT_FIELD[query.sort],
        page: Math.max(1, query.page),
        hitsPerPage: Math.max(1, query.pageSize),
        showRankingScore: true,
      });

      // For each active facet group, re-run with that group's own clause removed, so its own option counts
      // reflect "if you added this option" rather than "given you already selected it" (mirrors the mock's
      // matching(ignore) helper in libs/shared/data-access/src/mock/catalog-engine.ts).
      const distribution: Record<string, Record<string, number>> = { ...(main.facetDistribution ?? {}) };
      await Promise.all(
        query.facetFilters.map(async (own) => {
          const without = allFilter.filter((f) => f !== own.filter);
          const res = await this.index.search(query.q ?? '', { filter: without.length ? without.join(' AND ') : undefined, facets: [own.field], limit: 0 });
          if (res.facetDistribution?.[own.field]) distribution[own.field] = res.facetDistribution[own.field];
        }),
      );

      const priceStats = main.facetStats ?? {};
      const hits: { id: string; _rankingScore?: number }[] = main.hits;
      return {
        ids: hits.map((h) => h.id),
        scores: new Map(hits.map((h) => [h.id, h._rankingScore ?? 0])),
        total: main.totalHits ?? hits.length,
        facetDistribution: distribution,
        priceBounds: { min: priceStats['priceMin']?.min ?? 0, max: priceStats['priceMax']?.max ?? 0 },
      };
    });
  }

  async suggestProducts(q: string, limit: number): Promise<string[]> {
    return this.guarded(async () => {
      const res = await this.index.search(q, { limit });
      const hits: { id: string }[] = res.hits;
      return hits.map((h) => h.id);
    });
  }

  /** Exact count of documents matching `filters` (ANDed). Used for the mock's threshold-style facets
   * (rating "4 stars & up", discount "25% or more"), which aren't a single categorical field Meilisearch
   * can facet-count directly. `page`/`hitsPerPage` (rather than `limit`) makes Meilisearch compute an
   * exact `totalHits` instead of an estimate. */
  async count(filters: string[]): Promise<number> {
    return this.guarded(async () => {
      const res = await this.index.search('', { filter: filters.length ? filters.join(' AND ') : undefined, page: 1, hitsPerPage: 1 });
      return res.totalHits ?? 0;
    });
  }
}
