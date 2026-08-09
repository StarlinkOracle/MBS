#!/usr/bin/env bash
set -euo pipefail

JSON_MODE=false
if [[ "${1:-}" == "--json" ]]; then
  JSON_MODE=true
fi

NOW_EPOCH="$(date +%s)"
NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

POSTGRES_CONTAINER="${BACKUP_POSTGRES_CONTAINER:-}"
POSTGRES_DB="${BACKUP_POSTGRES_DB:-rcs}"
POSTGRES_USER="${BACKUP_POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${BACKUP_POSTGRES_PASSWORD:-postgres}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/mbs-backups}"
HEALTH_REQUIRED_CONTAINERS="${HEALTH_REQUIRED_CONTAINERS:-}"
HEALTH_REQUIRED_SERVICES="${HEALTH_REQUIRED_SERVICES:-postgres,api,web,minio,worker}"
HEALTH_COMPOSE_PROJECT="${HEALTH_COMPOSE_PROJECT:-}"

HEALTH_MAX_PENDING_OUTBOX="${HEALTH_MAX_PENDING_OUTBOX:-200}"
HEALTH_MAX_FAILED_OUTBOX="${HEALTH_MAX_FAILED_OUTBOX:-10}"
HEALTH_MAX_STALE_PENDING_OUTBOX_MINUTES="${HEALTH_MAX_STALE_PENDING_OUTBOX_MINUTES:-15}"
HEALTH_MAX_STALE_PENDING_OUTBOX="${HEALTH_MAX_STALE_PENDING_OUTBOX:-50}"
HEALTH_MAX_STALE_MEDIA_UPLOAD_SESSIONS="${HEALTH_MAX_STALE_MEDIA_UPLOAD_SESSIONS:-50}"
HEALTH_MAX_PENDING_APPROVALS="${HEALTH_MAX_PENDING_APPROVALS:-100}"
HEALTH_MAX_FAILED_EXECUTIONS_1H="${HEALTH_MAX_FAILED_EXECUTIONS_1H:-25}"
HEALTH_MAX_BACKUP_AGE_HOURS="${HEALTH_MAX_BACKUP_AGE_HOURS:-30}"
HEALTH_MAX_RESTORE_DRILL_AGE_HOURS="${HEALTH_MAX_RESTORE_DRILL_AGE_HOURS:-192}"
HEALTH_MAX_RESTORE_DRILL_LOCK_AGE_MINUTES="${HEALTH_MAX_RESTORE_DRILL_LOCK_AGE_MINUTES:-120}"
HEALTH_MAX_REMEDIATE_LOCK_AGE_MINUTES="${HEALTH_MAX_REMEDIATE_LOCK_AGE_MINUTES:-30}"
HEALTH_MAX_LOAD_SMOKE_AGE_HOURS="${HEALTH_MAX_LOAD_SMOKE_AGE_HOURS:-192}"
HEALTH_MIN_LOAD_SMOKE_SUCCESS_PCT="${HEALTH_MIN_LOAD_SMOKE_SUCCESS_PCT:-99}"
HEALTH_MAX_LOAD_SMOKE_P95_SECONDS="${HEALTH_MAX_LOAD_SMOKE_P95_SECONDS:-2.5}"
HEALTH_LOAD_SMOKE_TREND_WINDOW="${HEALTH_LOAD_SMOKE_TREND_WINDOW:-5}"
HEALTH_LOAD_SMOKE_MAX_FAILS_WINDOW="${HEALTH_LOAD_SMOKE_MAX_FAILS_WINDOW:-2}"
HEALTH_MIN_DISK_FREE_GB="${HEALTH_MIN_DISK_FREE_GB:-10}"
HEALTH_MIN_DISK_FREE_PCT="${HEALTH_MIN_DISK_FREE_PCT:-10}"
HEALTH_CHECK_LAUNCHD="${HEALTH_CHECK_LAUNCHD:-auto}"
HEALTH_LAUNCHD_PLIST_DIR="${HEALTH_LAUNCHD_PLIST_DIR:-$HOME/Library/LaunchAgents}"
HEALTH_LAUNCHD_EXPECT_ALL_LABELS="${HEALTH_LAUNCHD_EXPECT_ALL_LABELS:-false}"
HEALTH_RESTORE_DRILL_MARKER_PATH="${HEALTH_RESTORE_DRILL_MARKER_PATH:-$BACKUP_DIR/restore-drill.marker}"
HEALTH_RESTORE_DRILL_LOCK_PATH="${HEALTH_RESTORE_DRILL_LOCK_PATH:-$BACKUP_DIR/restore-drill.lock}"
HEALTH_REMEDIATE_LOCK_PATH="${HEALTH_REMEDIATE_LOCK_PATH:-$BACKUP_DIR/remediate.lock}"
HEALTH_LOAD_SMOKE_MARKER_PATH="${HEALTH_LOAD_SMOKE_MARKER_PATH:-$BACKUP_DIR/load-smoke.marker}"
HEALTH_LOAD_SMOKE_HISTORY_PATH="${HEALTH_LOAD_SMOKE_HISTORY_PATH:-$BACKUP_DIR/load-smoke-history.jsonl}"

USER_UID="$(id -u)"
LAUNCHD_DOMAIN="gui/$USER_UID"
LAUNCHD_LABELS=(
  "com.rcs.backup.nightly"
  "com.rcs.restore.weekly"
  "com.rcs.logs.rotate.weekly"
  "com.rcs.loadsmoke.weekly"
  "com.rcs.health.hourly"
)

