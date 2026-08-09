#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT_DIR="$HOME/Library/LaunchAgents"
DRY_RUN=false
LOAD=false
UNINSTALL=false
RUN_ROOT="${LAUNCHD_OPS_ROOT:-$HOME/.rcs-ops}"
RUN_SCRIPTS_DIR="$RUN_ROOT/scripts/ops"
BACKUP_LOG_DIR="${BACKUP_DIR:-$HOME/mbs-backups}"
DOCKER_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

POSTGRES_CONTAINER="${BACKUP_POSTGRES_CONTAINER:-russellcomfortsolutions_postgres_1}"
MINIO_CONTAINER="${BACKUP_MINIO_CONTAINER:-russellcomfortsolutions_minio_1}"
POSTGRES_DB="${BACKUP_POSTGRES_DB:-rcs}"
POSTGRES_USER="${BACKUP_POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${BACKUP_POSTGRES_PASSWORD:-postgres}"
MINIO_DATA_PATH="${BACKUP_MINIO_DATA_PATH:-/data}"

usage() {
  cat <<USAGE
Usage:
  bash scripts/ops/install_launchd_jobs.sh [--dry-run] [--output-dir <dir>] [--load] [--uninstall]

Options:
  --dry-run           Render plist files only, do not load with launchctl
  --output-dir <dir>  Target folder for plist files (default: ~/Library/LaunchAgents)
  --load              Load/reload jobs with launchctl bootstrap (ignored when --dry-run)
  --uninstall         Unload jobs and remove plist files from output dir
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --output-dir)
      OUTPUT_DIR="${2:-}"
      if [[ -z "$OUTPUT_DIR" ]]; then
        echo "missing value for --output-dir"
        exit 1
      fi
      shift 2
      ;;
    --load)
      LOAD=true
      shift
      ;;
    --uninstall)
      UNINSTALL=true
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

mkdir -p "$OUTPUT_DIR"
mkdir -p "$RUN_SCRIPTS_DIR"
mkdir -p "$BACKUP_LOG_DIR"

cp "$ROOT_DIR/scripts/ops/backup_nightly.sh" "$RUN_SCRIPTS_DIR/backup_nightly.sh"
cp "$ROOT_DIR/scripts/ops/verify_backup_snapshot.sh" "$RUN_SCRIPTS_DIR/verify_backup_snapshot.sh"
cp "$ROOT_DIR/scripts/ops/restore_drill.sh" "$RUN_SCRIPTS_DIR/restore_drill.sh"
cp "$ROOT_DIR/scripts/ops/restore_latest_drill.sh" "$RUN_SCRIPTS_DIR/restore_latest_drill.sh"
cp "$ROOT_DIR/scripts/ops/load_smoke.sh" "$RUN_SCRIPTS_DIR/load_smoke.sh"
cp "$ROOT_DIR/scripts/ops/load_smoke_record.sh" "$RUN_SCRIPTS_DIR/load_smoke_record.sh"
cp "$ROOT_DIR/scripts/ops/rotate_ops_logs.sh" "$RUN_SCRIPTS_DIR/rotate_ops_logs.sh"
cp "$ROOT_DIR/scripts/ops/check_system_health.sh" "$RUN_SCRIPTS_DIR/check_system_health.sh"
cp "$ROOT_DIR/scripts/ops/health_check_and_alert.sh" "$RUN_SCRIPTS_DIR/health_check_and_alert.sh"
chmod +x \
  "$RUN_SCRIPTS_DIR/backup_nightly.sh" \
  "$RUN_SCRIPTS_DIR/verify_backup_snapshot.sh" \
  "$RUN_SCRIPTS_DIR/restore_drill.sh" \
  "$RUN_SCRIPTS_DIR/restore_latest_drill.sh" \
  "$RUN_SCRIPTS_DIR/load_smoke.sh" \
  "$RUN_SCRIPTS_DIR/load_smoke_record.sh" \
  "$RUN_SCRIPTS_DIR/rotate_ops_logs.sh" \
  "$RUN_SCRIPTS_DIR/check_system_health.sh" \
  "$RUN_SCRIPTS_DIR/health_check_and_alert.sh"

backup_plist="$OUTPUT_DIR/com.rcs.backup.nightly.plist"
restore_plist="$OUTPUT_DIR/com.rcs.restore.weekly.plist"
rotate_plist="$OUTPUT_DIR/com.rcs.logs.rotate.weekly.plist"
load_smoke_plist="$OUTPUT_DIR/com.rcs.loadsmoke.weekly.plist"
health_plist="$OUTPUT_DIR/com.rcs.health.hourly.plist"

if [[ "$UNINSTALL" == "true" ]]; then
  if [[ "$DRY_RUN" == "false" ]]; then
    uid="$(id -u)"
    launchctl bootout "gui/$uid" "$backup_plist" >/dev/null 2>&1 || true
    launchctl bootout "gui/$uid" "$restore_plist" >/dev/null 2>&1 || true
    launchctl bootout "gui/$uid" "$rotate_plist" >/dev/null 2>&1 || true
    launchctl bootout "gui/$uid" "$load_smoke_plist" >/dev/null 2>&1 || true
    launchctl bootout "gui/$uid" "$health_plist" >/dev/null 2>&1 || true
  fi
  rm -f "$backup_plist" "$restore_plist" "$rotate_plist" "$load_smoke_plist" "$health_plist"
  echo "[launchd] removed jobs from $OUTPUT_DIR"
  exit 0
