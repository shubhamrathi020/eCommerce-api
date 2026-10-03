import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { HomeData, ListingQuery, ListingResult, Product, ProductSummary, ReviewPage, ReviewSort, Serviceability, SortKey } from '@ecom/contracts';
import { AppError } from '../common/app-error';
import { HttpCacheControl } from '../cache/http-cache.interceptor';
import { CatalogService } from './catalog.service';

const SORT_KEYS: SortKey[] = ['relevance', 'featured', 'price-asc', 'price-desc', 'newest', 'rating', 'discount'];
const REVIEW_SORTS: ReviewSort[] = ['recent', 'helpful', 'high', 'low'];

/** Parses `filters` as a JSON object of string arrays (the shape `ListingQuery.filters` needs); anything
 * else (missing, malformed, wrong types) is treated as "no filters" rather than a 500. */
function parseFilters(raw: unknown): Record<string, string[]> {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === 'string');
    return out;
  } catch {
    return {};
  }
}

const int = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

@ApiTags('catalog')
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('home')
  @HttpCacheControl(60)
  home(): Promise<HomeData> {
    return this.catalog.home();
  }

  @Get('categories/tree')
  @HttpCacheControl(300)
  categoryTree() {
    return this.catalog.categoryTree();
  }

  @Get('listing')
  @HttpCacheControl(30)
  listing(@Query() q: Record<string, string>): Promise<ListingResult> {
    const sort = SORT_KEYS.includes(q['sort'] as SortKey) ? (q['sort'] as SortKey) : 'relevance';
    const query: ListingQuery = {
      ...(q['categorySlug'] ? { categorySlug: q['categorySlug'] } : {}),
      ...(q['brandSlug'] ? { brandSlug: q['brandSlug'] } : {}),
      ...(q['collectionSlug'] ? { collectionSlug: q['collectionSlug'] } : {}),
      ...(q['q'] ? { q: q['q'] } : {}),
      filters: parseFilters(q['filters']),
      ...(q['priceMin'] !== undefined ? { priceMin: int(q['priceMin'], 0) } : {}),
      ...(q['priceMax'] !== undefined ? { priceMax: int(q['priceMax'], 0) } : {}),
      sort,
      page: int(q['page'], 1),
      pageSize: Math.min(100, int(q['pageSize'], 24)),
    };
    return this.catalog.listing(query);
  }

  @Get('products/:slug')
  @HttpCacheControl(120)
  product(@Param('slug') slug: string): Promise<{ product: Product; redirectedFrom?: string }> {
    return this.catalog.product(slug);
  }

  @Post('products/by-ids')
  productsByIds(@Body('ids') ids: unknown): Promise<Product[]> {
    return this.catalog.productsByIds(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []);
  }

  @Post('products/summaries')
  summariesByIds(@Body('ids') ids: unknown): Promise<ProductSummary[]> {
    return this.catalog.summariesByIds(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []);
  }

  @Get('products/:id/related')
  related(@Param('id') id: string): Promise<ProductSummary[]> {
    return this.catalog.related(id);
  }

  @Get('products/:id/bought-together')
  boughtTogether(@Param('id') id: string): Promise<ProductSummary[]> {
    return this.catalog.boughtTogether(id);
  }

  @Get('products/:id/reviews')
  reviews(@Param('id') id: string, @Query() q: Record<string, string>): Promise<ReviewPage> {
    const sort = REVIEW_SORTS.includes(q['sort'] as ReviewSort) ? (q['sort'] as ReviewSort) : 'recent';
    return this.catalog.reviews(id, { sort, page: int(q['page'], 1), pageSize: Math.min(50, int(q['pageSize'], 10)) });
  }

  @Get('serviceability/:pincode')
  serviceability(@Param('pincode') pincode: string): Serviceability {
    if (!pincode) throw new AppError('validation', 'Enter a valid 6-digit pin code', { pincode: 'Invalid pin code' });
    return this.catalog.serviceability(pincode);
  }
}