declare -a ISSUE_LEVELS=()
declare -a ISSUE_KEYS=()
declare -a ISSUE_MESSAGES=()

add_issue() {
  local level="$1"
  local key="$2"
  local message="$3"
  ISSUE_LEVELS+=("$level")
  ISSUE_KEYS+=("$key")
  ISSUE_MESSAGES+=("$message")
}

run_psql_scalar() {
  local sql="$1"
  docker exec -i \
    -e "PGPASSWORD=$POSTGRES_PASSWORD" \
    "$POSTGRES_CONTAINER" \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "$sql" 2>/dev/null \
    | tr -d '\n'
}

container_status() {
  local name="$1"
  docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || true
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

safe_int() {
  local value="${1:-0}"
  if [[ "$value" =~ ^-?[0-9]+$ ]]; then
    printf '%s' "$value"
  else
    printf '0'
  fi
}

safe_float() {
  local value="${1:-0}"
  if [[ "$value" =~ ^-?[0-9]+([.][0-9]+)?$ ]]; then
    printf '%s' "$value"
  else
    printf '0'
  fi
}

iso_to_epoch() {
  local iso_value="${1:-}"
  local parsed_epoch
  if [[ -z "$iso_value" ]]; then
    return 1
  fi

  if parsed_epoch="$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$iso_value" "+%s" 2>/dev/null)"; then
    printf '%s' "$parsed_epoch"
    return 0
  fi

  if parsed_epoch="$(date -u -d "$iso_value" "+%s" 2>/dev/null)"; then
    printf '%s' "$parsed_epoch"
    return 0
  fi

  return 1
}

epoch_to_iso() {
  local epoch_value="${1:-}"
  local parsed_iso
  if [[ ! "$epoch_value" =~ ^[0-9]+$ ]]; then
    return 1
  fi

  if parsed_iso="$(date -u -r "$epoch_value" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)"; then
    printf '%s' "$parsed_iso"
    return 0
  fi

  if parsed_iso="$(date -u -d "@$epoch_value" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)"; then
    printf '%s' "$parsed_iso"
    return 0
  fi

  return 1
}

if [[ -z "$POSTGRES_CONTAINER" ]]; then
  POSTGRES_CONTAINER="$(first_service_container_id "postgres" true)"
fi
if [[ -z "$POSTGRES_CONTAINER" ]]; then
  POSTGRES_CONTAINER="$(first_service_container_id "postgres" false)"
fi
if [[ -z "$POSTGRES_CONTAINER" ]]; then
  POSTGRES_CONTAINER="russellcomfortsolutions_postgres_1"
fi

sha256_file() {
  local file_path="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file_path" | awk '{print $1}'
    return 0
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file_path" | awk '{print $1}'
    return 0
  fi
  return 1
}

pending_outbox=0
failed_outbox=0
stale_pending_outbox=0
stale_media_upload_sessions=0
pending_approvals=0
failed_executions_1h=0
blocked_executions_24h=0
active_agent_runs=0
kill_switch_mode="UNKNOWN"
backup_age_hours=-1
backup_latest_path=""
backup_integrity_state="UNKNOWN"
backup_integrity_missing_count=0
backup_manifest_status="UNKNOWN"
backup_archive_status="UNKNOWN"
restore_drill_age_hours=-1
restore_drill_completed_at=""
restore_drill_marker_path="$HEALTH_RESTORE_DRILL_MARKER_PATH"
restore_drill_status="UNKNOWN"
restore_drill_lock_path="$HEALTH_RESTORE_DRILL_LOCK_PATH"
restore_drill_lock_status="NONE"
restore_drill_lock_age_minutes=-1
remediate_lock_path="$HEALTH_REMEDIATE_LOCK_PATH"
remediate_lock_status="NONE"
remediate_lock_age_minutes=-1
load_smoke_marker_path="$HEALTH_LOAD_SMOKE_MARKER_PATH"
load_smoke_age_hours=-1
load_smoke_status="UNKNOWN"
load_smoke_success_pct=0
load_smoke_p95_seconds=0
load_smoke_trend_window=0
load_smoke_trend_fail_count=0
db_ok=false
disk_free_gb=-1
disk_free_pct=-1
disk_used_pct=-1
launchd_checks_enabled=false

launchd_mode="$(printf '%s' "$HEALTH_CHECK_LAUNCHD" | tr '[:upper:]' '[:lower:]')"
case "$launchd_mode" in
  1|true|yes)
    launchd_checks_enabled=true
    ;;
  0|false|no)
    launchd_checks_enabled=false
    ;;
  auto|'')
    if [[ "$(uname -s)" == "Darwin" ]]; then
      launchd_checks_enabled=true
    else
      launchd_checks_enabled=false
    fi
    ;;
  *)
    add_issue "WARN" "launchd_check_mode_invalid" "invalid HEALTH_CHECK_LAUNCHD=$HEALTH_CHECK_LAUNCHD (expected auto|true|false)"
    launchd_checks_enabled=false
    ;;
esac

if [[ -n "$HEALTH_REQUIRED_CONTAINERS" ]]; then
  IFS=',' read -r -a required_containers <<< "$HEALTH_REQUIRED_CONTAINERS"
  for container_name in "${required_containers[@]}"; do
    status="$(container_status "$container_name")"
    if [[ -z "$status" ]]; then
      add_issue "CRITICAL" "container_missing" "required container missing: $container_name"
      continue
    fi
    if [[ "$status" != "running" ]]; then
      add_issue "CRITICAL" "container_not_running" "container not running: $container_name (status=$status)"
    fi
  done
