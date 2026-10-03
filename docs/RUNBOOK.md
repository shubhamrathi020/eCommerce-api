# Runbook (backend)

Everyday commands for running, testing and deploying the backend API and its infrastructure. The frontend apps are in the separate `eCommerce` repository (its own `docs/RUNBOOK.md`). Commands use `pnpm` (the version is pinned in `package.json`).

## 1. First time

This repository is the **backend** (NestJS API, database schema, Docker, Kubernetes, monitoring). It depends on the sibling repository `eCommerce-contracts` (shared types and rules), which must be checked out next to this one and built once:

```
claude/
  eCommerce/             <- the frontend
  eCommerce-contracts/   <- shared contract package
  eCommerce-api/         <- this repository
```

```bash
cd ../eCommerce-contracts && pnpm install && pnpm build   # first time, and after any change there
cd ../eCommerce-api && pnpm install && pnpm db:generate
```

Needs Node 22 and pnpm (`corepack enable` picks the pinned version) and Docker Desktop for the data stores. Copy `apps/api/.env.example` to `apps/api/.env` (dev-only values).

## 2. Check everything

| Command | What it does |
|---|---|
| `pnpm verify` | Lint, tests and the production build (the API tests need the data stores running: `docker compose up -d postgres redis rabbitmq mongo meilisearch`) |
| `pnpm test` / `pnpm lint` / `pnpm build` | One step at a time |

## 3. The backend API (BRD 19 to 24)

Sign-in, profile, addresses, browsing/searching the catalog, and cart/checkout/orders (cash on delivery) all run on the real API now, backed by Redis caching/rate limiting and RabbitMQ messaging. Online payment needs your own Razorpay test keys (see below); everything else needs nothing extra.

```bash
docker compose up -d postgres redis rabbitmq mongo meilisearch   # or your own local instances
pnpm db:migrate                        # first time and after schema changes (prompts for a migration name)
pnpm db:seed                           # seeds the same demo accounts as the frontend mock
pnpm db:seed:catalog                   # seeds the same 252 products into Mongo and builds the Meilisearch index
pnpm start:api                         # http://localhost:3333, docs at /docs, dev mailbox at /dev/outbox
```

