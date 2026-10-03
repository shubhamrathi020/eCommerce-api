# Load tests (k6) — BRD 25, K8-06

Four scenarios, run with the `grafana/k6` image (nothing to install):

| Script | What it proves |
|---|---|
| `browse.js` | home → listing → product, 50 concurrent users |
| `search.js` | autocomplete + search results, 30 concurrent users |
| `checkout.js` | add to cart → place a COD order, 15 concurrent users |
| `flash-sale.js` | **80 buyers race for 20 units of one variant — stock must end at exactly 0, never negative** |

```bash
# Against the local Kubernetes stack (kubectl port-forward first):
kubectl -n shop port-forward svc/api 13333:80 &
kubectl -n ingress-nginx port-forward svc/ingress-nginx-controller 18443:443 &

# browse / search need no cookies, so plain HTTP straight to the Service is fine:
MSYS_NO_PATHCONV=1 docker run --rm -v "$PWD/deploy/load-tests:/scripts" -e BASE_URL=http://host.docker.internal:13333 grafana/k6 run /scripts/browse.js

# checkout / flash-sale need the guest-cart cookie, which is `Secure` in production config, so they MUST go
# over HTTPS via the ingress, with a Host header (ingress routes on it):
node scripts/seed-flash-sale.mjs p-0005-v1 20        # needs MONGODB_URL (port-forward mongo) — sets the stock
MSYS_NO_PATHCONV=1 docker run --rm -v "$PWD/deploy/load-tests:/scripts" \
  -e BASE_URL=https://host.docker.internal:18443 -e HOST_HEADER=api.localtest.me -e VARIANT_ID=p-0005-v1 \
  grafana/k6 run --insecure-skip-tls-verify /scripts/flash-sale.js
node scripts/seed-flash-sale.mjs p-0005-v1           # prints the stock afterwards; compare with the order count
```

(`MSYS_NO_PATHCONV=1` is for Git Bash on Windows, which otherwise rewrites `/scripts/...` into a Windows path.)

## Before you trust a result: the rate limits will skew it

A single test machine is one IP address, and the API deliberately rate-limits per IP. At the defaults
(`RATE_LIMIT_GLOBAL_PER_MIN=300`, `RATE_LIMIT_CHECKOUT_PER_MIN=20`, ...) nearly every request after the first few
seconds gets a 429 — the first browse run showed ~70% failures that were *all* 429s, and the first flash-sale runs
placed zero orders because every checkout was rejected before reaching the stock logic. Raise them for the run
(`kubectl set env deployment/api-stable RATE_LIMIT_GLOBAL_PER_MIN=100000 ...`) and **remove them afterwards**
(`... RATE_LIMIT_GLOBAL_PER_MIN-`). Those 429s are the limiter working, not capacity problems; they also mean a
real crowd behind one corporate/mobile NAT address would hit the same ceilings (see docs/CAPACITY-PLAN.md).

Results and what they do and don't show: `docs/CAPACITY-PLAN.md` §2.
