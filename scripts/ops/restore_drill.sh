#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <backup-folder>"
  echo "example: $0 backups/20260223T030000Z"
  exit 1
fi

BACKUP_PATH="$1"
if [[ ! -d "$BACKUP_PATH" ]]; then
  echo "backup folder not found: $BACKUP_PATH"
  exit 1
fi
BACKUP_ROOT="$(cd "$BACKUP_PATH/.." && pwd)"
RESTORE_DRILL_MARKER_PATH="${HEALTH_RESTORE_DRILL_MARKER_PATH:-$BACKUP_ROOT/restore-drill.marker}"
RESTORE_DRILL_LOCK_PATH="${HEALTH_RESTORE_DRILL_LOCK_PATH:-${RESTORE_DRILL_LOCK_PATH:-$BACKUP_ROOT/restore-drill.lock}}"
RESTORE_DRILL_LOCK_MAX_AGE_SECONDS="${RESTORE_DRILL_LOCK_MAX_AGE_SECONDS:-7200}"
CURRENT_STEP="init"
LOCK_OWNED=false
DRILL_DB=""
DRILL_DB_CREATED=false

if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  source .env
fi

write_restore_marker() {
  local status="$1"
  local error_code="${2:-}"
  local error_step="${3:-}"
  local completed_at_epoch
  local completed_at_iso
  local marker_tmp
  completed_at_epoch="$(date +%s)"
  completed_at_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  marker_tmp="$(mktemp "${RESTORE_DRILL_MARKER_PATH}.tmp.XXXXXX")"

  {
    echo "status=$status"
    echo "completedAtEpoch=$completed_at_epoch"
    echo "completedAtIso=$completed_at_iso"
    echo "backupPath=$BACKUP_PATH"
    if [[ -n "$error_code" ]]; then
      echo "errorCode=$error_code"
    fi
    if [[ -n "$error_step" ]]; then
      echo "errorStep=$error_step"
    fi
  } >"$marker_tmp"
  mv "$marker_tmp" "$RESTORE_DRILL_MARKER_PATH"
}

acquire_restore_lock() {
  local max_age_seconds now_epoch lock_epoch lock_age pid
  if [[ "$RESTORE_DRILL_LOCK_MAX_AGE_SECONDS" =~ ^[0-9]+$ ]] && (( RESTORE_DRILL_LOCK_MAX_AGE_SECONDS > 0 )); then
    max_age_seconds="$RESTORE_DRILL_LOCK_MAX_AGE_SECONDS"
  else
    max_age_seconds=7200
  fi

  if mkdir "$RESTORE_DRILL_LOCK_PATH" >/dev/null 2>&1; then
    LOCK_OWNED=true
    printf '%s\n' "$$" > "$RESTORE_DRILL_LOCK_PATH/pid"
    date +%s > "$RESTORE_DRILL_LOCK_PATH/startedAtEpoch"
    date -u +%Y-%m-%dT%H:%M:%SZ > "$RESTORE_DRILL_LOCK_PATH/startedAtIso"
    return 0
  fi

  now_epoch="$(date +%s)"
  lock_epoch="$(tr -dc '0-9' < "$RESTORE_DRILL_LOCK_PATH/startedAtEpoch" 2>/dev/null || true)"
  if [[ "$lock_epoch" =~ ^[0-9]+$ ]] && (( lock_epoch > 0 )); then
    lock_age=$((now_epoch - lock_epoch))
    if (( lock_age < 0 )); then
      lock_age=0
    fi
    if (( lock_age > max_age_seconds )); then
      echo "[restore-drill] stale lock detected (age=${lock_age}s > ${max_age_seconds}s), removing: $RESTORE_DRILL_LOCK_PATH"
      rm -rf "$RESTORE_DRILL_LOCK_PATH"
      if mkdir "$RESTORE_DRILL_LOCK_PATH" >/dev/null 2>&1; then
        LOCK_OWNED=true
        printf '%s\n' "$$" > "$RESTORE_DRILL_LOCK_PATH/pid"
        date +%s > "$RESTORE_DRILL_LOCK_PATH/startedAtEpoch"
        date -u +%Y-%m-%dT%H:%M:%SZ > "$RESTORE_DRILL_LOCK_PATH/startedAtIso"
        return 0
      fi
    fi
  fi

  pid="$(cat "$RESTORE_DRILL_LOCK_PATH/pid" 2>/dev/null || true)"
  echo "[restore-drill] another restore drill appears to be running. lock=$RESTORE_DRILL_LOCK_PATH pid=${pid:-unknown}"
  return 75
}

release_restore_lock() {
  if [[ "$LOCK_OWNED" == "true" ]]; then
    rm -rf "$RESTORE_DRILL_LOCK_PATH" || true
    LOCK_OWNED=false
  fi
}

