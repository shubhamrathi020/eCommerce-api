// Search scenario (BRD 25, K6-06): typing into the search box (autocomplete) then opening the results
// page — the path most exposed to a Meilisearch outage (BRD 24's circuit breaker guards this exact call).
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    search: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '20s', target: 30 },
        { duration: '40s', target: 30 },
        { duration: '10s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<600'],
    http_req_failed: ['rate<0.01'],
  },
};

const BASE_URL = __ENV.BASE_URL ?? 'http://localhost:3333';
const TERMS = ['phone', 'shirt', 'shoe', 'lapto', 'watc', 'bag', 'jean', 'tee'];

export default function () {
  const term = TERMS[Math.floor(Math.random() * TERMS.length)];
  const suggest = http.get(`${BASE_URL}/search/suggest?q=${term}`);
  check(suggest, { 'suggest is 200': (r) => r.status === 200 });

  const results = http.get(`${BASE_URL}/catalog/listing?q=${term}&page=1&pageSize=24`);
  check(results, { 'search results is 200': (r) => r.status === 200 });

  sleep(0.5 + Math.random());
}
