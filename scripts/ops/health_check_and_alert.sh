#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECK_SCRIPT="$ROOT_DIR/scripts/ops/check_system_health.sh"

BACKUP_DIR="${BACKUP_DIR:-$HOME/mbs-backups}"
LOG_PATH="${HEALTH_ALERT_LOG_PATH:-$BACKUP_DIR/health-alert.log}"
INCIDENT_DIR="${HEALTH_INCIDENT_DIR:-$BACKUP_DIR/incidents}"
SNAPSHOT_LOG_PATH="${HEALTH_SNAPSHOT_LOG_PATH:-$BACKUP_DIR/health-history.jsonl}"
ALERT_RETRY_ATTEMPTS="${HEALTH_ALERT_RETRY_ATTEMPTS:-3}"
ALERT_RETRY_BASE_DELAY_SECONDS="${HEALTH_ALERT_RETRY_BASE_DELAY_SECONDS:-2}"
ALERT_MAX_TIME_SECONDS="${HEALTH_ALERT_MAX_TIME_SECONDS:-10}"
HEALTH_ALERT_DEDUPE_MINUTES="${HEALTH_ALERT_DEDUPE_MINUTES:-30}"
HEALTH_ALERT_MAX_CLOCK_SKEW_SECONDS="${HEALTH_ALERT_MAX_CLOCK_SKEW_SECONDS:-300}"
HEALTH_ALERT_STATE_PATH="${HEALTH_ALERT_STATE_PATH:-$BACKUP_DIR/health-alert-state.env}"
HEALTH_INCIDENT_RETENTION_DAYS="${HEALTH_INCIDENT_RETENTION_DAYS:-30}"
HEALTH_SNAPSHOT_MAX_LINES="${HEALTH_SNAPSHOT_MAX_LINES:-10000}"
HEALTH_ALERT_LOCK_PATH="${HEALTH_ALERT_LOCK_PATH:-$BACKUP_DIR/health-alert.lock}"
HEALTH_ALERT_LOCK_STALE_SECONDS="${HEALTH_ALERT_LOCK_STALE_SECONDS:-1800}"
HEALTH_AUTO_HEAL_WORKER="${HEALTH_AUTO_HEAL_WORKER:-false}"
HEALTH_WORKER_CONTAINER="${HEALTH_WORKER_CONTAINER:-}"
HEALTH_WORKER_SERVICE="${HEALTH_WORKER_SERVICE:-worker}"
HEALTH_COMPOSE_PROJECT="${HEALTH_COMPOSE_PROJECT:-}"
HEALTH_AUTO_HEAL_LAUNCHD="${HEALTH_AUTO_HEAL_LAUNCHD:-false}"
HEALTH_AUTO_HEAL_LAUNCHD_DRY_RUN="${HEALTH_AUTO_HEAL_LAUNCHD_DRY_RUN:-false}"

if [[ -f "$ROOT_DIR/.env" ]]; then
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
fi

WEBHOOK_URL="${HEALTH_ALERT_WEBHOOK_URL:-${ERROR_TELEMETRY_WEBHOOK_URL:-}}"

contains_issue_key() {
  local key="$1"
  printf '%s' "$HEALTH_JSON" | grep -q "\"key\":\"$key\""
}

sha256_text() {
  local input="$1"
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$input" | shasum -a 256 | awk '{print $1}'
    return 0
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$input" | sha256sum | awk '{print $1}'
    return 0
  fi
  printf '%s' "$input"
}

sanitize_positive_int() {
  local raw="$1"
  local fallback="$2"
  if [[ "$raw" =~ ^[0-9]+$ ]] && (( raw > 0 )); then
    printf '%s' "$raw"
    return 0
  fi
  printf '%s' "$fallback"
}

service_container_ids() {
  local service="$1"
  local running_only="${2:-false}"
  local include_all_flag="-q"
  if [[ "$running_only" != "true" ]]; then
    include_all_flag="-aq"
  fi

  if [[ -n "$HEALTH_COMPOSE_PROJECT" ]]; then
    if [[ "$running_only" == "true" ]]; then
      docker ps "$include_all_flag" \
        --filter "label=com.docker.compose.service=$service" \
        --filter "label=com.docker.compose.project=$HEALTH_COMPOSE_PROJECT" \
        --filter "status=running" 2>/dev/null || true
    else
      docker ps "$include_all_flag" \
        --filter "label=com.docker.compose.service=$service" \
        --filter "label=com.docker.compose.project=$HEALTH_COMPOSE_PROJECT" 2>/dev/null || true
    fi
    return
  fi

  if [[ "$running_only" == "true" ]]; then
    docker ps "$include_all_flag" \
      --filter "label=com.docker.compose.service=$service" \
      --filter "status=running" 2>/dev/null || true
  else
    docker ps "$include_all_flag" \
      --filter "label=com.docker.compose.service=$service" 2>/dev/null || true
  fi
}

