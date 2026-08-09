#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  source .env
fi

BACKUP_DIR="${BACKUP_DIR:-$HOME/mbs-backups}"
LOAD_SMOKE_MARKER_PATH="${HEALTH_LOAD_SMOKE_MARKER_PATH:-$BACKUP_DIR/load-smoke.marker}"
LOAD_SMOKE_HISTORY_PATH="${HEALTH_LOAD_SMOKE_HISTORY_PATH:-$BACKUP_DIR/load-smoke-history.jsonl}"
LOAD_SMOKE_HISTORY_MAX_LINES="${HEALTH_LOAD_SMOKE_HISTORY_MAX_LINES:-5000}"
LOAD_SMOKE_LOG_PATH="${LOAD_SMOKE_LOG_PATH:-$BACKUP_DIR/load-smoke.log}"
LOAD_SMOKE_SCRIPT="$ROOT_DIR/scripts/ops/load_smoke.sh"

mkdir -p "$(dirname "$LOAD_SMOKE_MARKER_PATH")"
mkdir -p "$(dirname "$LOAD_SMOKE_HISTORY_PATH")"
mkdir -p "$(dirname "$LOAD_SMOKE_LOG_PATH")"

set +e
load_smoke_raw_output="$(bash "$LOAD_SMOKE_SCRIPT" --json 2>&1)"
load_smoke_exit=$?
set -e

load_smoke_json="$(printf '%s\n' "$load_smoke_raw_output" | grep -Eo '\{.*\}' | tail -n 1 || true)"
if [[ -z "$load_smoke_json" ]]; then
  load_smoke_json='{}'
fi

timestamp_epoch="$(date +%s)"
timestamp_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
status="failed"
if (( load_smoke_exit == 0 )); then
  status="success"
fi

extract_json_field() {
  local key="$1"
  local string_match
  string_match="$(printf '%s' "$load_smoke_json" | grep -o "\"$key\":\"[^\"]*\"" | head -n 1 || true)"
  if [[ -n "$string_match" ]]; then
    printf '%s' "$string_match" | sed "s/^\"$key\":\"//; s/\"$//"
    return 0
  fi
  local numeric_match
  numeric_match="$(printf '%s' "$load_smoke_json" | grep -o "\"$key\":[0-9.][0-9.]*" | head -n 1 || true)"
  if [[ -n "$numeric_match" ]]; then
    printf '%s' "$numeric_match" | sed "s/^\"$key\"://"
    return 0
  fi
  printf ''
}

success_pct="$(extract_json_field "successPct")"
p95_seconds="$(printf '%s' "$load_smoke_json" | sed -n 's/.*"p95":\([0-9.][0-9.]*\).*/\1/p' | head -n 1)"
target_url="$(extract_json_field "url")"
result_status="$(extract_json_field "status")"

load_smoke_marker_tmp="$(mktemp "${LOAD_SMOKE_MARKER_PATH}.tmp.XXXXXX")"
cat >"$load_smoke_marker_tmp" <<EOF
status=$status
completedAtEpoch=$timestamp_epoch
completedAtIso=$timestamp_iso
resultStatus=${result_status:-UNKNOWN}
exitCode=$load_smoke_exit
successPct=${success_pct:-0}
p95Seconds=${p95_seconds:-0}
targetUrl=${target_url:-}
EOF
mv "$load_smoke_marker_tmp" "$LOAD_SMOKE_MARKER_PATH"

printf '%s\n' "$load_smoke_json" >>"$LOAD_SMOKE_HISTORY_PATH"

if [[ "$LOAD_SMOKE_HISTORY_MAX_LINES" =~ ^[0-9]+$ ]] && (( LOAD_SMOKE_HISTORY_MAX_LINES > 0 )); then
  current_lines="$(wc -l < "$LOAD_SMOKE_HISTORY_PATH" | tr -d '[:space:]')"
  if [[ "$current_lines" =~ ^[0-9]+$ ]] && (( current_lines > LOAD_SMOKE_HISTORY_MAX_LINES )); then
    tmp_file="$LOAD_SMOKE_HISTORY_PATH.trim.$$"
    tail -n "$LOAD_SMOKE_HISTORY_MAX_LINES" "$LOAD_SMOKE_HISTORY_PATH" > "$tmp_file"
    mv "$tmp_file" "$LOAD_SMOKE_HISTORY_PATH"
  fi
fi

printf '[%s] status=%s exit=%s marker=%s payload=%s raw=%s\n' \
  "$timestamp_iso" "$status" "$load_smoke_exit" "$LOAD_SMOKE_MARKER_PATH" "$load_smoke_json" "$load_smoke_raw_output" >>"$LOAD_SMOKE_LOG_PATH"

if (( load_smoke_exit == 0 )); then
  echo "[load-smoke-record] success marker updated: $LOAD_SMOKE_MARKER_PATH"
  exit 0
fi

echo "[load-smoke-record] failed marker updated: $LOAD_SMOKE_MARKER_PATH"
exit "$load_smoke_exit"
