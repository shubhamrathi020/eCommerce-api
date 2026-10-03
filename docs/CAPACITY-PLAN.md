# Capacity plan, cost estimate and disaster recovery (BRD 25, K8-07)

Everything marked **measured** was observed on the local single-node Kubernetes cluster (Docker Desktop on one
Windows machine, with the load generator and every database on that same machine). Everything marked
**estimate** is reasoning or a rough price, not an observation. **The master BR's design targets — 10,000
concurrent users and 1,000 orders per minute — were not tested and cannot be on this hardware.** Treat §3 as a
starting hypothesis to confirm in the cloud, not a promise.

## 1. Targets (from the master BR)

99.9% availability · 10,000 concurrent users · 1,000 orders/minute (≈ 16.7 orders/second) · p95 targets in
`deploy/load-tests/*.js` (browse < 500 ms, search < 600 ms, checkout < 1.5 s).

## 2. What was measured

| Scenario | Load | Result |
|---|---|---|
| Browse | 50 concurrent users, 77 req/s, 2,734 iterations | p95 **7.8 ms**, 0% errors |
| Search | 30 concurrent users, 45 req/s | p95 **53 ms**, 0% errors |
| Checkout (COD) | 15 concurrent users, 223 orders placed in ~70 s (≈ 3 orders/s) | p95 **88 ms**, **0 5xx**, outbox backlog **0**; the autoscaler grew the API 2 → 7 pods (CPU 122% of request) |
| Flash-sale last unit | 80 buyers race for 20 units, run twice from a clean reset | stock ended at **exactly 0** and exactly **20** orders existed, both times — **no oversell**; losing buyers got clean 4xx, never a 5xx |

What these do **not** show:
- Checkout's "44% failures" in k6's own summary are 4xx rejections once the six test variants ran out of stock
  (and the empty-cart rejections that follow) — not errors, but they did trip the script's threshold, so that
  threshold is not a clean pass. The result to trust is "0 5xx, 223 real orders, 0 backlog".
- ≈ 3 orders/s is where the *test* stopped (15 users, limited stock), **not** where the system saturated. No
  saturation point was found for any scenario.
- The load generator, API pods, Postgres, Mongo, Redis, RabbitMQ and Meilisearch all shared one machine.

## 3. Sizing hypothesis for the targets (estimate)

- **API:** at ≈ 3 orders/s the two pods used roughly 0.25 CPU in total, so 16.7 orders/s is on the order of
  1.5 cores of API work *if scaling were linear*, plus the browse traffic that surrounds orders. The HPA
  (`api-stable`, 2–8 pods at 70% CPU) is sized for that; the 8-pod ceiling is a guess to revisit after a real
  cloud run. CPU is probably not the first limit — the next point is.
- **Postgres is the likely first bottleneck** at 1,000 orders/min: every order is a transaction (order row +
  outbox row) plus cart and idempotency lookups. Start at `db.t4g.medium`, Multi-AZ in production, and measure.
  **Mongo** takes one atomic stock update per order line — the flash-sale test shows it stays correct under
  contention, not how fast it is at 16 orders/s.
- **Per-IP rate limits** (defaults 300/min global, 20/min checkout) are far below what 10,000 real users produce
  if many share an address (office, mobile carrier NAT). They are env-tunable (`RATE_LIMIT_*_PER_MIN`) and must be
  re-set with real-traffic data, probably keyed on user/session as well as IP. Left at defaults, they would
  throttle a legitimate flash sale.
- **RabbitMQ / Redis / Meilisearch** are single instances in the cluster. Fine for staging; production needs a
  clustered broker (or managed equivalent) before 99.9% is credible.
- **Availability (99.9% = ~8.8 h/year of downtime):** needs ≥ 2 nodes across 2 zones, Multi-AZ Postgres, and
  pod disruption budgets (already in place). A single NAT gateway or single-instance Redis/Mongo/RabbitMQ would
  break this on its own.

## 4. Cost estimate (rough, AWS ap-south-1, on-demand, USD/month)