fi

cat > "$backup_plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.rcs.backup.nightly</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$RUN_SCRIPTS_DIR/backup_nightly.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$DOCKER_PATH</string>
    <key>BACKUP_DIR</key>
    <string>$BACKUP_LOG_DIR</string>
    <key>BACKUP_POSTGRES_CONTAINER</key>
    <string>$POSTGRES_CONTAINER</string>
    <key>BACKUP_MINIO_CONTAINER</key>
    <string>$MINIO_CONTAINER</string>
    <key>BACKUP_POSTGRES_DB</key>
    <string>$POSTGRES_DB</string>
    <key>BACKUP_POSTGRES_USER</key>
    <string>$POSTGRES_USER</string>
    <key>BACKUP_POSTGRES_PASSWORD</key>
    <string>$POSTGRES_PASSWORD</string>
    <key>BACKUP_MINIO_DATA_PATH</key>
    <string>$MINIO_DATA_PATH</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>$RUN_ROOT</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>2</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$BACKUP_LOG_DIR/backup.log</string>
  <key>StandardErrorPath</key>
  <string>$BACKUP_LOG_DIR/backup.log</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
PLIST

cat > "$restore_plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.rcs.restore.weekly</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$RUN_SCRIPTS_DIR/restore_latest_drill.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$DOCKER_PATH</string>
    <key>BACKUP_DIR</key>
    <string>$BACKUP_LOG_DIR</string>
    <key>BACKUP_POSTGRES_CONTAINER</key>
    <string>$POSTGRES_CONTAINER</string>
    <key>BACKUP_POSTGRES_DB</key>
    <string>$POSTGRES_DB</string>
    <key>BACKUP_POSTGRES_USER</key>
    <string>$POSTGRES_USER</string>
    <key>BACKUP_POSTGRES_PASSWORD</key>
    <string>$POSTGRES_PASSWORD</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>$RUN_ROOT</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key>
    <integer>1</integer>
    <key>Hour</key>
    <integer>2</integer>
    <key>Minute</key>
    <integer>30</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$BACKUP_LOG_DIR/restore-drill.log</string>
  <key>StandardErrorPath</key>
  <string>$BACKUP_LOG_DIR/restore-drill.log</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
PLIST

cat > "$rotate_plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.rcs.logs.rotate.weekly</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$RUN_SCRIPTS_DIR/rotate_ops_logs.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$DOCKER_PATH</string>
    <key>OPS_LOG_DIR</key>
    <string>$BACKUP_LOG_DIR</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>$RUN_ROOT</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key>
    <integer>1</integer>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$BACKUP_LOG_DIR/backup.log</string>
  <key>StandardErrorPath</key>
  <string>$BACKUP_LOG_DIR/backup.log</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
PLIST

