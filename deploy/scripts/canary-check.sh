#!/usr/bin/env bash
# Automatic canary abort (BRD 25, K8-03: "a canary release can be aborted automatically on errors").
#
# Watches the canary pod's own /metrics (BRD 24's http_requests_total) for WINDOW seconds, and exits non-zero
# — after scaling the canary back to 0 — if its 5xx share of requests exceeds MAX_ERROR_RATE. Needs at least
# MIN_REQUESTS to have reached the canary: a canary that received no traffic proves nothing, and silently
# "passing" it would defeat the point, so that is treated as a failure too.
#
# Usage:  deploy/scripts/canary-check.sh            (defaults below)
#         WINDOW=120 MAX_ERROR_RATE=0.01 deploy/scripts/canary-check.sh
# Test the decision logic without a cluster:  METRICS_FILE=before.txt METRICS_FILE_AFTER=after.txt WINDOW=0 deploy/scripts/canary-check.sh
set -euo pipefail

NAMESPACE="${NAMESPACE:-shop}"
WINDOW="${WINDOW:-60}"
MAX_ERROR_RATE="${MAX_ERROR_RATE:-0.05}"
MIN_REQUESTS="${MIN_REQUESTS:-20}"

fetch() {
  # Offline mode for testing the decision logic: first sample from METRICS_FILE, second (if given) from METRICS_FILE_AFTER.
  if [ -n "${METRICS_FILE:-}" ]; then if [ "${1:-}" = after ] && [ -n "${METRICS_FILE_AFTER:-}" ]; then cat "$METRICS_FILE_AFTER"; else cat "$METRICS_FILE"; fi; return; fi
  local pod
  pod=$(kubectl -n "$NAMESPACE" get pod -l app=api,track=canary -o jsonpath='{.items[0].metadata.name}')
  kubectl -n "$NAMESPACE" exec "$pod" -- sh -c 'wget -qO- http://127.0.0.1:3333/metrics'
}

# "total errors" from the http_requests_total counter, across every route.
totals() { fetch "${1:-}" | awk '/^http_requests_total\{/ { n=$NF; total+=n; if ($0 ~ /status="5[0-9][0-9]"/) err+=n } END { printf "%d %d\n", total, err }'; }

read -r t0 e0 < <(totals)
[ "$WINDOW" -gt 0 ] && sleep "$WINDOW"
read -r t1 e1 < <(totals after)

total=$((t1 - t0)); errors=$((e1 - e0))
rate=$(awk -v e="$errors" -v t="$total" 'BEGIN { printf "%.4f", (t == 0 ? 0 : e / t) }')
echo "canary window: $total requests, $errors 5xx (rate $rate, limit $MAX_ERROR_RATE, minimum $MIN_REQUESTS requests)"

abort() {
  echo "ABORT: $1"
  [ -z "${METRICS_FILE:-}" ] && kubectl -n "$NAMESPACE" scale deployment/api-canary --replicas=0
  exit 1
}

[ "$total" -lt "$MIN_REQUESTS" ] && abort "canary only saw $total requests — not enough traffic to judge it"
awk -v r="$rate" -v m="$MAX_ERROR_RATE" 'BEGIN { exit !(r > m) }' && abort "error rate $rate exceeds $MAX_ERROR_RATE"
echo "OK: canary is healthy"