else
  IFS=',' read -r -a required_services <<< "$HEALTH_REQUIRED_SERVICES"
  for service_name in "${required_services[@]}"; do
    service_name="$(printf '%s' "$service_name" | tr -d '[:space:]')"
    [[ -z "$service_name" ]] && continue

    running_id="$(first_service_container_id "$service_name" true)"
    if [[ -n "$running_id" ]]; then
      continue
    fi

    existing_id="$(first_service_container_id "$service_name" false)"
    if [[ -n "$existing_id" ]]; then
      status="$(container_status "$existing_id")"
      add_issue "CRITICAL" "container_not_running" "required service not running: $service_name (container=$existing_id status=${status:-unknown})"
    else
      add_issue "CRITICAL" "container_missing" "required service missing: $service_name"
    fi
  done
fi

if docker inspect "$POSTGRES_CONTAINER" >/dev/null 2>&1; then
  if run_psql_scalar "SELECT 1;" >/dev/null 2>&1; then
    db_ok=true

    pending_outbox="$(safe_int "$(run_psql_scalar "SELECT COUNT(*) FROM \"EventOutbox\" WHERE status='PENDING';")")"
    failed_outbox="$(safe_int "$(run_psql_scalar "SELECT COUNT(*) FROM \"EventOutbox\" WHERE status='FAILED';")")"
    stale_pending_outbox="$(safe_int "$(run_psql_scalar "SELECT COUNT(*) FROM \"EventOutbox\" WHERE status='PENDING' AND \"createdAt\" < NOW() - INTERVAL '${HEALTH_MAX_STALE_PENDING_OUTBOX_MINUTES} minutes';")")"
    stale_media_upload_sessions="$(safe_int "$(run_psql_scalar "SELECT COUNT(*) FROM \"MediaUploadSession\" WHERE status IN ('INITIATED','FAILED') AND \"expiresAt\" IS NOT NULL AND \"expiresAt\" < NOW();")")"
    pending_approvals="$(safe_int "$(run_psql_scalar "SELECT COUNT(*) FROM \"ApprovalRequest\" WHERE status='PENDING';")")"
    failed_executions_1h="$(safe_int "$(run_psql_scalar "SELECT COUNT(*) FROM \"ToolExecution\" WHERE status='FAILED' AND \"createdAt\" >= NOW() - INTERVAL '1 hour';")")"
    blocked_executions_24h="$(safe_int "$(run_psql_scalar "SELECT COUNT(*) FROM \"ToolExecution\" WHERE status='BLOCKED' AND \"createdAt\" >= NOW() - INTERVAL '24 hours';")")"
    active_agent_runs="$(safe_int "$(run_psql_scalar "SELECT COUNT(*) FROM \"AgentRun\" WHERE status='RUNNING';")")"
    kill_switch_mode="$(run_psql_scalar "SELECT COALESCE(CAST(mode AS TEXT), 'UNKNOWN') FROM \"OrgSafetyState\" ORDER BY \"updatedAt\" DESC LIMIT 1;")"
    [[ -z "$kill_switch_mode" ]] && kill_switch_mode="UNKNOWN"
  else
    add_issue "CRITICAL" "db_unreachable" "unable to query postgres container: $POSTGRES_CONTAINER"
    postgres_logs_tail="$(docker logs --tail 200 "$POSTGRES_CONTAINER" 2>&1 || true)"
    if printf '%s\n' "$postgres_logs_tail" | grep -qi "No space left on device"; then
      add_issue "CRITICAL" "postgres_disk_full" "postgres reports no space left on device"
    fi
  fi
else
  add_issue "CRITICAL" "db_container_missing" "postgres container not found: $POSTGRES_CONTAINER"
fi

if [[ "$db_ok" == "true" ]]; then
  if (( pending_outbox > HEALTH_MAX_PENDING_OUTBOX )); then
    add_issue "WARN" "outbox_pending_high" "pending outbox is high: $pending_outbox (limit $HEALTH_MAX_PENDING_OUTBOX)"
  fi
  if (( failed_outbox > HEALTH_MAX_FAILED_OUTBOX )); then
    add_issue "WARN" "outbox_failed_high" "failed outbox is high: $failed_outbox (limit $HEALTH_MAX_FAILED_OUTBOX)"
  fi
  if (( stale_pending_outbox > HEALTH_MAX_STALE_PENDING_OUTBOX )); then
    add_issue "WARN" "outbox_stale_pending_high" "stale pending outbox is high: $stale_pending_outbox older than ${HEALTH_MAX_STALE_PENDING_OUTBOX_MINUTES}m (limit $HEALTH_MAX_STALE_PENDING_OUTBOX)"
  fi
  if (( stale_media_upload_sessions > HEALTH_MAX_STALE_MEDIA_UPLOAD_SESSIONS )); then
    add_issue "WARN" "media_upload_sessions_stale_high" "stale media upload sessions are high: $stale_media_upload_sessions expired-but-open sessions (limit $HEALTH_MAX_STALE_MEDIA_UPLOAD_SESSIONS)"
  fi
  if (( pending_approvals > HEALTH_MAX_PENDING_APPROVALS )); then
    add_issue "WARN" "pending_approvals_high" "pending approvals is high: $pending_approvals (limit $HEALTH_MAX_PENDING_APPROVALS)"
  fi
  if (( failed_executions_1h > HEALTH_MAX_FAILED_EXECUTIONS_1H )); then
    add_issue "WARN" "failed_executions_high" "failed executions in 1h is high: $failed_executions_1h (limit $HEALTH_MAX_FAILED_EXECUTIONS_1H)"
  fi
  if [[ "$kill_switch_mode" != "NORMAL" && "$kill_switch_mode" != "UNKNOWN" ]]; then
    add_issue "WARN" "kill_switch_non_normal" "kill switch mode is $kill_switch_mode"
  fi
