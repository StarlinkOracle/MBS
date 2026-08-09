#!/usr/bin/env bash
set -euo pipefail

USER_UID="$(id -u)"
DOMAIN="gui/$USER_UID"
OUTPUT_DIR="${LAUNCHD_OUTPUT_DIR:-$HOME/Library/LaunchAgents}"
RUN_HEALTH_NOW=false
DRY_RUN=false

LABELS=(
  "com.rcs.backup.nightly"
  "com.rcs.restore.weekly"
  "com.rcs.logs.rotate.weekly"
  "com.rcs.loadsmoke.weekly"
  "com.rcs.health.hourly"
)

usage() {
  cat <<USAGE
Usage:
  bash scripts/ops/repair_launchd_jobs.sh [--run-health-now] [--dry-run]

Options:
  --run-health-now  Kickstart com.rcs.health.hourly after repair pass
  --dry-run         Print intended actions only
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-health-now)
      RUN_HEALTH_NOW=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
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

bootstrapped=0
recycled=0
missing_plists=0
repair_failures=0

run_or_echo() {
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] $*"
    return 0
  fi
  "$@"
}

print_status() {
  local label="$1"
  local raw="$2"
  local state runs exit_code
  state="$(printf '%s\n' "$raw" | awk -F'= ' '/^[[:space:]]*state =/{print $2; exit}')"
  runs="$(printf '%s\n' "$raw" | awk -F'= ' '/^[[:space:]]*runs =/{print $2; exit}')"
  exit_code="$(printf '%s\n' "$raw" | awk -F'= ' '/^[[:space:]]*last exit code =/{print $2; exit}')"
  [[ -z "$state" ]] && state="unknown"
  [[ -z "$runs" ]] && runs="-"
  [[ -z "$exit_code" ]] && exit_code="-"
  printf "%-30s %-12s %-8s %-8s\n" "$label" "$state" "$runs" "$exit_code"
}

echo "launchd repair pass ($DOMAIN)"
printf "%-30s %-12s %-8s %-8s\n" "LABEL" "STATE" "RUNS" "EXIT"
printf "%-30s %-12s %-8s %-8s\n" "-----" "-----" "----" "----"

for label in "${LABELS[@]}"; do
  plist="$OUTPUT_DIR/$label.plist"
  raw="$(launchctl print "$DOMAIN/$label" 2>/dev/null || true)"

  if [[ -z "$raw" ]]; then
    printf "%-30s %-12s %-8s %-8s\n" "$label" "NOT_LOADED" "-" "-"
    if [[ ! -f "$plist" ]]; then
      echo "  [warn] plist missing: $plist"
      missing_plists=$((missing_plists + 1))
      continue
    fi

    echo "  [repair] bootstrapping $label"
    if run_or_echo launchctl bootstrap "$DOMAIN" "$plist"; then
      bootstrapped=$((bootstrapped + 1))
    else
      echo "  [error] bootstrap failed for $label (domain=$DOMAIN)"
      repair_failures=$((repair_failures + 1))
    fi
    continue
  fi

  print_status "$label" "$raw"
  last_exit="$(printf '%s\n' "$raw" | awk -F'= ' '/^[[:space:]]*last exit code =/{print $2; exit}')"
  if [[ -n "$last_exit" && "$last_exit" != "0" && "$last_exit" != "(never exited)" ]]; then
    if [[ ! -f "$plist" ]]; then
      echo "  [warn] cannot recycle $label (plist missing: $plist)"
      missing_plists=$((missing_plists + 1))
      continue
    fi

    echo "  [repair] recycling $label due to last exit code $last_exit"
    run_or_echo launchctl bootout "$DOMAIN" "$plist" || true
    if run_or_echo launchctl bootstrap "$DOMAIN" "$plist"; then
      recycled=$((recycled + 1))
    else
      echo "  [error] recycle bootstrap failed for $label (domain=$DOMAIN)"
      repair_failures=$((repair_failures + 1))
    fi
  fi
done

if [[ "$RUN_HEALTH_NOW" == "true" ]]; then
  echo "[repair] kickstarting com.rcs.health.hourly"
  if ! run_or_echo launchctl kickstart -k "$DOMAIN/com.rcs.health.hourly"; then
    echo "  [error] unable to kickstart com.rcs.health.hourly in $DOMAIN"
    repair_failures=$((repair_failures + 1))
  fi
fi

echo
printf 'summary: bootstrapped=%s recycled=%s missing_plists=%s repair_failures=%s\n' "$bootstrapped" "$recycled" "$missing_plists" "$repair_failures"

if (( missing_plists > 0 )); then
  echo "next action: run scripts/ops/install_launchd_jobs.sh --load"
fi

if (( repair_failures > 0 )); then
  echo "next action: run scripts/ops/install_launchd_jobs.sh --load from an interactive macOS user session, then retry this script."
  exit 2
fi
