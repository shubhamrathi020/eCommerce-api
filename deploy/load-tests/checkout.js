// Checkout scenario (BRD 25, K6-06): a guest adding an item, checking out, and paying cash on delivery —
// exercises the whole stack this load test can reach without a real Razorpay account: cart (Postgres),
// stock decrement (Mongo, atomic $elemMatch — BRD 21), the transactional outbox (BRD 23), coupon claim
// (Redis — BRD 22). Every VU uses its own guest cookie jar, just like a real separate shopper.
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    checkout: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '20s', target: 15 },
        { duration: '40s', target: 15 },
        { duration: '10s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<1500'],
    http_req_failed: ['rate<0.02'],
  },
};

const BASE_URL = __ENV.BASE_URL ?? 'http://localhost:3333';
// A spread of variants so many concurrent VUs aren't all fighting over the exact same one (that's what
// flash-sale.js is for, deliberately).
const VARIANTS = ['p-0002-v1', 'p-0002-v2', 'p-0002-v3', 'p-0003-v1', 'p-0003-v2', 'p-0004-v1'];

// Set when going through the ingress (the guest-cart cookie is `Secure`, so this scenario must use HTTPS
// via the ingress, which routes on Host) — see deploy/load-tests/README.md.
const HOST_HEADER = __ENV.HOST_HEADER;

export default function () {
  const jar = http.cookieJar();
  const variantId = VARIANTS[Math.floor(Math.random() * VARIANTS.length)];
  const headers = { 'Content-Type': 'application/json', 'x-csrf': '1', ...(HOST_HEADER ? { Host: HOST_HEADER } : {}) };

  const added = http.post(`${BASE_URL}/cart/items`, JSON.stringify({ variantId, quantity: 1 }), { headers, jar });
  check(added, { 'add to cart is 2xx': (r) => r.status >= 200 && r.status < 300 });

  const idempotencyKey = `k6-checkout-${__VU}-${__ITER}-${Date.now()}`;
  const placed = http.post(
    `${BASE_URL}/orders`,
    JSON.stringify({
      idempotencyKey,
      contact: { name: 'Load Test', email: `load-${__VU}@example.com`, phone: '9876500000' },
      address: { line1: '1 Load Test Rd', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
      paymentMethod: 'cod',
    }),
    { headers, jar },
  );
  check(placed, { 'order placed (201) or a real validation reason, never a 5xx': (r) => r.status < 500 });

  sleep(1 + Math.random() * 2);
}
