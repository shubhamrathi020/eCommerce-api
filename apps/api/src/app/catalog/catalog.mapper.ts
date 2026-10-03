import type { Product } from '@ecom/contracts';
import { bestDiscount, stockStatusOf } from '@ecom/contracts';
import type { CatalogSearchDoc } from './search.service';

const totalStock = (p: Product): number => p.variants.reduce((sum, v) => sum + v.stock, 0);
const cheapestOf = (p: Product) => Math.min(...p.variants.map((v) => v.price.amount));
const dearestOf = (p: Product) => Math.max(...p.variants.map((v) => v.price.amount));

/** Every attribute/variant-axis value on this product, one string array per key (e.g. `size: ["S","M"]`),
 * matching the mock's `attributeValuesOf` (the frontend repository, libs/shared/data-access/src/mock/catalog-engine.ts). */
export function facetValuesOf(p: Product): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(p.attributes)) out[key] = [String(value)];
  for (const axis of p.variantAxes) {
    const values = [...new Set(p.variants.map((v) => v.options[axis]).filter((v): v is string => v !== undefined))];
    if (values.length) out[axis] = values;
  }
  return out;
}

/** Every attribute/axis key that appears on `product`, prefixed for the Meilisearch document field name. */
export function attrFieldsOf(product: Product): Record<string, string[]> {
  const values = facetValuesOf(product);
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [`attr_${k}`, v]));
}

export function toSearchDoc(p: Product): CatalogSearchDoc {
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    brandName: p.brandName,
    brandSlug: p.brandId.replace(/^brand-/, ''),
    categoryId: p.categoryId,
    tags: p.tags,
    priceMin: cheapestOf(p),
    priceMax: dearestOf(p),
    ratingAverage: p.rating.average,
    bestDiscount: bestDiscount(p),
    totalStock: totalStock(p),
    popularity: p.popularity,
    createdAtTs: new Date(p.createdAt).getTime(),
    ...attrFieldsOf(p),
  };
}

export { stockStatusOf };
