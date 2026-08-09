#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECK_SCRIPT="$ROOT_DIR/scripts/ops/check_system_health.sh"
BACKUP_DIR="${BACKUP_DIR:-$HOME/mbs-backups}"
HEALTH_REMEDIATE_LOCK_PATH="${HEALTH_REMEDIATE_LOCK_PATH:-$BACKUP_DIR/remediate.lock}"
HEALTH_REMEDIATE_LOCK_STALE_SECONDS="${HEALTH_REMEDIATE_LOCK_STALE_SECONDS:-1800}"

APPLY=false
AGGRESSIVE_DISK=false

sanitize_positive_int() {
  local raw="$1"
  local fallback="$2"
  if [[ "$raw" =~ ^[0-9]+$ ]] && (( raw > 0 )); then
    printf '%s' "$raw"
    return 0
  fi
  printf '%s' "$fallback"
}

usage() {
  cat <<USAGE
Usage:
  bash scripts/ops/remediate_from_health.sh [--apply] [--aggressive-disk]

Options:
  --apply            Execute remediation actions (default is dry-run only).
  --aggressive-disk  Use aggressive disk cleanup mode for disk pressure issues.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)
      APPLY=true
      shift
      ;;
    --aggressive-disk)
      AGGRESSIVE_DISK=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

HEALTH_REMEDIATE_LOCK_STALE_SECONDS="$(sanitize_positive_int "$HEALTH_REMEDIATE_LOCK_STALE_SECONDS" 1800)"
mkdir -p "$(dirname "$HEALTH_REMEDIATE_LOCK_PATH")"
timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
timestamp_epoch="$(date +%s)"
lock_acquired=false

if [[ -f "$HEALTH_REMEDIATE_LOCK_PATH" ]]; then
  lock_epoch_raw="$(awk -F= '/^createdAtEpoch=/{print $2; exit}' "$HEALTH_REMEDIATE_LOCK_PATH" | tr -d '[:space:]')"
  if [[ "$lock_epoch_raw" =~ ^[0-9]+$ ]]; then
    lock_age_seconds=$(( timestamp_epoch - lock_epoch_raw ))
    if (( lock_age_seconds >= 0 )) && (( lock_age_seconds > HEALTH_REMEDIATE_LOCK_STALE_SECONDS )); then
      rm -f "$HEALTH_REMEDIATE_LOCK_PATH" 2>/dev/null || true
      echo "[remediate] stale lock removed path=$HEALTH_REMEDIATE_LOCK_PATH age_seconds=$lock_age_seconds"
    fi
  fi
fi

if ( set -o noclobber; echo "pid=$$"$'\n'"createdAtEpoch=$timestamp_epoch"$'\n'"createdAtIso=$timestamp" >"$HEALTH_REMEDIATE_LOCK_PATH" ) 2>/dev/null; then
  lock_acquired=true
else
  echo "[remediate] lock busy path=$HEALTH_REMEDIATE_LOCK_PATH; skipping this run"
  exit 0
fi

cleanup_lock() {
  if [[ "$lock_acquired" == "true" ]]; then
    rm -f "$HEALTH_REMEDIATE_LOCK_PATH" 2>/dev/null || true
  fi
}
trap cleanup_lock EXIT

set +e
HEALTH_JSON="$(bash "$CHECK_SCRIPT" --json 2>&1)"
HEALTH_EXIT=$?
set -e