first_service_container_id() {
  local service="$1"
  local running_only="${2:-true}"
  service_container_ids "$service" "$running_only" | head -n 1
}

state_file_field() {
  local key="$1"
  local path="$2"
  awk -F= -v target="$key" '$1==target {print $2; exit}' "$path" 2>/dev/null \
    | tr -d '\r[:space:]'
}

trim_health_snapshot_lines() {
  if [[ ! -f "$SNAPSHOT_LOG_PATH" ]]; then
    return 0
  fi
  if [[ ! "$HEALTH_SNAPSHOT_MAX_LINES" =~ ^[0-9]+$ ]] || (( HEALTH_SNAPSHOT_MAX_LINES <= 0 )); then
    return 0
  fi

  current_lines="$(wc -l < "$SNAPSHOT_LOG_PATH" | tr -d '[:space:]')"
  if [[ ! "$current_lines" =~ ^[0-9]+$ ]] || (( current_lines <= HEALTH_SNAPSHOT_MAX_LINES )); then
    return 0
  fi

  tmp_file="$SNAPSHOT_LOG_PATH.trim.$$"
  tail -n "$HEALTH_SNAPSHOT_MAX_LINES" "$SNAPSHOT_LOG_PATH" > "$tmp_file"
  mv "$tmp_file" "$SNAPSHOT_LOG_PATH"
  printf '[%s] snapshot_trimmed path=%s old_lines=%s kept_lines=%s\n' \
    "$timestamp" "$SNAPSHOT_LOG_PATH" "$current_lines" "$HEALTH_SNAPSHOT_MAX_LINES" >>"$LOG_PATH"
}

prune_old_incidents() {
  if [[ ! -d "$INCIDENT_DIR" ]]; then
    return 0
  fi
  if [[ ! "$HEALTH_INCIDENT_RETENTION_DAYS" =~ ^[0-9]+$ ]] || (( HEALTH_INCIDENT_RETENTION_DAYS < 0 )); then
    return 0
  fi

  pruned_count="$(
    find "$INCIDENT_DIR" -type f -name 'incident_*.json' -mtime +"$HEALTH_INCIDENT_RETENTION_DAYS" -print 2>/dev/null \
      | wc -l | tr -d '[:space:]'
  )"
  if [[ "$pruned_count" =~ ^[1-9][0-9]*$ ]]; then
    find "$INCIDENT_DIR" -type f -name 'incident_*.json' -mtime +"$HEALTH_INCIDENT_RETENTION_DAYS" -delete 2>/dev/null || true
    printf '[%s] incidents_pruned dir=%s retention_days=%s count=%s\n' \
      "$timestamp" "$INCIDENT_DIR" "$HEALTH_INCIDENT_RETENTION_DAYS" "$pruned_count" >>"$LOG_PATH"
  fi
}

mkdir -p "$(dirname "$LOG_PATH")"
mkdir -p "$(dirname "$SNAPSHOT_LOG_PATH")"
mkdir -p "$INCIDENT_DIR"
mkdir -p "$(dirname "$HEALTH_ALERT_STATE_PATH")"
mkdir -p "$(dirname "$HEALTH_ALERT_LOCK_PATH")"

timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
timestamp_epoch="$(date +%s)"
timestamp_compact="$(date -u +%Y%m%dT%H%M%SZ)"
lock_acquired=false

HEALTH_ALERT_DEDUPE_MINUTES="$(sanitize_positive_int "$HEALTH_ALERT_DEDUPE_MINUTES" 30)"
HEALTH_ALERT_MAX_CLOCK_SKEW_SECONDS="$(sanitize_positive_int "$HEALTH_ALERT_MAX_CLOCK_SKEW_SECONDS" 300)"
dedupe_window_seconds=$(( HEALTH_ALERT_DEDUPE_MINUTES * 60 ))

