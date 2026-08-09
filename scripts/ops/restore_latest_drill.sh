#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  source .env
fi

BACKUP_DIR="${BACKUP_DIR:-$HOME/mbs-backups}"

if [[ ! -d "$BACKUP_DIR" ]]; then
  echo "[restore-latest] backup directory not found: $BACKUP_DIR"
  exit 1
fi

LATEST_BACKUP="$(
  while IFS= read -r dir_path; do
    [[ "$(basename "$dir_path")" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || continue
    printf '%s\t%s\n' "$(stat -f %m "$dir_path")" "$dir_path"
  done < <(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -print)
  )"

if [[ -n "$LATEST_BACKUP" ]]; then
  LATEST_BACKUP="$(printf '%s\n' "$LATEST_BACKUP" | sort -nr | head -n 1 | cut -f2-)"
fi
if [[ -z "$LATEST_BACKUP" ]]; then
  echo "[restore-latest] no backup folders found in $BACKUP_DIR"
  exit 1
fi

echo "[restore-latest] running restore drill for: $LATEST_BACKUP"
bash "$ROOT_DIR/scripts/ops/restore_drill.sh" "$LATEST_BACKUP"
