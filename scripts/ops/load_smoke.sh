#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${LOAD_SMOKE_BASE_URL:-http://localhost:3001}"
ENDPOINT="${LOAD_SMOKE_ENDPOINT:-/health}"
REQUESTS="${LOAD_SMOKE_REQUESTS:-120}"
CONCURRENCY="${LOAD_SMOKE_CONCURRENCY:-12}"
TIMEOUT_SECONDS="${LOAD_SMOKE_TIMEOUT_SECONDS:-8}"
EXPECT_HTTP="${LOAD_SMOKE_EXPECT_HTTP:-200}"
AUTH_TOKEN="${LOAD_SMOKE_AUTH_TOKEN:-}"
MIN_SUCCESS_PCT="${LOAD_SMOKE_MIN_SUCCESS_PCT:-100}"
MAX_P95_SECONDS="${LOAD_SMOKE_MAX_P95_SECONDS:-0}"
JSON_MODE=false

usage() {
  cat <<USAGE
Usage:
  bash scripts/ops/load_smoke.sh [--json]

Options:
  --json   Emit JSON summary instead of human-readable text.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)
      JSON_MODE=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1"
      usage
      exit 2
      ;;
  esac
done

if ! [[ "$REQUESTS" =~ ^[0-9]+$ ]] || ! [[ "$CONCURRENCY" =~ ^[0-9]+$ ]]; then
  echo "REQUESTS and CONCURRENCY must be integers"
  exit 1
fi
if (( REQUESTS < 1 || CONCURRENCY < 1 )); then
  echo "REQUESTS and CONCURRENCY must be >= 1"
  exit 1
fi
if ! [[ "$MIN_SUCCESS_PCT" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo "LOAD_SMOKE_MIN_SUCCESS_PCT must be numeric"
  exit 1
fi
if ! [[ "$MAX_P95_SECONDS" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo "LOAD_SMOKE_MAX_P95_SECONDS must be numeric"
  exit 1
fi

TARGET_URL="${BASE_URL%/}$ENDPOINT"
TMP_RESULTS="$(mktemp)"

request_once() {
  local url="$1"
  local timeout="$2"
  local expected="$3"
  local token="$4"

  local output
  if [[ -n "$token" ]]; then
    output="$(curl -sS -o /dev/null --max-time "$timeout" \
      -H "authorization: Bearer $token" \
      -w "%{time_total} %{http_code}" "$url" 2>/dev/null || true)"
  else
    output="$(curl -sS -o /dev/null --max-time "$timeout" \
      -w "%{time_total} %{http_code}" "$url" 2>/dev/null || true)"
  fi

  local t code
  t="$(awk '{print $1}' <<<"$output")"
  code="$(awk '{print $2}' <<<"$output")"
  if [[ -z "$t" || -z "$code" ]]; then
    printf '%s %s\n' "timeout" "000"
    return
  fi
  printf '%s %s\n' "$t" "$code"
}

export -f request_once

seq "$REQUESTS" \
  | xargs -n1 -P"$CONCURRENCY" -I{} bash -c 'request_once "$@"' _ \
      "$TARGET_URL" "$TIMEOUT_SECONDS" "$EXPECT_HTTP" "$AUTH_TOKEN" \
  >"$TMP_RESULTS"

total_count="$(wc -l < "$TMP_RESULTS" | tr -d ' ')"
ok_count="$(awk -v code="$EXPECT_HTTP" '$2 == code {count+=1} END {print count+0}' "$TMP_RESULTS")"
timeout_count="$(awk '$1 == "timeout" {count+=1} END {print count+0}' "$TMP_RESULTS")"

latency_file="$(mktemp)"
awk '$1 != "timeout" && $1 ~ /^[0-9.]+$/ {print $1}' "$TMP_RESULTS" | sort -n >"$latency_file"
latency_count="$(wc -l < "$latency_file" | tr -d ' ')"

percentile() {
  local p="$1"
  local count="$2"
  local file="$3"
  if (( count == 0 )); then
    echo "0"
    return
  fi
  local idx
  idx="$(awk -v c="$count" -v pct="$p" 'BEGIN { i=int((pct/100.0)*c); if (i < 1) i=1; if (i>c) i=c; print i }')"
  sed -n "${idx}p" "$file"
}

p50="$(percentile 50 "$latency_count" "$latency_file")"
p95="$(percentile 95 "$latency_count" "$latency_file")"
p99="$(percentile 99 "$latency_count" "$latency_file")"

if (( total_count == 0 )); then
  success_pct="0.00"
else
  success_pct="$(awk -v ok="$ok_count" -v total="$total_count" 'BEGIN { printf "%.2f", (ok/total)*100 }')"
fi

is_success_pct_ok="$(awk -v actual="$success_pct" -v min="$MIN_SUCCESS_PCT" 'BEGIN { if (actual + 0 >= min + 0) print "true"; else print "false" }')"
is_p95_ok="true"
if awk -v max="$MAX_P95_SECONDS" 'BEGIN { exit !(max + 0 > 0) }'; then
  is_p95_ok="$(awk -v actual="$p95" -v max="$MAX_P95_SECONDS" 'BEGIN { if (actual + 0 <= max + 0) print "true"; else print "false" }')"
fi

status="PASS"
if [[ "$is_success_pct_ok" != "true" || "$is_p95_ok" != "true" ]]; then
  status="FAIL"
fi

if [[ "$JSON_MODE" == "true" ]]; then
  printf '{"status":"%s","url":"%s","requests":%s,"concurrency":%s,"timeoutSeconds":%s,"expectedHttp":%s,"totalCount":%s,"okCount":%s,"timeoutCount":%s,"successPct":%s,"latency":{"p50":%s,"p95":%s,"p99":%s},"thresholds":{"minSuccessPct":%s,"maxP95Seconds":%s}}\n' \
    "$status" \
    "$TARGET_URL" \
    "$REQUESTS" \
    "$CONCURRENCY" \
    "$TIMEOUT_SECONDS" \
    "$EXPECT_HTTP" \
    "$total_count" \
    "$ok_count" \
    "$timeout_count" \
    "$success_pct" \
    "$p50" \
    "$p95" \
    "$p99" \
    "$MIN_SUCCESS_PCT" \
    "$MAX_P95_SECONDS"
else
  echo "load smoke summary"
  echo "  url=$TARGET_URL"
  echo "  requests=$REQUESTS concurrency=$CONCURRENCY timeout=${TIMEOUT_SECONDS}s expected_http=$EXPECT_HTTP"
  echo "  total=$total_count ok=$ok_count success_pct=${success_pct}% timeout=$timeout_count"
  echo "  latency_sec p50=$p50 p95=$p95 p99=$p99"
  echo "  thresholds min_success_pct=$MIN_SUCCESS_PCT max_p95_seconds=$MAX_P95_SECONDS"
  echo "  status=$status"
fi

rm -f "$TMP_RESULTS" "$latency_file"

if [[ "$status" == "PASS" ]]; then
  exit 0
fi
exit 1