if [[ -f "$HEALTH_ALERT_LOCK_PATH" ]]; then
  lock_epoch_raw="$(awk -F= '/^createdAtEpoch=/{print $2; exit}' "$HEALTH_ALERT_LOCK_PATH" | tr -d '[:space:]')"
  if [[ "$lock_epoch_raw" =~ ^[0-9]+$ ]]; then
    lock_age_seconds=$(( timestamp_epoch - lock_epoch_raw ))
    if (( lock_age_seconds >= 0 )) && (( lock_age_seconds > HEALTH_ALERT_LOCK_STALE_SECONDS )); then
      rm -f "$HEALTH_ALERT_LOCK_PATH" 2>/dev/null || true
      printf '[%s] alert_lock=stale_removed path=%s age_seconds=%s threshold_seconds=%s\n' \
        "$timestamp" "$HEALTH_ALERT_LOCK_PATH" "$lock_age_seconds" "$HEALTH_ALERT_LOCK_STALE_SECONDS" >>"$LOG_PATH"
    fi
  fi
fi

if ( set -o noclobber; echo "pid=$$"$'\n'"createdAtEpoch=$timestamp_epoch"$'\n'"createdAtIso=$timestamp" >"$HEALTH_ALERT_LOCK_PATH" ) 2>/dev/null; then
  lock_acquired=true
else
  printf '[%s] alert_lock=busy path=%s; skipping run\n' \
    "$timestamp" "$HEALTH_ALERT_LOCK_PATH" >>"$LOG_PATH"
  exit 0
fi

cleanup_lock() {
  if [[ "$lock_acquired" == "true" ]]; then
    rm -f "$HEALTH_ALERT_LOCK_PATH" 2>/dev/null || true
  fi
}
trap cleanup_lock EXIT

set +e
HEALTH_JSON="$(bash "$CHECK_SCRIPT" --json 2>&1)"
HEALTH_EXIT=$?
set -e

printf '[%s] health_exit=%s payload=%s\n' "$timestamp" "$HEALTH_EXIT" "$HEALTH_JSON" >>"$LOG_PATH"
printf '%s\n' "$HEALTH_JSON" >>"$SNAPSHOT_LOG_PATH"
trim_health_snapshot_lines
prune_old_incidents

auto_heal_flag="$(printf '%s' "$HEALTH_AUTO_HEAL_WORKER" | tr '[:upper:]' '[:lower:]')"
if (( HEALTH_EXIT != 0 )) && [[ "$auto_heal_flag" =~ ^(1|true|yes)$ ]]; then
  if command -v docker >/dev/null 2>&1; then
    worker_container="$HEALTH_WORKER_CONTAINER"
    if [[ -z "$worker_container" ]]; then
      worker_container="$(first_service_container_id "$HEALTH_WORKER_SERVICE" false)"
    fi
    worker_status="$(docker inspect -f '{{.State.Status}}' "$worker_container" 2>/dev/null || true)"
    if [[ -z "$worker_container" || -z "$worker_status" ]]; then
      printf '[%s] auto_heal_worker=skipped reason=container_missing container=%s\n' \
        "$timestamp" "${worker_container:-$HEALTH_WORKER_SERVICE}" >>"$LOG_PATH"
    elif [[ "$worker_status" != "running" ]]; then
      printf '[%s] auto_heal_worker=attempt container=%s prior_status=%s\n' \
        "$timestamp" "$worker_container" "$worker_status" >>"$LOG_PATH"
      if docker start "$worker_container" >/dev/null 2>&1; then
        sleep 3
        set +e
        HEAL_JSON="$(bash "$CHECK_SCRIPT" --json 2>&1)"
        HEAL_EXIT=$?
        set -e
        HEALTH_JSON="$HEAL_JSON"
        HEALTH_EXIT=$HEAL_EXIT
        printf '%s\n' "$HEALTH_JSON" >>"$SNAPSHOT_LOG_PATH"
        printf '[%s] auto_heal_worker=post_check exit=%s payload=%s\n' \
          "$timestamp" "$HEALTH_EXIT" "$HEALTH_JSON" >>"$LOG_PATH"
      else
        printf '[%s] auto_heal_worker=failed_to_start container=%s\n' \
          "$timestamp" "$worker_container" >>"$LOG_PATH"
      fi
    fi
  else
    printf '[%s] auto_heal_worker=skipped reason=docker_missing\n' "$timestamp" >>"$LOG_PATH"
  fi
fi

