import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { SearchSuggestions } from '@ecom/contracts';
import { RateLimitBucket } from '../cache/rate-limit.guard';
import { CatalogService } from './catalog.service';
import { SearchService } from './search.service';
import { MongoService } from './mongo.service';

const POPULAR_SEARCHES = ['smartphone', 'sneakers', 't-shirt', 'laptop', 'headphones', 'yoga mat', 'air fryer', 'watch'];
const MAX_QUERY_LENGTH = 100;

/** Suggestions beyond the results list (BF-.../CS-04). Results themselves come from `GET /catalog/listing`,
 * so Meilisearch is the one thing doing the real matching here too, not a second bespoke engine. */
@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(
    private readonly search: SearchService,
    private readonly catalog: CatalogService,
    private readonly mongo: MongoService,
  ) {}

  @Get('suggest')
  @RateLimitBucket('search')
  async suggest(@Query('q') rawQ: string | undefined): Promise<SearchSuggestions> {
    const q = (rawQ ?? '').slice(0, MAX_QUERY_LENGTH).trim();
    if (!q) return { queries: POPULAR_SEARCHES.slice(0, 5), products: [], categories: [], brands: [] };
    // Product suggestions need Meilisearch; category/brand suggestions are plain Mongo reads. A search
    // outage (BRD 24, OB-05) should not also take those down — caught separately, degrading to an empty
    // product list rather than failing the whole autocomplete dropdown.
    const [idsResult, categories, brands] = await Promise.all([
      this.search.suggestProducts(q, 4).catch(() => [] as string[]),
      this.mongo.categories.find({ name: { $regex: q, $options: 'i' } }).limit(3).toArray(),
      this.mongo.brands.find({ name: { $regex: q, $options: 'i' } }).limit(3).toArray(),
    ]);
    const products = await this.catalog.summariesByIds(idsResult);
    const popularMatches = POPULAR_SEARCHES.filter((p) => p.toLowerCase().startsWith(q.toLowerCase()));
    return {
      queries: [...new Set([...popularMatches, ...categories.map((c) => c.name), ...brands.map((b) => b.name)])].slice(0, 5),
      products,
      categories: categories.map((c) => ({ slug: c.slug, name: c.name })),
      brands: brands.map((b) => ({ slug: b.slug, name: b.name })),
    };
  }

  @Get('popular')
  popular(): string[] {
    return [...POPULAR_SEARCHES];
  }
}
