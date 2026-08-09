#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

LOG_DIR="${OPS_LOG_DIR:-$ROOT_DIR/backups}"
MAX_LOG_BYTES="${OPS_LOG_MAX_BYTES:-10485760}"
RETENTION_FILES="${OPS_LOG_RETENTION_FILES:-14}"

if [[ ! -d "$LOG_DIR" ]]; then
  echo "[log-rotate] log directory missing: $LOG_DIR"
  exit 0
fi

rotate_file() {
  local file_path="$1"
  local base_name="$2"
  local size=0

  if [[ ! -f "$file_path" ]]; then
    return 0
  fi

  size="$(wc -c < "$file_path" | tr -d ' ')"
  if [[ "$size" -lt "$MAX_LOG_BYTES" ]]; then
    return 0
  fi

  local stamp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  local rotated="$LOG_DIR/${base_name}.${stamp}"

  mv "$file_path" "$rotated"
  touch "$file_path"

  if command -v gzip >/dev/null 2>&1; then
    gzip -f "$rotated"
  fi

  local pattern="$LOG_DIR/${base_name}.*"
  # shellcheck disable=SC2012
  local old_files
  old_files="$(ls -1t $pattern 2>/dev/null | tail -n +$((RETENTION_FILES + 1)) || true)"
  if [[ -n "$old_files" ]]; then
    while IFS= read -r old_file; do
      [[ -z "$old_file" ]] && continue
      rm -f "$old_file"
    done <<< "$old_files"
  fi
}

rotate_file "$LOG_DIR/backup.log" "backup.log"
rotate_file "$LOG_DIR/restore-drill.log" "restore-drill.log"

echo "[log-rotate] completed in $LOG_DIR"