cleanup_drill_db() {
  if [[ "$DRILL_DB_CREATED" != "true" || -z "$DRILL_DB" ]]; then
    return 0
  fi
  set +e
  run_psql_cmd "postgres" "DROP DATABASE IF EXISTS \"$DRILL_DB\";" >/dev/null 2>&1
  local cleanup_exit=$?
  set -e
  if (( cleanup_exit == 0 )); then
    echo "[restore-drill] cleaned up temporary database: $DRILL_DB"
  else
    echo "[restore-drill] failed to clean up temporary database: $DRILL_DB"
  fi
  DRILL_DB_CREATED=false
}

on_restore_error() {
  local exit_code="$1"
  cleanup_drill_db
  write_restore_marker "failed" "$exit_code" "$CURRENT_STEP"
  echo "[restore-drill] failed at step=$CURRENT_STEP exit_code=$exit_code"
  echo "[restore-drill] marker updated: $RESTORE_DRILL_MARKER_PATH"
  exit "$exit_code"
}

trap 'on_restore_error $?' ERR
trap 'on_restore_error 130' INT TERM
trap 'release_restore_lock' EXIT

POSTGRES_SERVICE="${BACKUP_POSTGRES_SERVICE:-postgres}"
POSTGRES_CONTAINER="${BACKUP_POSTGRES_CONTAINER:-}"
POSTGRES_USER="${BACKUP_POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${BACKUP_POSTGRES_PASSWORD:-postgres}"
PG_FILE="$BACKUP_PATH/postgres.sql.gz"
MINIO_FILE="$BACKUP_PATH/minio-data.tgz"

if [[ ! -f "$PG_FILE" ]]; then
  echo "missing postgres dump: $PG_FILE"
  exit 1
fi

if [[ ! -f "$MINIO_FILE" ]]; then
  echo "missing minio archive: $MINIO_FILE"
  exit 1
fi

CURRENT_STEP="acquire_lock"
acquire_restore_lock

CURRENT_STEP="verify_snapshot"
VERIFY_SCRIPT="$ROOT_DIR/scripts/ops/verify_backup_snapshot.sh"
if [[ -x "$VERIFY_SCRIPT" ]]; then
  set +e
  bash "$VERIFY_SCRIPT" --path "$BACKUP_PATH"
  VERIFY_EXIT=$?
  set -e
  if (( VERIFY_EXIT >= 2 )); then
    echo "[restore-drill] backup snapshot verification failed with status=$VERIFY_EXIT"
    exit "$VERIFY_EXIT"
  fi
  if (( VERIFY_EXIT == 1 )); then
    echo "[restore-drill] backup snapshot verification is partial (unverified checks); continuing"
  fi
fi

CURRENT_STEP="validate_archive"
echo "[restore-drill] validating archive integrity"
gzip -t "$PG_FILE"
tar -tzf "$MINIO_FILE" >/dev/null

run_psql_cmd() {
  local db_name="$1"
  local sql="$2"
  if [[ -n "$POSTGRES_CONTAINER" ]]; then
    docker exec -i \
      -e "PGPASSWORD=$POSTGRES_PASSWORD" \
      "$POSTGRES_CONTAINER" \
      psql -U "$POSTGRES_USER" -d "$db_name" -c "$sql"
  else
    docker compose exec -T "$POSTGRES_SERVICE" \
      psql -U "$POSTGRES_USER" -d "$db_name" -c "$sql"
  fi
}

restore_into_db() {
  local db_name="$1"
  if [[ -n "$POSTGRES_CONTAINER" ]]; then
    gunzip -c "$PG_FILE" | docker exec -i \
      -e "PGPASSWORD=$POSTGRES_PASSWORD" \
      "$POSTGRES_CONTAINER" \
      psql -U "$POSTGRES_USER" -d "$db_name" >/dev/null
  else
    gunzip -c "$PG_FILE" | docker compose exec -T "$POSTGRES_SERVICE" \
      psql -U "$POSTGRES_USER" -d "$db_name" >/dev/null
  fi
}

DRILL_DB="rcs_restore_drill_$(date -u +%Y%m%d_%H%M%S)"
CURRENT_STEP="create_drill_db"
echo "[restore-drill] creating temporary database: $DRILL_DB"
run_psql_cmd "postgres" "DROP DATABASE IF EXISTS \"$DRILL_DB\";"
run_psql_cmd "postgres" "CREATE DATABASE \"$DRILL_DB\";"
DRILL_DB_CREATED=true

CURRENT_STEP="restore_postgres_dump"
echo "[restore-drill] restoring postgres dump into $DRILL_DB"
restore_into_db "$DRILL_DB"

CURRENT_STEP="validate_restored_db"
echo "[restore-drill] running validation query"
run_psql_cmd "$DRILL_DB" "SELECT COUNT(*) AS table_count FROM information_schema.tables WHERE table_schema = 'public';"

CURRENT_STEP="drop_drill_db"
echo "[restore-drill] dropping temporary database: $DRILL_DB"
run_psql_cmd "postgres" "DROP DATABASE IF EXISTS \"$DRILL_DB\";"
DRILL_DB_CREATED=false

trap - ERR
trap - INT TERM
CURRENT_STEP="mark_success"
write_restore_marker "success"

echo "[restore-drill] success: backup is restorable"
echo "[restore-drill] marker updated: $RESTORE_DRILL_MARKER_PATH"
