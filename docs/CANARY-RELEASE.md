# Canary releases (BRD 25, K8-03)

The API runs as two Deployments behind one Service (`deploy/k8s/base/api.yaml`): `api-stable` (normally 2+
pods, autoscaled) and `api-canary` (0 pods until you start a release). Both carry the label `app: api`, and a
Kubernetes Service load-balances across every pod matching its selector, so **the replica ratio is the traffic
split** — 7 stable + 1 canary sends roughly 1/8 of requests to the new version. No service mesh needed; the
price is that the split is approximate and by pod count, not an exact percentage.

## Run one

```bash
TAG=build-$(date +%s)
docker compose build api && docker tag shop-api:local shop-api:$TAG    # always a NEW tag, see "Gotchas"
kubectl -n shop set image deployment/api-canary api=shop-api:$TAG
kubectl -n shop scale deployment/api-canary --replicas=1
kubectl -n shop rollout status deployment/api-canary

WINDOW=120 MAX_ERROR_RATE=0.02 deploy/scripts/canary-check.sh          # exits 1 and scales the canary to 0 if bad
```

If it passes, promote: `kubectl -n shop set image deployment/api-stable api=shop-api:$TAG` (a normal rolling
update that never drops below the desired count), then `kubectl -n shop scale deployment/api-canary --replicas=0`.

## What the automatic abort does and doesn't do

`canary-check.sh` reads the canary pod's own `/metrics` (BRD 24) twice, `WINDOW` seconds apart, and aborts if its
5xx share exceeds `MAX_ERROR_RATE`, **or if it received fewer than `MIN_REQUESTS` requests** (a canary that saw no
traffic hasn't been tested, so "no errors" would be a false pass). Verified: the decision logic on healthy,
failing and silent samples, and a live run against a real canary pod. **Not** verified: a canary that really
starts returning 5xx under real traffic — that branch was exercised only with synthetic metrics. It also judges
errors only, not latency; add a p95 check before relying on it for performance regressions.

`.github/workflows/deploy.yml` runs this same script as its production gate (that workflow is unexercised — see
its header).

## Gotchas found the hard way

- **Reusing an image tag can silently run the old image.** After rebuilding `shop-api:local`, pods created from
  the `:local` tag came up on the *previous* build (the cluster's runtime keeps its own image cache; the pod's
  `imageID` showed the stale digest). Tag every build uniquely and compare `imageID` against `docker inspect`.
- `kubectl set env` / `set image` changes are not tracked by `kubectl apply`, so a later `apply -k` will not undo
  them. Remove them explicitly (`kubectl set env deployment/api-stable NAME-`).
- The canary shares the database. A release with a destructive migration can't be canaried safely — migrations
  must be backward-compatible with the previous version for the overlap window.
