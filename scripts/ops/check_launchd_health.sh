#!/usr/bin/env bash
set -euo pipefail

USER_UID="$(id -u)"
DOMAIN="gui/$USER_UID"
BACKUP_DIR="${BACKUP_DIR:-$HOME/mbs-backups}"
HEALTH_LAUNCHD_PLIST_DIR="${HEALTH_LAUNCHD_PLIST_DIR:-$HOME/Library/LaunchAgents}"
HEALTH_LAUNCHD_EXPECT_ALL_LABELS="${HEALTH_LAUNCHD_EXPECT_ALL_LABELS:-false}"

LABELS=(
  "com.rcs.backup.nightly"
  "com.rcs.restore.weekly"
  "com.rcs.logs.rotate.weekly"
  "com.rcs.loadsmoke.weekly"
  "com.rcs.health.hourly"
)

build_labels_to_check() {
  local expect_all
  expect_all="$(printf '%s' "$HEALTH_LAUNCHD_EXPECT_ALL_LABELS" | tr '[:upper:]' '[:lower:]')"
  if [[ "$expect_all" == "1" || "$expect_all" == "true" || "$expect_all" == "yes" ]]; then
    printf '%s\n' "${LABELS[@]}"
    return 0
  fi

  local label
  for label in "${LABELS[@]}"; do
    if [[ -f "$HEALTH_LAUNCHD_PLIST_DIR/$label.plist" ]]; then
      printf '%s\n' "$label"
    fi
  done
}

print_job_summary() {
  local label="$1"
  local raw
  if ! raw="$(launchctl print "$DOMAIN/$label" 2>/dev/null)"; then
    printf "%-30s %-12s %-8s %-8s\n" "$label" "NOT_LOADED" "-" "-"
    return 0
  fi

  local state
  local runs
  local exit_code
  state="$(printf '%s\n' "$raw" | awk -F'= ' '/^[[:space:]]*state =/{print $2; exit}')"
  runs="$(printf '%s\n' "$raw" | awk -F'= ' '/^[[:space:]]*runs =/{print $2; exit}')"
  exit_code="$(printf '%s\n' "$raw" | awk -F'= ' '/^[[:space:]]*last exit code =/{print $2; exit}')"

  [[ -z "$state" ]] && state="unknown"
  [[ -z "$runs" ]] && runs="-"
  [[ -z "$exit_code" ]] && exit_code="-"

  printf "%-30s %-12s %-8s %-8s\n" "$label" "$state" "$runs" "$exit_code"
}

show_error_tail() {
  local file_path="$1"
  if [[ ! -f "$file_path" ]]; then
    echo "  (missing) $file_path"
    return 0
  fi

  local lines
  lines="$(tail -n 200 "$file_path" | rg -i "error|failed|permission denied|operation not permitted|fatal|exception|not found|denied" || true)"
  lines="$(printf '%s\n' "$lines" | rg -v "health_exit=0 payload=|\"failedOutbox\":0|\"failedExecutions1h\":0|\"pendingOutbox\":0|\"pendingApprovals\":0|\"stalePendingOutbox\":0|failed_outbox=0|failed_executions_1h=0|pending_outbox=0|pending_approvals=0|stale_pending_outbox=0" || true)"
  if [[ -z "$lines" ]]; then
    echo "  no recent error-like lines in $(basename "$file_path")"
    return 0
  fi

  echo "  $(basename "$file_path"):"
  printf '%s\n' "$lines" | tail -n 20 | sed 's/^/    /'
}

echo "launchd job health ($DOMAIN)"
printf "%-30s %-12s %-8s %-8s\n" "LABEL" "STATE" "RUNS" "EXIT"
printf "%-30s %-12s %-8s %-8s\n" "-----" "-----" "----" "----"
mapfile -t CHECK_LABELS < <(build_labels_to_check)
if (( ${#CHECK_LABELS[@]} == 0 )); then
  echo "no installed com.rcs launchd jobs found under $HEALTH_LAUNCHD_PLIST_DIR"
  echo "(set HEALTH_LAUNCHD_EXPECT_ALL_LABELS=true to check all standard labels)"
else
  for label in "${CHECK_LABELS[@]}"; do
    print_job_summary "$label"
  done
fi

echo
echo "recent error scan ($BACKUP_DIR)"
show_error_tail "$BACKUP_DIR/backup.log"
show_error_tail "$BACKUP_DIR/restore-drill.log"
show_error_tail "$BACKUP_DIR/load-smoke.log"
show_error_tail "$BACKUP_DIR/health.log"
show_error_tail "$BACKUP_DIR/health-alert.log"
