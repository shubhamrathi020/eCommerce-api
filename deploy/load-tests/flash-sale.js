// Flash-sale last-unit scenario (BRD 25, K6-06's explicit acceptance criterion: "no oversell"). Every VU
// races to buy the SAME single variant, seeded with a small, fixed stock count before the test starts —
// this is exactly the race BRD 21's atomic `$elemMatch` Mongo decrement (CM21-04) exists to prevent.
// Usage: node scripts/seed-flash-sale.mjs <variantId> <stock>   (sets the stock, run before this test)
//        docker run --rm -i --network shop_default -e BASE_URL=... -e VARIANT_ID=... grafana/k6 run - < flash-sale.js
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  scenarios: {
    flash_sale: {
      executor: 'per-vu-iterations',
      vus: 80,
      iterations: 1,
      maxDuration: '30s',
    },
  },
  // No latency/error-rate threshold here on purpose — the one metric that actually matters for this
  // scenario is the oversell count, checked after the run (see docs/CAPACITY-PLAN.md's load-test report),
  // not anything k6 itself can assert mid-run against a fixed VU count racing one row.
};

const BASE_URL = __ENV.BASE_URL ?? 'http://localhost:3333';
const VARIANT_ID = __ENV.VARIANT_ID ?? 'p-0005-v1';
// Set only when going through the ingress rather than directly at the Service (see deploy/load-tests's
// own README) — ingress-nginx routes purely on the Host header, which k6's BASE_URL alone doesn't send.
const HOST_HEADER = __ENV.HOST_HEADER;

export default function () {
  const jar = http.cookieJar();
  const headers = { 'Content-Type': 'application/json', 'x-csrf': '1', ...(HOST_HEADER ? { Host: HOST_HEADER } : {}) };
  const added = http.post(`${BASE_URL}/cart/items`, JSON.stringify({ variantId: VARIANT_ID, quantity: 1 }), { headers, jar });
  // A 4xx here (out of stock, from a VU that lost the race at the cart step) is a correct outcome, not a
  // failure of the test — only a 5xx would mean something actually broke.
  check(added, { 'add-to-cart never 5xx': (r) => r.status < 500 });
  if (added.status >= 300) return;

  const placed = http.post(
    `${BASE_URL}/orders`,
    JSON.stringify({
      idempotencyKey: `k6-flash-${__VU}-${Date.now()}`,
      contact: { name: 'Flash Sale', email: `flash-${__VU}@example.com`, phone: '9876500000' },
      address: { line1: '1 Flash Sale Rd', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
      paymentMethod: 'cod',
    }),
    { headers, jar },
  );
  check(placed, { 'checkout never 5xx (a losing VU gets a clean 4xx, not a crash)': (r) => r.status < 500 });
}