OVERALL="$(printf '%s' "$HEALTH_JSON" | sed -n 's/.*"overall":"\([^"]*\)".*/\1/p' | head -n 1)"
[[ -z "$OVERALL" ]] && OVERALL="UNKNOWN"

echo "[remediate] initial health_exit=$HEALTH_EXIT overall=$OVERALL"

if (( HEALTH_EXIT == 0 )); then
  echo "[remediate] health is already OK; nothing to remediate."
  exit 0
fi

ISSUE_KEYS="$(
  printf '%s' "$HEALTH_JSON" \
    | grep -o '"key":"[^"]*"' \
    | sed 's/"key":"//; s/"$//' \
    | sort -u || true
)"

if [[ -z "$ISSUE_KEYS" ]]; then
  echo "[remediate] no issue keys parsed from health payload."
  printf '%s\n' "$HEALTH_JSON"
  exit "$HEALTH_EXIT"
fi

echo "[remediate] issue keys:"
printf '  - %s\n' $ISSUE_KEYS

has_any_issue() {
  local key
  for key in "$@"; do
    if printf '%s\n' "$ISSUE_KEYS" | grep -qx "$key"; then
      return 0
    fi
  done
  return 1
}

run_step() {
  local label="$1"
  shift

  if [[ "$APPLY" == "true" ]]; then
    echo "[apply] $label"
    "$@"
  else
    echo "[dry-run] $label -> $*"
  fi
}

actions_planned=0

if has_any_issue "disk_free_low_gb" "disk_free_low_pct" "postgres_disk_full"; then
  actions_planned=$((actions_planned + 1))
  if [[ "$AGGRESSIVE_DISK" == "true" ]]; then
    run_step "Recover disk pressure (aggressive)" bash "$ROOT_DIR/scripts/ops/recover_disk_pressure.sh" --prune-aggressive
  else
    run_step "Recover disk pressure (safe)" bash "$ROOT_DIR/scripts/ops/recover_disk_pressure.sh" --prune-safe
  fi
fi

if has_any_issue "db_unreachable" "db_container_missing" "container_missing" "container_not_running"; then
  actions_planned=$((actions_planned + 1))
  run_step "Restart core containers" docker compose up -d postgres api worker
fi

if has_any_issue "launchd_not_loaded" "launchd_exit_nonzero"; then
  actions_planned=$((actions_planned + 1))
  run_step "Repair launchd jobs + kick health" bash "$ROOT_DIR/scripts/ops/repair_launchd_jobs.sh" --run-health-now
fi

if has_any_issue "backup_missing" "backup_dir_missing" "backup_stale" "backup_incomplete" "backup_manifest_invalid" "backup_checksum_mismatch" "backup_checksum_unavailable" "backup_archive_corrupt" "backup_archive_unavailable"; then
  actions_planned=$((actions_planned + 1))
  run_step "Create fresh backup snapshot" bash "$ROOT_DIR/scripts/ops/backup_nightly.sh"
fi

if has_any_issue "restore_drill_missing" "restore_drill_marker_invalid" "restore_drill_stale" "restore_drill_failed" "restore_drill_lock_stale"; then
  actions_planned=$((actions_planned + 1))
  run_step "Run latest restore drill" bash "$ROOT_DIR/scripts/ops/restore_latest_drill.sh"
fi

if has_any_issue "ops_snapshot_missing" "ops_snapshot_stale"; then
  actions_planned=$((actions_planned + 1))
  run_step "Refresh health snapshot pipeline" bash "$ROOT_DIR/scripts/ops/health_check_and_alert.sh"
fi

if has_any_issue "load_smoke_missing" "load_smoke_marker_invalid" "load_smoke_stale" "load_smoke_failed" "load_smoke_regressed" "load_smoke_latency_high" "load_smoke_trend_failed"; then
  actions_planned=$((actions_planned + 1))
  run_step "Record fresh load smoke baseline" bash "$ROOT_DIR/scripts/ops/load_smoke_record.sh"
fi

if (( actions_planned == 0 )); then
  echo "[remediate] no mapped remediations for current issue keys."
  exit "$HEALTH_EXIT"
fi

if [[ "$APPLY" != "true" ]]; then
  echo "[remediate] dry-run complete; rerun with --apply to execute."
  exit "$HEALTH_EXIT"
fi

set +e
POST_JSON="$(bash "$CHECK_SCRIPT" --json 2>&1)"
POST_EXIT=$?
set -e

POST_OVERALL="$(printf '%s' "$POST_JSON" | sed -n 's/.*"overall":"\([^"]*\)".*/\1/p' | head -n 1)"
[[ -z "$POST_OVERALL" ]] && POST_OVERALL="UNKNOWN"
echo "[remediate] post-remediation health_exit=$POST_EXIT overall=$POST_OVERALL"
printf '%s\n' "$POST_JSON"

exit "$POST_EXIT"