Then, in `apps/storefront/src/app/app-config.values.ts` (or `apps/admin/src/app/app.config.ts`):
- `realAuth: true` — sign-in, profile, addresses.
- `realCatalog: true` — catalog browsing and search. On the admin app, product management also needs `realAuth: true` (the real catalog endpoints check the signed-in user's permissions on the server).
- `realCommerce: true` — cart, checkout, orders. Cash on delivery works immediately; online payment additionally needs `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` in `apps/api/.env` (your own free test-mode keys from the Razorpay dashboard — never paste them into chat; without them `PaymentApi.initiate` refuses with a clear message and COD still works). On the admin app, order management also needs `realAuth: true`.

Set them back to `false` (the default) to go back to the mock. Re-run `pnpm db:seed:catalog` any time you want to reset the catalog back to the seeded 252 products (admin test edits and order-placed stock changes included).

`pnpm exec nx test api` runs the API's own integration tests against **separate** `..._test` stores (a Postgres database and a Mongo database, created automatically, plus a `products_test` Meilisearch index) — it needs Postgres, Mongo, Meilisearch, Redis and RabbitMQ running but never touches your development data (Redis keys use an `ecom:test:` prefix and RabbitMQ exchanges/queues an `ecom.test.` prefix, so a test run never collides with dev data or dev topology even sharing the same broker/Redis instance).

Caching and rate limits (BRD 22) need nothing extra beyond Redis already being up: catalog reads (home, listing, product, category tree) are cached in Redis with tagged invalidation, and `GET /catalog/...` responses carry `ETag`/`Cache-Control` headers (a repeat request with a matching `If-None-Match` gets a real `304`). Search-suggest, coupon-apply and checkout are rate-limited per the `RATE_LIMIT_SEARCH_PER_MIN` / `RATE_LIMIT_COUPON_PER_MIN` / `RATE_LIMIT_CHECKOUT_PER_MIN` values in `apps/api/.env` (defaults 60/20/20 per minute); exceeding one returns `429` with a `Retry-After` header. An admin signed in with the `system:read` permission (the seeded `admin@shop.test` has it) can check `GET /admin/system/cache-stats` for live hit/miss/rate-limit-blocked counts.

Messaging (BRD 23) needs nothing extra beyond RabbitMQ already being up: placing, cancelling or paying for an order (and, every 5 minutes, an abandoned signed-in-customer cart) writes a row to a transactional outbox, which is relayed to RabbitMQ and turned into a real email in `/dev/outbox` — usually within a couple of seconds. `GET /orders/:id/stream` is a Server-Sent Events endpoint: open it in a browser tab (or `curl -N`) on an order you own, and a later status change (cancel it, or advance it from the admin console) appears in that same open connection with no reload. A message that fails processing three times lands in the dead-letter queue instead of blocking anything else; an admin with `system:read`/`system:write` can inspect and replay it at `GET`/`POST /admin/system/dead-letters(/replay)`. RabbitMQ's own management UI is at http://localhost:15672 (guest/guest).

Observability and resilience (BRD 24):
```bash
docker compose up -d prometheus grafana alertmanager alert-log loki promtail
```
- **Metrics**: `GET /metrics` (no auth, same posture as `/healthz`) is a real Prometheus exposition — request rate/duration/status, the BRD 22 cache hit ratio, circuit-breaker state, the BRD 23 outbox backlog, and Node's own baseline. Prometheus (http://localhost:9090) scrapes it every 15s; Grafana (http://localhost:3001, anonymous viewer access) is pre-provisioned with a real "eCommerce API overview" dashboard — nothing to set up to see it. Running the API in Docker (`pnpm docker:up`) instead of on your host needs the scrape target in `deploy/observability/prometheus.yml` changed from `host.docker.internal:3333` to `api:3333` (a comment there says the same thing).
- **Resilience**: every Razorpay and Meilisearch call goes through a circuit breaker (timeout, a couple of quick retries, then open for a cooldown after 3 consecutive failures) — `GET /admin/system/resilience` (`system:read`) shows both breakers' live state. While Meilisearch is down, search-driven catalog pages and `/search/suggest` return a clear "temporarily unavailable" message (never a raw exception); cash on delivery and plain category/product-page browsing are completely unaffected either way.
- **Alerts**: 5 real Prometheus rules (`deploy/observability/alert-rules.yml`) route through Alertmanager (http://localhost:9093) to a webhook receiver that logs every alert (`docker compose logs alert-log`) — no real Slack/email account exists in this environment, so point `deploy/observability/alertmanager.yml`'s webhook at your own Slack/PagerDuty/SMTP-bridge URL for a real destination; nothing else needs to change.
- **Logs**: Promtail ships every docker-compose container's own stdout into Loki (http://localhost:3100), searchable in Grafana's Explore by the `service` label or by the API's own `requestId` field. Only picks up containers actually run via `docker compose` — a host-run `pnpm start:api` dev server's logs stay in your own terminal.
- **Backups**: `pnpm backup` runs a real `pg_dump`/`mongodump` against the running containers into `backups/` (gitignored); `pnpm restore:drill` restores the most recent Postgres backup into a disposable database (never over the real one), verifies row counts, times the whole thing, and reports it against the BRD's RPO/RTO targets.


## 4. Containers (Docker)

```bash
pnpm docker:up      # builds the API images and starts everything
pnpm docker:down    # stops and removes them
```

The API image needs the shared contract package: `docker compose` passes `../eCommerce-contracts` as a named build context (`contracts_src`). For a plain `docker build` add `--build-context contracts_src=../eCommerce-contracts`.

| Service | URL | Container user | Health |
|---|---|---|---|
| API (NestJS) | http://localhost:3333 | node (uid 1000), read-only filesystem | `/healthz`, `/readyz` |
| PostgreSQL | localhost:5432 | — | `pg_isready` |
| Redis | localhost:6379 | — | `redis-cli ping` |
| RabbitMQ | localhost:5672 (management UI: http://localhost:15672) | — | `rabbitmq-diagnostics ping` |
| MongoDB | localhost:27017 | — | `mongosh --eval db.runCommand('ping')` |
| Meilisearch | http://localhost:7700 | — | `/health` |
| Prometheus | http://localhost:9090 | — | `/-/healthy` |
| Grafana | http://localhost:3001 | — | `/api/health` |
| Alertmanager | http://localhost:9093 | — | `/-/healthy` |
| Loki | http://localhost:3100 | — | `/ready` |

To use the real backend from the frontend, set `realCatalog` / `realCommerce` / `realAuth` in the frontend's app config and run the frontend apps from the `eCommerce` repository. `CORS_ORIGINS` already allows the dev ports 4200 to 4202 and the container ports 4000 and 4001.

## 5. Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| API: "Invalid API configuration" on start | A required `.env` value is missing; copy `apps/api/.env.example` to `apps/api/.env` |
| `pnpm exec nx test api` fails to connect | Postgres is not running: `docker compose up -d postgres` |
| `pnpm exec nx test api` fails to connect to Mongo/Meilisearch | `docker compose up -d mongo meilisearch` |
| `pnpm exec nx test api` fails with "API tests need Redis" | `docker compose up -d redis` |
| `pnpm exec nx test api` fails with "API tests need RabbitMQ" | `docker compose up -d rabbitmq` |
| An order-confirmation/cancellation email doesn't show up in `/dev/outbox` | Give it a couple of seconds (the outbox relay polls every 2s); if it never arrives, check the API logs for `[OutboxRelay]`/`[NotificationConsumer]` warnings, and confirm RabbitMQ is up |
| A message keeps showing up in `GET /admin/system/dead-letters` | It failed processing 3 times; check `lastError` in the listing, fix the underlying cause, then `POST /admin/system/dead-letters/replay` |
| A catalog page shows stale data right after an admin edit or a placed order | Should self-correct within the route's cache TTL (60s home, 300s category tree, 30s listing, 120s product); if it persists, check `GET /admin/system/cache-stats` for a hit ratio near 100% (cache not being invalidated) |
| `429 Too Many Requests` on search, coupon or checkout calls during manual testing | Working as designed — wait for the `Retry-After` seconds, or raise `RATE_LIMIT_*_PER_MIN` in `apps/api/.env` for local testing |
| Prometheus target `api` shows "down" | Running the API on your host: check `host.docker.internal:3333` resolves from inside the `prometheus` container (`docker compose exec prometheus wget -qO- http://host.docker.internal:3333/metrics`); running it in `pnpm docker:up` mode instead, change the scrape target to `api:3333` in `deploy/observability/prometheus.yml` |
| An alert never seems to fire | Check `curl http://localhost:9090/api/v1/rules` for its current state (`inactive`/`pending`/`firing`) — most rules have a `for:` duration, so a brief blip alone won't trigger one |
| Catalog listing/search returns nothing even though `realCatalog: true` | The catalog store is empty or stale: `pnpm db:seed:catalog` |
| Cart/order calls return 403 "Missing CSRF header" | The frontend adapter should already add this automatically; if calling the API directly (curl, Postman), add `x-csrf: 1` to any non-GET `/cart` or `/orders` request |
| `docker` says it cannot connect to the daemon | Docker Desktop is not running; start it and retry |

## 6. Local Kubernetes

The manifests are in `deploy/k8s/base` (Kustomize). They include Deployments (2 replicas, rolling updates that never drop below the desired count, resource limits, startup, readiness and liveness probes, non-root, read-only filesystem), Services, an Ingress, autoscaling (HPA) and disruption budgets.

You need a local cluster (Docker Desktop's Kubernetes, kind or minikube) with an ingress controller and metrics-server.

```bash
pnpm k8s:render                          # print the final manifests (no cluster needed)
# the storefront and admin images are built in the eCommerce repository (docker compose build there)
# kind only:  kind load docker-image shop-storefront:local shop-admin:local
kubectl apply -k deploy/k8s/base
kubectl -n shop get pods
# then open http://shop.localtest.me and http://admin.localtest.me (both name 127.0.0.1)
```

Useful checks: `kubectl -n shop rollout status deploy/storefront`, `kubectl -n shop describe hpa storefront`, `kubectl -n shop logs deploy/storefront`.

HPA shows `cpu: <unknown>` until you also install metrics-server (Docker Desktop does not ship it): `kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml` (Docker Desktop's cluster needs `--kubelet-insecure-tls` added to its args). If `http://shop.localtest.me` does not load, something else on your machine (commonly another local web server) is already using port 80/443; check with `kubectl -n ingress-nginx get svc` and, if its `EXTERNAL-IP` never leaves `<pending>`, verify with `kubectl -n ingress-nginx port-forward svc/ingress-nginx-controller 18080:80` and `curl -H "Host: shop.localtest.me" http://127.0.0.1:18080/` instead.


## 7. Kubernetes (BRD 25)

Full-stack local deployment (needs Docker Desktop's Kubernetes, ingress-nginx and metrics-server - the latter patched with `--kubelet-insecure-tls`):

```bash
cp deploy/k8s/base/secrets/postgres.env.example deploy/k8s/base/secrets/postgres.env   # first time only (gitignored)
cp deploy/k8s/base/secrets/api.env.example deploy/k8s/base/secrets/api.env
cp deploy/k8s/data-tier/secrets/postgres.env.example deploy/k8s/data-tier/secrets/postgres.env
docker compose build api api-migrate                    # then tag it UNIQUELY, see below
kubectl apply -k deploy/k8s/data-tier                   # Postgres, in its own namespace (shop-data)
kubectl apply -k deploy/k8s/base                        # everything else, in namespace shop
```

- **Use a unique image tag per build** (`docker tag shop-api:local shop-api:build-123`, then `kubectl -n shop set image deployment/api-stable api=shop-api:build-123`) - pods created from a reused `:local` tag can silently run the previous build. Compare `kubectl get pod <pod> -o jsonpath='{.status.containerStatuses[0].imageID}'` with `docker inspect`.
- Reach it: `kubectl -n ingress-nginx port-forward svc/ingress-nginx-controller 18443:443`, then `curl -sk -H "Host: api.localtest.me" https://127.0.0.1:18443/readyz`. Use HTTPS - guest-cart cookies are `Secure`. (Docker Desktop's LoadBalancer stays `<pending>`.)
- The `api-migrate` and `catalog-seed` Jobs run once and their spec is immutable: delete the Job before re-applying.
- Canary release: `docs/CANARY-RELEASE.md`. Load tests: `deploy/load-tests/README.md`. Capacity, cost and disaster recovery: `docs/CAPACITY-PLAN.md`.
- Cloud (`deploy/terraform/aws`) and the deploy workflow (`.github/workflows/deploy.yml`) are **unrun** - see their headers.

| Symptom | Likely cause and fix |
|---|---|
| Pods `CrashLoopBackOff` with `Must call super constructor...` | The image was built with an old `apps/api/tsconfig.app.json` (target es2021) or the pod runs a stale image - rebuild, tag uniquely, check `imageID` |
| A Job's pods time out reaching Mongo/Redis/RabbitMQ | Its `job-name` label isn't in `deploy/k8s/base/network-policy.yaml`'s allow rule |
| `rabbitmq` never becomes ready though its log says startup complete | Exec probe timeout - keep `timeoutSeconds: 8` in `rabbitmq.yaml` |
| Everything gone after a reboot | Start Docker Desktop (and its Kubernetes) first; compose containers may need `docker compose up -d`, and `docker start shop-mongo shop-meili` |