auto_heal_launchd_flag="$(printf '%s' "$HEALTH_AUTO_HEAL_LAUNCHD" | tr '[:upper:]' '[:lower:]')"
auto_heal_launchd_dry_run_flag="$(printf '%s' "$HEALTH_AUTO_HEAL_LAUNCHD_DRY_RUN" | tr '[:upper:]' '[:lower:]')"
if (( HEALTH_EXIT != 0 )) && [[ "$auto_heal_launchd_flag" =~ ^(1|true|yes)$ ]]; then
  if contains_issue_key "launchd_not_loaded" || contains_issue_key "launchd_exit_nonzero"; then
    if command -v launchctl >/dev/null 2>&1; then
      REPAIR_ARGS=()
      if [[ "$auto_heal_launchd_dry_run_flag" =~ ^(1|true|yes)$ ]]; then
        REPAIR_ARGS+=(--dry-run)
      fi

      printf '[%s] auto_heal_launchd=attempt dry_run=%s\n' \
        "$timestamp" "$auto_heal_launchd_dry_run_flag" >>"$LOG_PATH"
      if bash "$ROOT_DIR/scripts/ops/repair_launchd_jobs.sh" "${REPAIR_ARGS[@]}" >>"$LOG_PATH" 2>&1; then
        sleep 2
        set +e
        HEAL_JSON="$(bash "$CHECK_SCRIPT" --json 2>&1)"
        HEAL_EXIT=$?
        set -e
        HEALTH_JSON="$HEAL_JSON"
        HEALTH_EXIT=$HEAL_EXIT
        printf '%s\n' "$HEALTH_JSON" >>"$SNAPSHOT_LOG_PATH"
        printf '[%s] auto_heal_launchd=post_check exit=%s payload=%s\n' \
          "$timestamp" "$HEALTH_EXIT" "$HEALTH_JSON" >>"$LOG_PATH"
      else
        printf '[%s] auto_heal_launchd=repair_failed\n' "$timestamp" >>"$LOG_PATH"
      fi
    else
      printf '[%s] auto_heal_launchd=skipped reason=launchctl_missing\n' "$timestamp" >>"$LOG_PATH"
    fi
  fi
fi

if (( HEALTH_EXIT == 0 )); then
  rm -f "$HEALTH_ALERT_STATE_PATH" 2>/dev/null || true
  exit 0
fi

severity="WARN"
if (( HEALTH_EXIT >= 2 )); then
  severity="CRITICAL"
fi

