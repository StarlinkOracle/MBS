#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$HOME/mbs-backups}"

DO_STATUS=true
DO_PRUNE_SAFE=false
DO_PRUNE_VOLUMES=false
DO_PRUNE_AGGRESSIVE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --status)
      DO_STATUS=true
      ;;
    --prune-safe)
      DO_PRUNE_SAFE=true
      ;;
    --prune-volumes)
      DO_PRUNE_VOLUMES=true
      ;;
    --prune-aggressive)
      DO_PRUNE_AGGRESSIVE=true
      ;;
    *)
      echo "unknown option: $1"
      echo "usage: $0 [--status] [--prune-safe] [--prune-aggressive] [--prune-volumes]"
      exit 1
      ;;
  esac
  shift
done

print_header() {
  echo
  echo "==== $1 ===="
}

show_status() {
  print_header "Docker disk usage"
  docker system df || true

  print_header "Local backups usage"
  if [[ -d "$BACKUP_DIR" ]]; then
    du -sh "$BACKUP_DIR"/* 2>/dev/null | sort -hr | head -n 20 || echo "(no backup folders yet)"
  else
    echo "backup directory not found: $BACKUP_DIR"
  fi

  print_header "Filesystem free space"
  df -h "$ROOT_DIR" || true
}

if [[ "$DO_STATUS" == true ]]; then
  show_status
fi

if [[ "$DO_PRUNE_SAFE" == true ]]; then
  print_header "Pruning safe Docker artifacts (containers/images/build-cache/networks)"
  docker container prune -f || true
  docker image prune -f || true
  docker builder prune -f --filter 'until=168h' || true
  docker network prune -f || true
fi

if [[ "$DO_PRUNE_AGGRESSIVE" == true ]]; then
  print_header "Pruning aggressive Docker artifacts (all build cache + unused images/networks)"
  docker image prune -af || true
  docker builder prune -af || true
  docker network prune -f || true
fi

if [[ "$DO_PRUNE_VOLUMES" == true ]]; then
  print_header "Pruning unused Docker volumes (destructive for orphaned data)"
  docker volume prune -f || true
fi

if [[ "$DO_PRUNE_SAFE" == true || "$DO_PRUNE_AGGRESSIVE" == true || "$DO_PRUNE_VOLUMES" == true ]]; then
  print_header "Post-prune status"
  show_status
fi

print_header "Done"
