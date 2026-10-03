// Browse scenario (BRD 25, K6-06): a shopper landing on the home page, opening a category, and viewing
// a product — the read-heavy path BRD 22's caching exists for. Run with:
//   docker run --rm -i --network shop_default -e BASE_URL=http://api:3333 grafana/k6 run - < browse.js
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    browse: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50 },
        { duration: '1m', target: 50 },
        { duration: '15s', target: 0 },
      ],
    },
  },
  thresholds: {
    // "p95 targets met at design load" (K6-06) — this project's own design load, not the master BR's
    // 10,000-concurrent-user cloud target, which needs the real cloud environment BRD 25 also defers.
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
  },
};

const BASE_URL = __ENV.BASE_URL ?? 'http://localhost:3333';

export default function () {
  const home = http.get(`${BASE_URL}/catalog/home`);
  check(home, { 'home is 200': (r) => r.status === 200 });

  const listing = http.get(`${BASE_URL}/catalog/listing?page=1&pageSize=24&sort=featured`);
  check(listing, { 'listing is 200': (r) => r.status === 200 });
  const items = listing.json('items') ?? [];

  if (items.length > 0) {
    const slug = items[Math.floor(Math.random() * items.length)].slug;
    const product = http.get(`${BASE_URL}/catalog/products/${slug}`);
    check(product, { 'product is 200': (r) => r.status === 200 });
  }

  sleep(1 + Math.random());
}