**Not a quote.** Prices recalled from memory of public list prices and not re-checked; expect ±30%. Use the AWS
Pricing Calculator before committing. Excludes data transfer, CloudWatch/log volume, Secrets Manager, ECR, and
engineering time.

| Item | Staging | Production (starting point) |
|---|---|---|
| EKS control plane | ~ $73 | ~ $73 |
| Worker nodes (t3.large) | 2 × ~$65 ≈ $130 | 4 × ~$65 ≈ $260 |
| NAT gateway | 1 ≈ $40 | 2 ≈ $80 |
| RDS Postgres db.t4g.medium | ~ $60 | Multi-AZ ≈ $120 |
| ElastiCache cache.t4g.small | ~ $30 | ~ $30 (add a replica ≈ +$30) |
| Mongo / RabbitMQ / Meilisearch | in-cluster (inside node cost) | in-cluster; managed equivalents cost more |
| **Rough total** | **≈ $330** | **≈ $560 – $800** |

Cheapest honest path: keep staging torn down except when testing (`terraform destroy`), roughly $0.45/hour while up.

## 5. Disaster recovery runbook

Targets (BRD 24): **RPO 15 minutes, RTO 1 hour.**

| Data | Where it lives | Protection | Recovery |
|---|---|---|---|
| Orders, users, carts, outbox | Postgres | RDS automated backups with point-in-time recovery (7 days, in `deploy/terraform/aws`); locally `pnpm backup` | Restore to a new instance at the chosen time, repoint `DATABASE_URL`, roll the API |
| Catalog, reviews | Mongo | Scheduled `mongodump` (`scripts/backup.mjs`); in cloud, snapshot the volume or use a managed service | `mongorestore`, then rebuild the search index |
| Search index | Meilisearch | None needed — derived from Mongo | Re-run the catalog-seed Job (`deploy/k8s/base/api.yaml`) |
| Cache, rate-limit counters, locks | Redis | None needed — all rebuildable or expiring | Start an empty Redis; first requests are slower |
| Queued notifications | RabbitMQ | PVC-backed queues; the **outbox table is the safety net** | Unpublished outbox rows republish on their own once the broker is back; consumers de-duplicate. A message that was already published and then lost with the broker is **not** recovered — it would be a missed email |
| Secrets | Secrets Manager (cloud) / gitignored env files (local) | Not in git by design | Re-create from the password manager / Secrets Manager |

**Scenarios**
1. *Bad release:* `kubectl -n shop rollout undo deployment/api-stable` (seconds). If it was a canary, the abort
   script already scaled it to 0.
2. *Postgres lost or corrupted:* restore a new instance to just before the incident (PITR), update the secret and
   `DATABASE_URL`, `kubectl rollout restart`. Expect minutes for the restore plus DNS/secret propagation.
   Orders placed after the restore point are lost — that is the RPO.
3. *Whole cluster lost:* `terraform apply` a new one (untested — see §6), apply `deploy/k8s/data-tier` then
   `deploy/k8s/base`, restore Postgres and Mongo, run the migrate and catalog-seed Jobs.
4. *Region outage:* **not covered** — multi-region is explicitly out of scope for BRD 25.

**Measured:** a full Postgres backup → restore → row-count-verified drill on development data took **1.9 s**
(BRD 24). That is a fixed-cost floor on tiny data, not a prediction for production-sized data; **rehearse the
cloud restore with production-like volume before relying on a 1-hour RTO.** Nobody has yet run any of the
cloud-side steps above.

## 6. Known gaps (so they aren't discovered later)

- Terraform (`deploy/terraform/aws`) and the deploy pipeline (`.github/workflows/deploy.yml`) were **written
  but never run** — no cloud account, and `terraform` is not installed here. "Staging created and destroyed
  from code" is therefore **not demonstrated**.
- Autoscaling is CPU-only; scaling consumers on RabbitMQ queue depth needs KEDA, which isn't installed.
- No test of a real node failure, zone loss, or pod-disruption during load.
- The canary abort was proven on synthetic error samples and a healthy live canary, not a canary that genuinely fails.
- No load test at or near the design targets; no soak test (hours); no test with Razorpay online payments.