fi

if [[ -d "$BACKUP_DIR" ]]; then
  backup_latest_path="$(
    while IFS= read -r dir_path; do
      [[ "$(basename "$dir_path")" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || continue
      printf '%s\t%s\n' "$(stat -f %m "$dir_path")" "$dir_path"
    done < <(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -print)
  )"
  if [[ -n "$backup_latest_path" ]]; then
    backup_latest_path="$(printf '%s\n' "$backup_latest_path" | sort -nr | head -n 1 | cut -f2-)"
  fi
  if [[ -n "$backup_latest_path" ]]; then
    backup_mtime_epoch="$(stat -f %m "$backup_latest_path")"
    backup_age_hours="$(( (NOW_EPOCH - backup_mtime_epoch) / 3600 ))"
    if (( backup_age_hours > HEALTH_MAX_BACKUP_AGE_HOURS )); then
      add_issue "CRITICAL" "backup_stale" "latest backup is stale: ${backup_age_hours}h (limit ${HEALTH_MAX_BACKUP_AGE_HOURS}h)"
    fi

    required_backup_files=("postgres.sql.gz" "minio-data.tgz" "manifest.txt")
    missing_backup_files=()
    for required_file in "${required_backup_files[@]}"; do
      if [[ ! -s "$backup_latest_path/$required_file" ]]; then
        missing_backup_files+=("$required_file")
      fi
    done
    if (( ${#missing_backup_files[@]} > 0 )); then
      backup_integrity_state="INCOMPLETE"
      backup_integrity_missing_count="${#missing_backup_files[@]}"
      add_issue "CRITICAL" "backup_incomplete" "latest backup is incomplete at $backup_latest_path (missing: ${missing_backup_files[*]})"
    else
      backup_integrity_state="OK"
      backup_integrity_missing_count=0

      manifest_path="$backup_latest_path/manifest.txt"
      manifest_postgres_file="$(awk -F= '/^postgres_file=/{print $2; exit}' "$manifest_path" | tr -d '[:space:]')"
      manifest_postgres_sha="$(awk -F= '/^postgres_sha256=/{print $2; exit}' "$manifest_path" | tr -d '[:space:]')"
      manifest_minio_file="$(awk -F= '/^minio_file=/{print $2; exit}' "$manifest_path" | tr -d '[:space:]')"
      manifest_minio_sha="$(awk -F= '/^minio_sha256=/{print $2; exit}' "$manifest_path" | tr -d '[:space:]')"

      if [[ -z "$manifest_postgres_file" || -z "$manifest_postgres_sha" || -z "$manifest_minio_file" || -z "$manifest_minio_sha" ]]; then
        backup_manifest_status="INVALID"
        add_issue "CRITICAL" "backup_manifest_invalid" "backup manifest is invalid or missing required keys at $manifest_path"
      elif [[ ! -s "$backup_latest_path/$manifest_postgres_file" || ! -s "$backup_latest_path/$manifest_minio_file" ]]; then
        backup_manifest_status="INVALID"
        add_issue "CRITICAL" "backup_manifest_invalid" "backup manifest file references missing payload files at $manifest_path"
      else
        actual_postgres_sha="$(sha256_file "$backup_latest_path/$manifest_postgres_file" || true)"
        actual_minio_sha="$(sha256_file "$backup_latest_path/$manifest_minio_file" || true)"
        if [[ -z "$actual_postgres_sha" || -z "$actual_minio_sha" ]]; then
          backup_manifest_status="UNVERIFIED"
          backup_archive_status="UNVERIFIED"
          add_issue "WARN" "backup_checksum_unavailable" "unable to compute backup checksums (shasum/sha256sum unavailable)"
        elif [[ "$actual_postgres_sha" != "$manifest_postgres_sha" || "$actual_minio_sha" != "$manifest_minio_sha" ]]; then
          backup_manifest_status="CHECKSUM_MISMATCH"
          backup_archive_status="UNVERIFIED"
          add_issue "CRITICAL" "backup_checksum_mismatch" "backup checksum mismatch detected for latest backup at $backup_latest_path"
        else
          backup_manifest_status="OK"
          if ! command -v gzip >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; then
            backup_archive_status="UNVERIFIED"
            add_issue "WARN" "backup_archive_unavailable" "unable to validate backup archive structure (gzip/tar unavailable)"
          elif ! gzip -t "$backup_latest_path/$manifest_postgres_file" >/dev/null 2>&1; then
            backup_archive_status="CORRUPT"
            add_issue "CRITICAL" "backup_archive_corrupt" "postgres backup archive failed gzip integrity test at $backup_latest_path/$manifest_postgres_file"
          elif ! tar -tzf "$backup_latest_path/$manifest_minio_file" >/dev/null 2>&1; then
            backup_archive_status="CORRUPT"
            add_issue "CRITICAL" "backup_archive_corrupt" "minio backup archive failed tar integrity test at $backup_latest_path/$manifest_minio_file"
          else
            backup_archive_status="OK"
          fi
        fi
      fi
    fi
  else
    add_issue "CRITICAL" "backup_missing" "no backup directories found in $BACKUP_DIR"
  fi
else
  add_issue "CRITICAL" "backup_dir_missing" "backup directory missing: $BACKUP_DIR"
fi

if [[ -f "$restore_drill_marker_path" ]]; then
  restore_drill_status="$(awk -F= '/^status=/{print $2; exit}' "$restore_drill_marker_path" | tr -d '[:space:]')"
  [[ -z "$restore_drill_status" ]] && restore_drill_status="UNKNOWN"
  restore_drill_completed_epoch="$(awk -F= '/^completedAtEpoch=/{print $2; exit}' "$restore_drill_marker_path" | tr -d '[:space:]')"
  restore_drill_completed_at="$(awk -F= '/^completedAtIso=/{print $2; exit}' "$restore_drill_marker_path" | tr -d '[:space:]')"
  if [[ ! "$restore_drill_completed_epoch" =~ ^[0-9]+$ ]]; then
    restore_drill_completed_epoch="$(iso_to_epoch "$restore_drill_completed_at" || true)"
  fi
  if [[ -z "$restore_drill_completed_at" && "$restore_drill_completed_epoch" =~ ^[0-9]+$ ]]; then
    restore_drill_completed_at="$(epoch_to_iso "$restore_drill_completed_epoch" || true)"
  fi
  if [[ "$restore_drill_status" != "success" && "$restore_drill_status" != "SUCCESS" ]]; then
    add_issue "WARN" "restore_drill_failed" "restore drill marker reports non-success status=$restore_drill_status at $restore_drill_marker_path"
  fi
  if [[ "$restore_drill_completed_epoch" =~ ^[0-9]+$ ]]; then
    restore_drill_age_hours="$(( (NOW_EPOCH - restore_drill_completed_epoch) / 3600 ))"
    if (( restore_drill_age_hours < 0 )); then
      restore_drill_age_hours=0
    fi
    if (( restore_drill_age_hours > HEALTH_MAX_RESTORE_DRILL_AGE_HOURS )); then
      add_issue "WARN" "restore_drill_stale" "restore drill is stale: ${restore_drill_age_hours}h (limit ${HEALTH_MAX_RESTORE_DRILL_AGE_HOURS}h)"
    fi
  else
    add_issue "WARN" "restore_drill_marker_invalid" "restore drill marker is invalid: $restore_drill_marker_path"
  fi
else
  add_issue "WARN" "restore_drill_missing" "restore drill marker missing: $restore_drill_marker_path"
fi

if [[ -e "$restore_drill_lock_path" ]]; then
  restore_drill_lock_status="ACTIVE"
  lock_started_epoch="$(tr -dc '0-9' < "$restore_drill_lock_path/startedAtEpoch" 2>/dev/null || true)"
  if [[ "$lock_started_epoch" =~ ^[0-9]+$ ]] && (( lock_started_epoch > 0 )); then
    restore_drill_lock_age_minutes="$(( (NOW_EPOCH - lock_started_epoch) / 60 ))"
  else
    lock_mtime_epoch="$(stat -f %m "$restore_drill_lock_path" 2>/dev/null || true)"
    if [[ "$lock_mtime_epoch" =~ ^[0-9]+$ ]] && (( lock_mtime_epoch > 0 )); then
      restore_drill_lock_age_minutes="$(( (NOW_EPOCH - lock_mtime_epoch) / 60 ))"
    fi
  fi

  if (( restore_drill_lock_age_minutes < 0 )); then
    restore_drill_lock_age_minutes=0
  fi
  if (( restore_drill_lock_age_minutes > HEALTH_MAX_RESTORE_DRILL_LOCK_AGE_MINUTES )); then
    restore_drill_lock_status="STALE"
    add_issue "WARN" "restore_drill_lock_stale" "restore drill lock is stale: ${restore_drill_lock_age_minutes}m (limit ${HEALTH_MAX_RESTORE_DRILL_LOCK_AGE_MINUTES}m) at $restore_drill_lock_path"
  fi
fi

if [[ -f "$remediate_lock_path" ]]; then
  remediate_lock_status="ACTIVE"
  remediate_lock_epoch_raw="$(awk -F= '/^createdAtEpoch=/{print $2; exit}' "$remediate_lock_path" | tr -d '[:space:]')"
  if [[ "$remediate_lock_epoch_raw" =~ ^[0-9]+$ ]] && (( remediate_lock_epoch_raw > 0 )); then
    remediate_lock_age_minutes="$(( (NOW_EPOCH - remediate_lock_epoch_raw) / 60 ))"
  else
    remediate_lock_mtime_epoch="$(stat -f %m "$remediate_lock_path" 2>/dev/null || true)"
    if [[ "$remediate_lock_mtime_epoch" =~ ^[0-9]+$ ]] && (( remediate_lock_mtime_epoch > 0 )); then
      remediate_lock_age_minutes="$(( (NOW_EPOCH - remediate_lock_mtime_epoch) / 60 ))"
    fi
  fi

  if (( remediate_lock_age_minutes < 0 )); then
    remediate_lock_age_minutes=0
  fi
  if (( remediate_lock_age_minutes > HEALTH_MAX_REMEDIATE_LOCK_AGE_MINUTES )); then
    remediate_lock_status="STALE"
    add_issue "WARN" "remediate_lock_stale" "health remediation lock is stale: ${remediate_lock_age_minutes}m (limit ${HEALTH_MAX_REMEDIATE_LOCK_AGE_MINUTES}m) at $remediate_lock_path"
  fi
fi

if [[ -f "$load_smoke_marker_path" ]]; then
  load_smoke_status="$(awk -F= '/^status=/{print $2; exit}' "$load_smoke_marker_path" | tr -d '[:space:]')"
  [[ -z "$load_smoke_status" ]] && load_smoke_status="UNKNOWN"
  load_smoke_completed_epoch="$(awk -F= '/^completedAtEpoch=/{print $2; exit}' "$load_smoke_marker_path" | tr -d '[:space:]')"
  load_smoke_completed_at="$(awk -F= '/^completedAtIso=/{print $2; exit}' "$load_smoke_marker_path" | tr -d '[:space:]')"
  if [[ ! "$load_smoke_completed_epoch" =~ ^[0-9]+$ ]]; then
    load_smoke_completed_epoch="$(iso_to_epoch "$load_smoke_completed_at" || true)"
  fi
  load_smoke_success_pct="$(safe_float "$(awk -F= '/^successPct=/{print $2; exit}' "$load_smoke_marker_path" | tr -d '[:space:]')")"
  load_smoke_p95_seconds="$(safe_float "$(awk -F= '/^p95Seconds=/{print $2; exit}' "$load_smoke_marker_path" | tr -d '[:space:]')")"

  if [[ "$load_smoke_status" != "success" && "$load_smoke_status" != "SUCCESS" ]]; then
    add_issue "WARN" "load_smoke_failed" "load smoke marker reports non-success status=$load_smoke_status at $load_smoke_marker_path"
  fi
  if [[ "$load_smoke_completed_epoch" =~ ^[0-9]+$ ]]; then
    load_smoke_age_hours="$(( (NOW_EPOCH - load_smoke_completed_epoch) / 3600 ))"
    if (( load_smoke_age_hours < 0 )); then
      load_smoke_age_hours=0
    fi
    if (( load_smoke_age_hours > HEALTH_MAX_LOAD_SMOKE_AGE_HOURS )); then
      add_issue "WARN" "load_smoke_stale" "load smoke is stale: ${load_smoke_age_hours}h (limit ${HEALTH_MAX_LOAD_SMOKE_AGE_HOURS}h)"
    fi
  else
    add_issue "WARN" "load_smoke_marker_invalid" "load smoke marker is invalid: $load_smoke_marker_path"
  fi
  if awk -v actual="$load_smoke_success_pct" -v min="$HEALTH_MIN_LOAD_SMOKE_SUCCESS_PCT" 'BEGIN { exit !(actual + 0 < min + 0) }'; then
    add_issue "WARN" "load_smoke_regressed" "load smoke success rate is below threshold: ${load_smoke_success_pct}% (min ${HEALTH_MIN_LOAD_SMOKE_SUCCESS_PCT}%)"
  fi
  if awk -v max="$HEALTH_MAX_LOAD_SMOKE_P95_SECONDS" 'BEGIN { exit !(max + 0 > 0) }' \
    && awk -v actual="$load_smoke_p95_seconds" -v max="$HEALTH_MAX_LOAD_SMOKE_P95_SECONDS" 'BEGIN { exit !(actual + 0 > max + 0) }'; then
    add_issue "WARN" "load_smoke_latency_high" "load smoke p95 latency is high: ${load_smoke_p95_seconds}s (max ${HEALTH_MAX_LOAD_SMOKE_P95_SECONDS}s)"
  fi
else
  add_issue "WARN" "load_smoke_missing" "load smoke marker missing: $load_smoke_marker_path"
fi

if [[ -f "$HEALTH_LOAD_SMOKE_HISTORY_PATH" ]]; then
  if [[ "$HEALTH_LOAD_SMOKE_TREND_WINDOW" =~ ^[0-9]+$ ]] && (( HEALTH_LOAD_SMOKE_TREND_WINDOW > 0 )); then
    load_smoke_trend_window="$HEALTH_LOAD_SMOKE_TREND_WINDOW"
    load_smoke_trend_fail_count="$(
      tail -n "$HEALTH_LOAD_SMOKE_TREND_WINDOW" "$HEALTH_LOAD_SMOKE_HISTORY_PATH" 2>/dev/null \
        | rg -c '"status":"FAIL"' || true
    )"
    load_smoke_trend_fail_count="$(safe_int "$load_smoke_trend_fail_count")"
    if [[ "$HEALTH_LOAD_SMOKE_MAX_FAILS_WINDOW" =~ ^[0-9]+$ ]] \
      && (( load_smoke_trend_fail_count > HEALTH_LOAD_SMOKE_MAX_FAILS_WINDOW )); then
      add_issue "WARN" "load_smoke_trend_failed" "load smoke trend shows repeated failures: ${load_smoke_trend_fail_count}/${load_smoke_trend_window} failing runs (max ${HEALTH_LOAD_SMOKE_MAX_FAILS_WINDOW})"
    fi
  fi
fi

disk_probe_path="$BACKUP_DIR"
if [[ ! -d "$disk_probe_path" ]]; then
  disk_probe_path="$HOME"
fi
disk_df_row="$(df -Pk "$disk_probe_path" 2>/dev/null | tail -n 1 || true)"
if [[ -n "$disk_df_row" ]]; then
  disk_total_kb="$(printf '%s\n' "$disk_df_row" | awk '{print $2}')"
  disk_available_kb="$(printf '%s\n' "$disk_df_row" | awk '{print $4}')"
  disk_capacity_raw="$(printf '%s\n' "$disk_df_row" | awk '{print $5}')"
  if [[ "$disk_total_kb" =~ ^[0-9]+$ ]] && [[ "$disk_total_kb" -gt 0 ]] && [[ "$disk_available_kb" =~ ^[0-9]+$ ]]; then
    disk_free_gb="$(( disk_available_kb / 1024 / 1024 ))"
    disk_free_pct="$(( disk_available_kb * 100 / disk_total_kb ))"
    if (( disk_free_gb < HEALTH_MIN_DISK_FREE_GB )); then
      add_issue "CRITICAL" "disk_free_low_gb" "disk free is low: ${disk_free_gb}GB (minimum ${HEALTH_MIN_DISK_FREE_GB}GB) at $disk_probe_path"
    fi
    if (( disk_free_pct < HEALTH_MIN_DISK_FREE_PCT )); then
      add_issue "CRITICAL" "disk_free_low_pct" "disk free percent is low: ${disk_free_pct}% (minimum ${HEALTH_MIN_DISK_FREE_PCT}%) at $disk_probe_path"
    fi
  fi
  if [[ -n "$disk_capacity_raw" ]]; then
    disk_capacity_trimmed="${disk_capacity_raw%\%}"
    if [[ "$disk_capacity_trimmed" =~ ^[0-9]+$ ]]; then
      disk_used_pct="$disk_capacity_trimmed"
    fi
  fi
fi

if [[ "$launchd_checks_enabled" == "true" ]]; then
  if ! command -v launchctl >/dev/null 2>&1; then
    add_issue "WARN" "launchd_unavailable" "launchctl not available on this host; cannot evaluate launchd jobs"
  else
    launchd_expect_all="$(printf '%s' "$HEALTH_LAUNCHD_EXPECT_ALL_LABELS" | tr '[:upper:]' '[:lower:]')"
    launchd_labels_to_check=()
    if [[ "$launchd_expect_all" == "1" || "$launchd_expect_all" == "true" || "$launchd_expect_all" == "yes" ]]; then
      launchd_labels_to_check=("${LAUNCHD_LABELS[@]}")
    else
      for label in "${LAUNCHD_LABELS[@]}"; do
        if [[ -f "$HEALTH_LAUNCHD_PLIST_DIR/$label.plist" ]]; then
          launchd_labels_to_check+=("$label")
        fi
      done
    fi

    for label in "${launchd_labels_to_check[@]}"; do
      raw="$(launchctl print "$LAUNCHD_DOMAIN/$label" 2>/dev/null || true)"
      if [[ -z "$raw" ]]; then
        add_issue "WARN" "launchd_not_loaded" "launchd job not loaded: $label"
        continue
      fi
      last_exit="$(printf '%s\n' "$raw" | awk -F'= ' '/^[[:space:]]*last exit code =/{print $2; exit}')"
      if [[ -n "$last_exit" && "$last_exit" != "0" && "$last_exit" != "(never exited)" ]]; then
        add_issue "WARN" "launchd_exit_nonzero" "launchd job has non-zero last exit: $label ($last_exit)"
      fi
    done
  fi
fi

overall="OK"
if (( ${#ISSUE_LEVELS[@]} > 0 )); then
  for level in "${ISSUE_LEVELS[@]}"; do
    if [[ "$level" == "CRITICAL" ]]; then
      overall="CRITICAL"
      break
    fi
    if [[ "$level" == "WARN" && "$overall" == "OK" ]]; then
      overall="WARN"
    fi
  done
fi

if [[ "$JSON_MODE" == "true" ]]; then
  printf '{'
  printf '"timestamp":"%s",' "$NOW_ISO"
  printf '"overall":"%s",' "$overall"
  printf '"metrics":{'
  printf '"pendingOutbox":%s,' "$pending_outbox"
  printf '"failedOutbox":%s,' "$failed_outbox"
  printf '"stalePendingOutbox":%s,' "$stale_pending_outbox"
  printf '"staleMediaUploadSessions":%s,' "$stale_media_upload_sessions"
  printf '"pendingApprovals":%s,' "$pending_approvals"
  printf '"failedExecutions1h":%s,' "$failed_executions_1h"
  printf '"blockedExecutions24h":%s,' "$blocked_executions_24h"
  printf '"activeAgentRuns":%s,' "$active_agent_runs"
  printf '"backupAgeHours":%s,' "$backup_age_hours"
  printf '"backupIntegrityState":"%s",' "$backup_integrity_state"
  printf '"backupIntegrityMissingCount":%s,' "$backup_integrity_missing_count"
  printf '"backupManifestStatus":"%s",' "$backup_manifest_status"
  printf '"backupArchiveStatus":"%s",' "$backup_archive_status"
  printf '"restoreDrillAgeHours":%s,' "$restore_drill_age_hours"
  printf '"restoreDrillStatus":"%s",' "$restore_drill_status"
  printf '"restoreDrillLockStatus":"%s",' "$restore_drill_lock_status"
  printf '"restoreDrillLockAgeMinutes":%s,' "$restore_drill_lock_age_minutes"
  printf '"remediateLockStatus":"%s",' "$remediate_lock_status"
  printf '"remediateLockAgeMinutes":%s,' "$remediate_lock_age_minutes"
  printf '"loadSmokeAgeHours":%s,' "$load_smoke_age_hours"
  printf '"loadSmokeStatus":"%s",' "$load_smoke_status"
  printf '"loadSmokeSuccessPct":%s,' "$load_smoke_success_pct"
  printf '"loadSmokeP95Seconds":%s,' "$load_smoke_p95_seconds"
  printf '"loadSmokeTrendWindow":%s,' "$load_smoke_trend_window"
  printf '"loadSmokeTrendFailCount":%s,' "$load_smoke_trend_fail_count"
  printf '"diskFreeGb":%s,' "$disk_free_gb"
  printf '"diskFreePct":%s,' "$disk_free_pct"
  printf '"diskUsedPct":%s,' "$disk_used_pct"
  printf '"launchdChecksEnabled":%s,' "$launchd_checks_enabled"
  printf '"dbReachable":%s,' "$db_ok"
  printf '"killSwitchMode":"%s"' "$kill_switch_mode"
  printf '},'
  printf '"backupLatestPath":"%s",' "$backup_latest_path"
  printf '"restoreDrillMarkerPath":"%s",' "$restore_drill_marker_path"
  printf '"restoreDrillLockPath":"%s",' "$restore_drill_lock_path"
  printf '"remediateLockPath":"%s",' "$remediate_lock_path"
  printf '"loadSmokeMarkerPath":"%s",' "$load_smoke_marker_path"
  printf '"restoreDrillCompletedAt":"%s",' "$restore_drill_completed_at"
  printf '"issues":['
  if (( ${#ISSUE_LEVELS[@]} > 0 )); then
    for i in "${!ISSUE_LEVELS[@]}"; do
      if (( i > 0 )); then
        printf ','
      fi
      printf '{"level":"%s","key":"%s","message":"%s"}' \
        "${ISSUE_LEVELS[$i]}" \
        "${ISSUE_KEYS[$i]}" \
        "${ISSUE_MESSAGES[$i]}"
    done
  fi
  printf ']'
  printf '}\n'
else
  echo "system health snapshot: $NOW_ISO"
  echo "overall: $overall"
  echo "metrics:"
  echo "  pending_outbox=$pending_outbox"
  echo "  failed_outbox=$failed_outbox"
  echo "  stale_pending_outbox=${stale_pending_outbox} (>${HEALTH_MAX_STALE_PENDING_OUTBOX_MINUTES}m)"
  echo "  stale_media_upload_sessions=${stale_media_upload_sessions} (limit ${HEALTH_MAX_STALE_MEDIA_UPLOAD_SESSIONS})"
  echo "  pending_approvals=$pending_approvals"
  echo "  failed_executions_1h=$failed_executions_1h"
  echo "  blocked_executions_24h=$blocked_executions_24h"
  echo "  active_agent_runs=$active_agent_runs"
  echo "  kill_switch_mode=$kill_switch_mode"
  echo "  backup_latest_path=${backup_latest_path:-none}"
  echo "  backup_age_hours=$backup_age_hours"
  echo "  backup_integrity_state=$backup_integrity_state"
  echo "  backup_integrity_missing_count=$backup_integrity_missing_count"
  echo "  backup_manifest_status=$backup_manifest_status"
  echo "  backup_archive_status=$backup_archive_status"
  echo "  restore_drill_marker_path=$restore_drill_marker_path"
  echo "  restore_drill_status=$restore_drill_status"
  echo "  restore_drill_completed_at=${restore_drill_completed_at:-unknown}"
  echo "  restore_drill_age_hours=$restore_drill_age_hours (max ${HEALTH_MAX_RESTORE_DRILL_AGE_HOURS})"
  echo "  restore_drill_lock_path=$restore_drill_lock_path"
  echo "  restore_drill_lock_status=$restore_drill_lock_status"
  echo "  restore_drill_lock_age_minutes=$restore_drill_lock_age_minutes (max ${HEALTH_MAX_RESTORE_DRILL_LOCK_AGE_MINUTES})"
  echo "  remediate_lock_path=$remediate_lock_path"
  echo "  remediate_lock_status=$remediate_lock_status"
  echo "  remediate_lock_age_minutes=$remediate_lock_age_minutes (max ${HEALTH_MAX_REMEDIATE_LOCK_AGE_MINUTES})"
  echo "  load_smoke_marker_path=$load_smoke_marker_path"
  echo "  load_smoke_status=$load_smoke_status"
  echo "  load_smoke_age_hours=$load_smoke_age_hours (max ${HEALTH_MAX_LOAD_SMOKE_AGE_HOURS})"
  echo "  load_smoke_success_pct=${load_smoke_success_pct}% (min ${HEALTH_MIN_LOAD_SMOKE_SUCCESS_PCT}%)"
  echo "  load_smoke_p95_seconds=${load_smoke_p95_seconds}s (max ${HEALTH_MAX_LOAD_SMOKE_P95_SECONDS}s)"
  echo "  load_smoke_trend_fail_count=$load_smoke_trend_fail_count (window ${load_smoke_trend_window}, max fails ${HEALTH_LOAD_SMOKE_MAX_FAILS_WINDOW})"
  echo "  disk_free_gb=$disk_free_gb (min ${HEALTH_MIN_DISK_FREE_GB})"
  echo "  disk_free_pct=${disk_free_pct}% (min ${HEALTH_MIN_DISK_FREE_PCT}%)"
  echo "  disk_used_pct=${disk_used_pct}%"
  echo "  launchd_checks_enabled=$launchd_checks_enabled (HEALTH_CHECK_LAUNCHD=${HEALTH_CHECK_LAUNCHD})"
  echo "issues:"
  if (( ${#ISSUE_LEVELS[@]} == 0 )); then
    echo "  none"
  else
    for i in "${!ISSUE_LEVELS[@]}"; do
      echo "  [${ISSUE_LEVELS[$i]}] ${ISSUE_KEYS[$i]}: ${ISSUE_MESSAGES[$i]}"
    done
  fi
fi

if [[ "$overall" == "CRITICAL" ]]; then
  exit 2
fi
if [[ "$overall" == "WARN" ]]; then
  exit 1
fi
exit 0