issue_keys="$(
  printf '%s' "$HEALTH_JSON" \
    | grep -o '"key":"[^"]*"' \
    | sed 's/"key":"//; s/"$//' \
    | sort -u \
    | tr '\n' ',' \
    | sed 's/,$//' \
    || true
)"
overall_value="$(printf '%s' "$HEALTH_JSON" | sed -n 's/.*"overall":"\([^"]*\)".*/\1/p' | head -n 1)"
[[ -z "$overall_value" ]] && overall_value="UNKNOWN"
[[ -z "$issue_keys" ]] && issue_keys="none"

alert_fingerprint_source="overall=$overall_value;severity=$severity;exit=$HEALTH_EXIT;issues=$issue_keys"
alert_fingerprint="$(sha256_text "$alert_fingerprint_source")"

state_last_fingerprint=""
state_last_epoch=0
if [[ -f "$HEALTH_ALERT_STATE_PATH" ]]; then
  state_last_fingerprint="$(state_file_field "lastFingerprint" "$HEALTH_ALERT_STATE_PATH")"
  state_last_epoch_raw="$(state_file_field "lastIncidentEpoch" "$HEALTH_ALERT_STATE_PATH")"
  state_corrupt_reason=""

  if [[ -z "$state_last_fingerprint" ]]; then
    state_corrupt_reason="missing_fingerprint"
  elif [[ ! "$state_last_epoch_raw" =~ ^[0-9]+$ ]]; then
    state_corrupt_reason="invalid_epoch"
  else
    state_last_epoch="$state_last_epoch_raw"
    if (( state_last_epoch > timestamp_epoch + HEALTH_ALERT_MAX_CLOCK_SKEW_SECONDS )); then
      state_corrupt_reason="future_epoch"
    fi
  fi

  if [[ -n "$state_corrupt_reason" ]]; then
    state_corrupt_path="${HEALTH_ALERT_STATE_PATH}.corrupt.${timestamp_compact}"
    mv "$HEALTH_ALERT_STATE_PATH" "$state_corrupt_path" 2>/dev/null || true
    printf '[%s] alert_state=corrupt reason=%s archived=%s\n' \
      "$timestamp" "$state_corrupt_reason" "$state_corrupt_path" >>"$LOG_PATH"
    state_last_fingerprint=""
    state_last_epoch=0
  fi
fi

if [[ -n "$state_last_fingerprint" && "$state_last_fingerprint" == "$alert_fingerprint" ]]; then
  since_last_seconds=$(( timestamp_epoch - state_last_epoch ))
  if (( since_last_seconds >= 0 )) && (( since_last_seconds < dedupe_window_seconds )); then
    printf '[%s] alert_suppressed=duplicate fingerprint=%s age_seconds=%s window_seconds=%s\n' \
      "$timestamp" "$alert_fingerprint" "$since_last_seconds" "$dedupe_window_seconds" >>"$LOG_PATH"
    exit "$HEALTH_EXIT"
  fi
fi

incident_file="$INCIDENT_DIR/incident_${timestamp_compact}_${severity}_exit${HEALTH_EXIT}.json"
cat >"$incident_file" <<EOF
{
  "timestamp": "$timestamp",
  "severity": "$severity",
  "fingerprint": "$alert_fingerprint",
  "issueKeysCsv": "$issue_keys",
  "healthExit": $HEALTH_EXIT,
  "source": "launchd-hourly",
  "health": $HEALTH_JSON
}
EOF
printf '[%s] incident_snapshot=%s\n' "$timestamp" "$incident_file" >>"$LOG_PATH"
state_tmp_path="${HEALTH_ALERT_STATE_PATH}.tmp.$$"
cat >"$state_tmp_path" <<EOF
lastFingerprint=$alert_fingerprint
lastIncidentEpoch=$timestamp_epoch
lastSeverity=$severity
lastHealthExit=$HEALTH_EXIT
lastIncidentFile=$incident_file
EOF
if ! mv "$state_tmp_path" "$HEALTH_ALERT_STATE_PATH"; then
  rm -f "$state_tmp_path" 2>/dev/null || true
  printf '[%s] alert_state=write_failed path=%s\n' \
    "$timestamp" "$HEALTH_ALERT_STATE_PATH" >>"$LOG_PATH"
fi

if [[ -z "$WEBHOOK_URL" ]]; then
  printf '[%s] alert_skipped=webhook_not_configured incident=%s\n' "$timestamp" "$incident_file" >>"$LOG_PATH"
  exit "$HEALTH_EXIT"
fi

if ! command -v curl >/dev/null 2>&1; then
  printf '[%s] alert_skipped=curl_missing incident=%s\n' "$timestamp" "$incident_file" >>"$LOG_PATH"
  exit "$HEALTH_EXIT"
fi

escaped_payload="$(printf '%s' "$HEALTH_JSON" | sed 's/\\/\\\\/g; s/"/\\"/g')"
alert_body="{\"type\":\"ops.system_health\",\"severity\":\"$severity\",\"timestamp\":\"$timestamp\",\"source\":\"launchd-hourly\",\"healthJson\":\"$escaped_payload\",\"incidentFile\":\"$incident_file\"}"

attempt=1
delivered=false
while (( attempt <= ALERT_RETRY_ATTEMPTS )); do
  set +e
  http_code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$WEBHOOK_URL" \
    -H 'content-type: application/json' \
    -d "$alert_body" \
    --max-time "$ALERT_MAX_TIME_SECONDS" 2>/dev/null)"
  curl_exit=$?
  set -e

  if (( curl_exit == 0 )) && [[ "$http_code" =~ ^2[0-9][0-9]$ ]]; then
    delivered=true
    printf '[%s] alert_delivery=ok attempt=%s http=%s webhook=%s incident=%s\n' \
      "$timestamp" "$attempt" "$http_code" "$WEBHOOK_URL" "$incident_file" >>"$LOG_PATH"
    break
  fi

  printf '[%s] alert_delivery=failed attempt=%s curl_exit=%s http=%s webhook=%s incident=%s\n' \
    "$timestamp" "$attempt" "$curl_exit" "$http_code" "$WEBHOOK_URL" "$incident_file" >>"$LOG_PATH"

  if (( attempt < ALERT_RETRY_ATTEMPTS )); then
    sleep_seconds=$(( ALERT_RETRY_BASE_DELAY_SECONDS * attempt ))
    sleep "$sleep_seconds"
  fi
  attempt=$(( attempt + 1 ))
done

if [[ "$delivered" != "true" ]]; then
  printf '[%s] alert_delivery=exhausted_retries attempts=%s incident=%s\n' \
    "$timestamp" "$ALERT_RETRY_ATTEMPTS" "$incident_file" >>"$LOG_PATH"
fi

exit "$HEALTH_EXIT"
