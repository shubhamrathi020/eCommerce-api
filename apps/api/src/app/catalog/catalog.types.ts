import type { Brand, Category, Collection, ProductStatus, Product, Review } from '@ecom/contracts';

/** Mongo documents mirror the shared model shapes exactly; `_id` is the same string id used everywhere
 * else (no separate ObjectId), so mapping to and from the frontend contract is the identity function.
 * `status`/`updatedAt` are admin-only bookkeeping (BRD 06's `ProductMeta`, now shared instead of a
 * per-browser overlay): shoppers only ever see `published` products; `toProduct()` strips both fields
 * before anything reaches a shopper-facing response, so they never leak into the `Product` contract. */
export type ProductDoc = Product & { _id: string; status: ProductStatus; updatedAt: string };
export type CategoryDoc = Category & { _id: string };
export type BrandDoc = Brand & { _id: string };
export type CollectionDoc = Collection & { _id: string };
export type ReviewDoc = Review & { _id: string };
export interface HomeDoc {
  _id: 'home';
  banners: unknown[];
  categoryTiles: unknown[];
}
