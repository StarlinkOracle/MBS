#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  source .env
fi

BACKUP_DIR="${BACKUP_DIR:-$HOME/mbs-backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
POSTGRES_SERVICE="${BACKUP_POSTGRES_SERVICE:-postgres}"
POSTGRES_CONTAINER="${BACKUP_POSTGRES_CONTAINER:-}"
POSTGRES_DB="${BACKUP_POSTGRES_DB:-rcs}"
POSTGRES_USER="${BACKUP_POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${BACKUP_POSTGRES_PASSWORD:-postgres}"
MINIO_SERVICE="${BACKUP_MINIO_SERVICE:-minio}"
MINIO_CONTAINER="${BACKUP_MINIO_CONTAINER:-}"
MINIO_DATA_PATH="${BACKUP_MINIO_DATA_PATH:-/data}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET_DIR="$BACKUP_DIR/$STAMP"
mkdir -p "$TARGET_DIR"

PG_FILE="$TARGET_DIR/postgres.sql.gz"
MINIO_FILE="$TARGET_DIR/minio-data.tgz"
MANIFEST_FILE="$TARGET_DIR/manifest.txt"

echo "[backup] writing postgres dump to $PG_FILE"
if [[ -n "$POSTGRES_CONTAINER" ]]; then
  docker exec -i \
    -e "PGPASSWORD=$POSTGRES_PASSWORD" \
    "$POSTGRES_CONTAINER" \
    pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    | gzip >"$PG_FILE"
else
  docker compose exec -T "$POSTGRES_SERVICE" \
    pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    | gzip >"$PG_FILE"
fi

echo "[backup] writing minio archive to $MINIO_FILE"
MINIO_CONTAINER_ID="$MINIO_CONTAINER"
if [[ -z "$MINIO_CONTAINER_ID" ]]; then
  MINIO_CONTAINER_ID="$(docker compose ps -q "$MINIO_SERVICE" | head -n 1)"
  if [[ -z "$MINIO_CONTAINER_ID" ]]; then
    echo "[backup] unable to resolve container id for service: $MINIO_SERVICE"
    exit 1
  fi
fi

MINIO_SNAPSHOT_DIR="$TARGET_DIR/minio-data"
mkdir -p "$MINIO_SNAPSHOT_DIR"
docker cp "$MINIO_CONTAINER_ID:$MINIO_DATA_PATH/." "$MINIO_SNAPSHOT_DIR"
tar -C "$TARGET_DIR" -czf "$MINIO_FILE" minio-data
rm -rf "$MINIO_SNAPSHOT_DIR"

PG_SHA="$(shasum -a 256 "$PG_FILE" | awk '{print $1}')"
MINIO_SHA="$(shasum -a 256 "$MINIO_FILE" | awk '{print $1}')"

cat >"$MANIFEST_FILE" <<EOF
timestamp=$STAMP
postgres_service=$POSTGRES_SERVICE
postgres_db=$POSTGRES_DB
postgres_user=$POSTGRES_USER
postgres_file=$(basename "$PG_FILE")
postgres_sha256=$PG_SHA
minio_service=$MINIO_SERVICE
minio_data_path=$MINIO_DATA_PATH
minio_file=$(basename "$MINIO_FILE")
minio_sha256=$MINIO_SHA
EOF

echo "[backup] manifest written to $MANIFEST_FILE"

VERIFY_SCRIPT="$ROOT_DIR/scripts/ops/verify_backup_snapshot.sh"
if [[ -x "$VERIFY_SCRIPT" ]]; then
  echo "[backup] verifying snapshot integrity via verify_backup_snapshot.sh"
  set +e
  bash "$VERIFY_SCRIPT" --path "$TARGET_DIR"
  VERIFY_EXIT=$?
  set -e
  if (( VERIFY_EXIT >= 2 )); then
    echo "[backup] verification failed with status=$VERIFY_EXIT for $TARGET_DIR"
    exit "$VERIFY_EXIT"
  fi
  if (( VERIFY_EXIT == 1 )); then
    echo "[backup] verification completed with warnings (unverified checks) for $TARGET_DIR"
  fi
fi

if [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] && [[ "$RETENTION_DAYS" -gt 0 ]]; then
  echo "[backup] pruning backup folders older than $RETENTION_DAYS days in $BACKUP_DIR"
  find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +"$RETENTION_DAYS" -print -exec rm -rf {} +
fi

echo "[backup] done: $TARGET_DIR"
