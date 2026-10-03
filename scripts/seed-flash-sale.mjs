#!/usr/bin/env node
// Sets one variant's stock to a small, known number before a flash-sale load test, and reports it back
// afterward — the actual "no oversell" check is just comparing what this prints before vs after against
// how many orders actually landed (BRD 25, K6-06).
// Usage: node scripts/seed-flash-sale.mjs <variantId> [stock]   (omit stock to just report the current value)
import { MongoClient } from 'mongodb';

const MONGODB_URL = process.env.MONGODB_URL ?? 'mongodb://localhost:27017';
const DB_NAME = process.env.MONGODB_DB_NAME ?? 'ecommerce_catalog';
const [variantId, stockArg] = process.argv.slice(2);
if (!variantId) throw new Error('usage: node scripts/seed-flash-sale.mjs <variantId> [stock]');

const client = new MongoClient(MONGODB_URL);
await client.connect();
const products = client.db(DB_NAME).collection('products');

if (stockArg !== undefined) {
  const stock = Number(stockArg);
  const result = await products.updateOne({ 'variants.id': variantId }, { $set: { 'variants.$.stock': stock } });
  console.log(`set ${variantId} stock to ${stock} (matched ${result.matchedCount} product)`);
} else {
  const product = await products.findOne({ 'variants.id': variantId }, { projection: { variants: 1 } });
  const variant = product?.variants.find((v) => v.id === variantId);
  console.log(`${variantId} stock is currently: ${variant?.stock ?? '(not found)'}`);
}
await client.close();