cat > "$load_smoke_plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.rcs.loadsmoke.weekly</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$RUN_SCRIPTS_DIR/load_smoke_record.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$DOCKER_PATH</string>
    <key>BACKUP_DIR</key>
    <string>$BACKUP_LOG_DIR</string>
    <key>HEALTH_LOAD_SMOKE_MARKER_PATH</key>
    <string>${HEALTH_LOAD_SMOKE_MARKER_PATH:-$BACKUP_LOG_DIR/load-smoke.marker}</string>
    <key>HEALTH_LOAD_SMOKE_HISTORY_PATH</key>
    <string>${HEALTH_LOAD_SMOKE_HISTORY_PATH:-$BACKUP_LOG_DIR/load-smoke-history.jsonl}</string>
    <key>LOAD_SMOKE_LOG_PATH</key>
    <string>${LOAD_SMOKE_LOG_PATH:-$BACKUP_LOG_DIR/load-smoke.log}</string>
    <key>LOAD_SMOKE_BASE_URL</key>
    <string>${LOAD_SMOKE_BASE_URL:-http://localhost:3001}</string>
    <key>LOAD_SMOKE_ENDPOINT</key>
    <string>${LOAD_SMOKE_ENDPOINT:-/health}</string>
    <key>LOAD_SMOKE_REQUESTS</key>
    <string>${LOAD_SMOKE_REQUESTS:-120}</string>
    <key>LOAD_SMOKE_CONCURRENCY</key>
    <string>${LOAD_SMOKE_CONCURRENCY:-12}</string>
    <key>LOAD_SMOKE_TIMEOUT_SECONDS</key>
    <string>${LOAD_SMOKE_TIMEOUT_SECONDS:-8}</string>
    <key>LOAD_SMOKE_EXPECT_HTTP</key>
    <string>${LOAD_SMOKE_EXPECT_HTTP:-200}</string>
    <key>LOAD_SMOKE_MIN_SUCCESS_PCT</key>
    <string>${LOAD_SMOKE_MIN_SUCCESS_PCT:-100}</string>
    <key>LOAD_SMOKE_MAX_P95_SECONDS</key>
    <string>${LOAD_SMOKE_MAX_P95_SECONDS:-0}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>$RUN_ROOT</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key>
    <integer>1</integer>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>30</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$BACKUP_LOG_DIR/load-smoke.log</string>
  <key>StandardErrorPath</key>
  <string>$BACKUP_LOG_DIR/load-smoke.log</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
PLIST

cat > "$health_plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.rcs.health.hourly</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$RUN_SCRIPTS_DIR/health_check_and_alert.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$DOCKER_PATH</string>
    <key>BACKUP_DIR</key>
    <string>$BACKUP_LOG_DIR</string>
    <key>BACKUP_POSTGRES_CONTAINER</key>
    <string>$POSTGRES_CONTAINER</string>
    <key>BACKUP_POSTGRES_DB</key>
    <string>$POSTGRES_DB</string>
    <key>BACKUP_POSTGRES_USER</key>
    <string>$POSTGRES_USER</string>
    <key>BACKUP_POSTGRES_PASSWORD</key>
    <string>$POSTGRES_PASSWORD</string>
    <key>ERROR_TELEMETRY_WEBHOOK_URL</key>
    <string>${ERROR_TELEMETRY_WEBHOOK_URL:-}</string>
    <key>HEALTH_ALERT_WEBHOOK_URL</key>
    <string>${HEALTH_ALERT_WEBHOOK_URL:-}</string>
    <key>HEALTH_ALERT_LOG_PATH</key>
    <string>${HEALTH_ALERT_LOG_PATH:-$BACKUP_LOG_DIR/health-alert.log}</string>
    <key>HEALTH_SNAPSHOT_LOG_PATH</key>
    <string>${HEALTH_SNAPSHOT_LOG_PATH:-$BACKUP_LOG_DIR/health-history.jsonl}</string>
    <key>HEALTH_INCIDENT_DIR</key>
    <string>${HEALTH_INCIDENT_DIR:-$BACKUP_LOG_DIR/incidents}</string>
    <key>HEALTH_ALERT_RETRY_ATTEMPTS</key>
    <string>${HEALTH_ALERT_RETRY_ATTEMPTS:-3}</string>
    <key>HEALTH_ALERT_RETRY_BASE_DELAY_SECONDS</key>
    <string>${HEALTH_ALERT_RETRY_BASE_DELAY_SECONDS:-2}</string>
    <key>HEALTH_ALERT_MAX_TIME_SECONDS</key>
    <string>${HEALTH_ALERT_MAX_TIME_SECONDS:-10}</string>
    <key>HEALTH_AUTO_HEAL_WORKER</key>
    <string>${HEALTH_AUTO_HEAL_WORKER:-false}</string>
    <key>HEALTH_WORKER_CONTAINER</key>
    <string>${HEALTH_WORKER_CONTAINER:-russellcomfortsolutions_worker_1}</string>
    <key>HEALTH_AUTO_HEAL_LAUNCHD</key>
    <string>${HEALTH_AUTO_HEAL_LAUNCHD:-false}</string>
    <key>HEALTH_AUTO_HEAL_LAUNCHD_DRY_RUN</key>
    <string>${HEALTH_AUTO_HEAL_LAUNCHD_DRY_RUN:-false}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>$RUN_ROOT</string>
  <key>StartInterval</key>
  <integer>3600</integer>
  <key>StandardOutPath</key>
  <string>$BACKUP_LOG_DIR/health.log</string>
  <key>StandardErrorPath</key>
  <string>$BACKUP_LOG_DIR/health.log</string>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
PLIST

echo "[launchd] rendered:"
echo "  $backup_plist"
echo "  $restore_plist"
echo "  $rotate_plist"
echo "  $load_smoke_plist"
echo "  $health_plist"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "[launchd] dry-run mode: skipping launchctl bootstrap"
  exit 0
fi

if [[ "$LOAD" == "true" ]]; then
  uid="$(id -u)"
  launchctl bootout "gui/$uid" "$backup_plist" >/dev/null 2>&1 || true
  launchctl bootout "gui/$uid" "$restore_plist" >/dev/null 2>&1 || true
  launchctl bootout "gui/$uid" "$rotate_plist" >/dev/null 2>&1 || true
  launchctl bootout "gui/$uid" "$load_smoke_plist" >/dev/null 2>&1 || true
  launchctl bootout "gui/$uid" "$health_plist" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$uid" "$backup_plist"
  launchctl bootstrap "gui/$uid" "$restore_plist"
  launchctl bootstrap "gui/$uid" "$rotate_plist"
  launchctl bootstrap "gui/$uid" "$load_smoke_plist"
  launchctl bootstrap "gui/$uid" "$health_plist"
  echo "[launchd] jobs bootstrapped for gui/$uid"
else
  echo "[launchd] use --load to activate jobs"
fi
