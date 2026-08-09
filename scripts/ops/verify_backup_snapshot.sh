#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-$HOME/mbs-backups}"
SNAPSHOT_PATH=""
JSON_MODE=false
USE_LATEST=true

usage() {
  cat <<USAGE
Usage:
  bash scripts/ops/verify_backup_snapshot.sh [--latest] [--path <snapshot-path>] [--json]

Options:
  --latest               Verify the latest timestamped backup folder in BACKUP_DIR (default).
  --path <snapshot-path> Verify a specific backup snapshot folder.
  --json                 Emit JSON output.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --latest)
      USE_LATEST=true
      shift
      ;;
    --path)
      SNAPSHOT_PATH="${2:-}"
      USE_LATEST=false
      shift 2
      ;;
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

resolve_latest_snapshot() {
  local root_dir="$1"
  local latest=""
  local latest_mtime=0
  local dir_path
  while IFS= read -r dir_path; do
    [[ "$(basename "$dir_path")" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || continue
    local mtime
    mtime="$(stat -f %m "$dir_path" 2>/dev/null || true)"
    if [[ "$mtime" =~ ^[0-9]+$ ]] && (( mtime > latest_mtime )); then
      latest_mtime="$mtime"
      latest="$dir_path"
    fi
  done < <(find "$root_dir" -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null || true)
  printf '%s' "$latest"
}

if [[ "$USE_LATEST" == "true" ]]; then
  SNAPSHOT_PATH="$(resolve_latest_snapshot "$BACKUP_DIR")"
fi

if [[ -z "$SNAPSHOT_PATH" || ! -d "$SNAPSHOT_PATH" ]]; then
  if [[ "$JSON_MODE" == "true" ]]; then
    printf '{"status":"INVALID","snapshotPath":"%s","issues":["snapshot_missing"]}\n' "${SNAPSHOT_PATH:-}"
  else
    echo "[verify] invalid snapshot path: ${SNAPSHOT_PATH:-<empty>}"
  fi
  exit 2
fi

status="OK"
declare -a issues=()

postgres_file="$SNAPSHOT_PATH/postgres.sql.gz"
minio_file="$SNAPSHOT_PATH/minio-data.tgz"
manifest_file="$SNAPSHOT_PATH/manifest.txt"

if [[ ! -s "$postgres_file" ]]; then
  issues+=("postgres_missing")
fi
if [[ ! -s "$minio_file" ]]; then
  issues+=("minio_missing")
fi
if [[ ! -s "$manifest_file" ]]; then
  issues+=("manifest_missing")
fi

manifest_postgres_file=""
manifest_postgres_sha=""
manifest_minio_file=""
manifest_minio_sha=""

if (( ${#issues[@]} == 0 )); then
  manifest_postgres_file="$(awk -F= '/^postgres_file=/{print $2; exit}' "$manifest_file" | tr -d '[:space:]')"
  manifest_postgres_sha="$(awk -F= '/^postgres_sha256=/{print $2; exit}' "$manifest_file" | tr -d '[:space:]')"
  manifest_minio_file="$(awk -F= '/^minio_file=/{print $2; exit}' "$manifest_file" | tr -d '[:space:]')"
  manifest_minio_sha="$(awk -F= '/^minio_sha256=/{print $2; exit}' "$manifest_file" | tr -d '[:space:]')"

  if [[ -z "$manifest_postgres_file" || -z "$manifest_postgres_sha" || -z "$manifest_minio_file" || -z "$manifest_minio_sha" ]]; then
    issues+=("manifest_invalid")
  fi
fi

actual_postgres_sha=""
actual_minio_sha=""
if (( ${#issues[@]} == 0 )); then
  if [[ ! -s "$SNAPSHOT_PATH/$manifest_postgres_file" || ! -s "$SNAPSHOT_PATH/$manifest_minio_file" ]]; then
    issues+=("manifest_payload_missing")
  else
    actual_postgres_sha="$(sha256_file "$SNAPSHOT_PATH/$manifest_postgres_file" || true)"
    actual_minio_sha="$(sha256_file "$SNAPSHOT_PATH/$manifest_minio_file" || true)"
    if [[ -z "$actual_postgres_sha" || -z "$actual_minio_sha" ]]; then
      issues+=("checksum_unavailable")
    elif [[ "$actual_postgres_sha" != "$manifest_postgres_sha" || "$actual_minio_sha" != "$manifest_minio_sha" ]]; then
      issues+=("checksum_mismatch")
    fi
  fi
fi

if (( ${#issues[@]} == 0 )); then
  if ! command -v gzip >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; then
    issues+=("archive_validation_unavailable")
  elif ! gzip -t "$SNAPSHOT_PATH/$manifest_postgres_file" >/dev/null 2>&1; then
    issues+=("postgres_archive_corrupt")
  elif ! tar -tzf "$SNAPSHOT_PATH/$manifest_minio_file" >/dev/null 2>&1; then
    issues+=("minio_archive_corrupt")
  fi
fi

if (( ${#issues[@]} > 0 )); then
  status="INVALID"
  if printf '%s\n' "${issues[@]}" | grep -Eq 'checksum_unavailable|archive_validation_unavailable'; then
    status="UNVERIFIED"
  fi
fi

if [[ "$JSON_MODE" == "true" ]]; then
  printf '{"status":"%s","snapshotPath":"%s","issues":[' "$status" "$SNAPSHOT_PATH"
  for i in "${!issues[@]}"; do
    if (( i > 0 )); then
      printf ','
    fi
    printf '"%s"' "${issues[$i]}"
  done
  printf '],"files":{"postgres":"%s","minio":"%s","manifest":"%s"}}\n' \
    "$postgres_file" \
    "$minio_file" \
    "$manifest_file"
else
  echo "[verify] snapshot=$SNAPSHOT_PATH"
  echo "[verify] status=$status"
  if (( ${#issues[@]} > 0 )); then
    for issue in "${issues[@]}"; do
      echo "[verify] issue=$issue"
    done
  fi
fi

case "$status" in
  OK)
    exit 0
    ;;
  UNVERIFIED)
    exit 1
    ;;
  *)
    exit 2
    ;;
esac
