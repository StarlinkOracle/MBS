# Operations Hardening Runbook

## Correlation IDs and Structured Logs
- API now emits/accepts `x-correlation-id` on every request.
- If absent, API generates one and returns it in response headers.
- Tool executions, audit rows, and outbox rows now store `correlationId` for trace joins.
- API/worker logs are line-oriented JSON with:
  - `service`
  - `event`
  - `ts`
  - `correlationId` when available

## Runtime Security Guardrails
- Health checks now flag insecure JWT config:
  - issue key: `auth_jwt_secret_insecure`
  - recommendation: rotate `JWT_SECRET` and restart API
- Health checks now flag missing/weak intake and webhook secrets:
  - issue keys: `ingest_tokens_missing`, `ingest_tokens_insecure`
  - issue keys: `ingest_ip_hash_salt_missing`, `ingest_ip_hash_salt_insecure`
  - issue keys: `call_webhook_secret_missing`, `call_webhook_secret_insecure`
  - recommendation: rotate `MBS_INGEST_TOKENS`, `MBS_IP_HASH_SALT`, and `CALL_WEBHOOK_SECRET` to strong random values
- Call webhook endpoint now has IP rate limiting:
  - `CALL_WEBHOOK_RATE_LIMIT_MAX` (default `120`)
  - `CALL_WEBHOOK_RATE_LIMIT_WINDOW_MS` (default `60000`)
  - limit exceed returns `429` with `CALL_WEBHOOK_RATE_LIMITED`.
- Rate-limited responses now include deterministic backoff guidance:
  - HTTP header: `Retry-After` (seconds)
  - JSON field when structured errors are used: `retryAfterSeconds`
  - covered endpoints: intake (`/api/intake/*`), call webhook (`/api/webhooks/calls`), mobile auth login/refresh, and mobile sync push/pull.
- Health now tracks 1-hour rate-limit pressure counters and warns when exceeded:
  - issue keys: `ingest_rate_limited_high`, `mobile_login_rate_limited_high`, `mobile_refresh_rate_limited_high`, `mobile_sync_push_rate_limited_high`, `mobile_sync_pull_rate_limited_high`, `mobile_sync_payload_rejected_high`, `call_webhook_rate_limited_high`, `agent_playbook_rate_limited_high`, `agent_playbook_inflight_limit_high`, `agent_playbook_duplicate_inflight_high`, `agent_playbook_timeout_high`, `agent_playbook_pack_load_failed_high`, `agent_playbook_payload_rejected_high`, `agent_playbook_fail_closed_high`, `agent_playbook_governance_unavailable_high`
  - thresholds:
    - `HEALTH_MAX_RATE_LIMITED_INGEST_1H`
    - `HEALTH_MAX_RATE_LIMITED_MOBILE_LOGIN_1H`
    - `HEALTH_MAX_RATE_LIMITED_MOBILE_REFRESH_1H`
    - `HEALTH_MAX_RATE_LIMITED_MOBILE_SYNC_PUSH_1H`
    - `HEALTH_MAX_RATE_LIMITED_MOBILE_SYNC_PULL_1H`
    - `HEALTH_MAX_MOBILE_SYNC_PAYLOAD_REJECTED_1H`
    - `HEALTH_MAX_RATE_LIMITED_CALL_WEBHOOK_1H`
    - `HEALTH_MAX_RATE_LIMITED_AGENT_PLAYBOOK_1H`
    - `HEALTH_MAX_PLAYBOOK_INFLIGHT_LIMIT_REACHED_1H`
    - `HEALTH_MAX_PLAYBOOK_DUPLICATE_INFLIGHT_1H`
    - `HEALTH_MAX_PLAYBOOK_REQUEST_TIMEOUT_1H`
    - `HEALTH_MAX_PLAYBOOK_PACK_LOAD_FAILURES_1H`
    - `HEALTH_MAX_PLAYBOOK_PAYLOAD_REJECTED_1H`
    - `HEALTH_MAX_PLAYBOOK_FAIL_CLOSED_BLOCKED_1H`
    - `HEALTH_MAX_PLAYBOOK_GOVERNANCE_ERRORS_1H`
- Playbook fail-closed gate telemetry:
  - when a request is denied by configured fail-closed policy, API returns `503 PLAYBOOK_FAIL_CLOSED` and increments `playbookFailClosedBlocked1h`.
  - when the fail-closed governance health check cannot be evaluated, API returns:
    - `503 PLAYBOOK_GOVERNANCE_TIMEOUT` or
    - `503 PLAYBOOK_GOVERNANCE_UNAVAILABLE`
    and increments `playbookGovernanceErrors1h`.
  - gate controls:
    - `AGENT_PLAYBOOK_FAIL_CLOSED_ENABLED` (default `false`)
    - `AGENT_PLAYBOOK_FAIL_CLOSED_TIMEOUT_MS` (default `3000`, hard cap `30000`)
    - `AGENT_PLAYBOOK_FAIL_CLOSED_ISSUE_KEYS` (comma-separated issue keys)
    - `AGENT_PLAYBOOK_FAIL_CLOSED_ON_CRITICAL` (default `false`)
- Playbook executor in-flight controls now enforce fairness by actor:
  - `AGENT_PLAYBOOK_MAX_INFLIGHT_GLOBAL` (default `24`)
  - `AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ORG` (default `8`)
  - `AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ACTOR` (default `2`)
  - saturation returns `503` with `PLAYBOOK_INFLIGHT_LIMIT_REACHED` and includes `inflightForActor` details.
  - deterministic dedupe returns `409` with `PLAYBOOK_DUPLICATE_INFLIGHT` when the same `orgId + actorUserId + packId + playbookStableId + correlationId` is already in flight.
- Agent playbook timeout-class failures return `504` for both:
  - request-level timeout: `PLAYBOOK_REQUEST_TIMEOUT`
  - step-level timeout: `PLAYBOOK_STEP_TIMEOUT`
  - both contribute to `playbookRequestTimeout1h` pressure metric.
- Agent playbook step payload budget guard:
  - `AGENT_PLAYBOOK_MAX_STEP_PAYLOAD_BYTES` (default `65536`)
  - `AGENT_PLAYBOOK_MAX_STEP_PAYLOAD_DEPTH` (default `25`)
  - `AGENT_PLAYBOOK_MAX_STEP_PAYLOAD_KEYS` (default `6000`)
  - oversize step payloads return `413` with `PLAYBOOK_STEP_PAYLOAD_TOO_LARGE`.
  - invalid step payload shape returns `400` with `PLAYBOOK_STEP_PAYLOAD_SHAPE_INVALID`.
  - repeated rejections are tracked in health metric `playbookPayloadRejected1h`.
- API startup now fails fast in `NODE_ENV=production` when `JWT_SECRET` is default/weak.
  - bypass only with `ALLOW_INSECURE_JWT_SECRET=true` (emergency-only).
- API startup now also fails fast in `NODE_ENV=production` when:
  - `MBS_INGEST_TOKENS` is missing/weak (bypass: `ALLOW_INSECURE_INGEST_TOKENS=true`)
  - `MBS_IP_HASH_SALT` is missing/weak (bypass: `ALLOW_INSECURE_INGEST_IP_HASH_SALT=true`)
  - `CALL_WEBHOOK_SECRET` is missing/weak (bypass: `ALLOW_INSECURE_CALL_WEBHOOK_SECRET=true`)
  - Use bypass flags only for short emergency windows.
- JSON body parser now uses deterministic guardrails:
  - `API_JSON_BODY_LIMIT` (default `1mb`)
  - malformed JSON returns `400` with `API_JSON_INVALID`
  - oversized JSON returns `413` with `API_JSON_PAYLOAD_TOO_LARGE`
- System health endpoints now have bounded request budgets:
  - `SYSTEM_HEALTH_REQUEST_TIMEOUT_MS` (default `8000`)
  - timeout returns `504` with structured error codes:
    - `SYSTEM_HEALTH_TIMEOUT`
    - `SYSTEM_HEALTH_INCIDENTS_TIMEOUT`
    - `SYSTEM_HEALTH_HISTORY_TIMEOUT`
    - `SYSTEM_HEALTH_SMOKE_TIMEOUT`
- Readiness gate endpoint:
  - `GET /api/system/readiness?mode=strict|critical`
  - permissions: `system:ops:read` (or `system:*`, `*`)
  - `mode=strict` returns `503` if any WARN/CRITICAL issue exists
  - `mode=critical` returns `503` only for CRITICAL issues
  - timeout returns `504` with `SYSTEM_READINESS_TIMEOUT`
  - use this endpoint for deploy gating and launchd automation checks.

## Outbound Comms Send Idempotency
- `comms.draft.approveAndSend` is hardened against duplicate retries:
  - If draft is already `QUEUED_APPROVAL`, repeated call returns `EXECUTED` idempotent response (no extra approval request).
  - If draft is already `SENT`, repeated call returns `EXECUTED` idempotent response (no extra outbound send).
- API endpoint `/api/comms/drafts/:id/approve-send` accepts optional idempotency pass-through:
  - header: `x-idempotency-key`
  - body: `requestId`

## Live Stream Cursor Hardening
- SSE endpoint (`GET /api/stream`) now uses a deterministic boundary cursor model:
  - query window is inclusive on cursor timestamp
  - each emitted event carries a stable key (`type:id:timestamp`)
  - same-timestamp events are de-duplicated via boundary IDs instead of `-1ms` cursor rewind
- reconnects honor `Last-Event-ID` to resume from the exact boundary event
- This prevents repeated event floods and missed updates when many rows share the same timestamp.

### Stream resource guardrails
- Connection limits:
  - `STREAM_MAX_CONNECTIONS_GLOBAL` (default `150`)
  - `STREAM_MAX_CONNECTIONS_PER_USER` (default `4`)
- Poll/data caps:
  - `STREAM_MAX_ROWS_PER_TABLE` (default `200`)
  - `STREAM_MAX_EVENTS_PER_POLL` (default `400`)
- Backpressure timeout:
  - `STREAM_MAX_BACKPRESSURE_MS` (default `30000`)
  - if downstream client remains blocked past this window, API closes stream with `STREAM_BACKPRESSURE_TIMEOUT`.
- Type filter validation:
  - `STREAM_TYPES_MAX_QUERY_BYTES` (default `512`)
  - `/api/stream?types=...` must be a comma-separated string of known event types.
  - Invalid values return `400` with `STREAM_INVALID_TYPES_FILTER`.
  - Oversized values return `400` with `STREAM_TYPES_FILTER_TOO_LARGE`.
- Cursor validation:
  - `STREAM_SINCE_MAX_QUERY_BYTES` (default `128`)
  - `/api/stream?since=...` must be a valid ISO timestamp string.
  - Invalid values return `400` with `STREAM_INVALID_CURSOR`.
  - Oversized values return `400` with `STREAM_CURSOR_TOO_LARGE`.

## Error Telemetry Hook
- Optional webhook sink:
  - `ERROR_TELEMETRY_WEBHOOK_URL`
- API and worker send failure telemetry payloads to this endpoint for:
  - uncaught exceptions
  - unhandled promise rejections
  - worker outbox event failures
  - API 5xx request responses

## Backup Automation
- Script: `<repo-root>/scripts/ops/backup_nightly.sh`
- Output: `${BACKUP_DIR}/<UTC timestamp>/`
- Default `BACKUP_DIR`: `~/mbs-backups` (override via env for custom locations)
  - `postgres.sql.gz`
  - `minio-data.tgz`
  - `manifest.txt` (checksums + source settings)

### One-time local setup
```bash
cd "<repo-root>"
cp .env.example .env
docker compose up -d --build
```

Local compose is pinned to dev-safe defaults:
- MinIO access key: `minioadmin`
- MinIO secret key: `minioadmin`
- Bucket: `mbs`
- Long-running services (`postgres`, `minio`, `api`, `worker`, `web`) use `restart: unless-stopped` to reduce silent downtime.
- `agent` remains on-demand (CLI runner), so it is intentionally not restart-looped.

### Run backup manually
```bash
cd "<repo-root>"
bash scripts/ops/backup_nightly.sh
```

### Schedule nightly backup (Mac mini)
Use launchd or cron to run once per night. Example cron:
```cron
0 2 * * * cd "<repo-root>" && bash scripts/ops/backup_nightly.sh >> backups/backup.log 2>&1
```

## Restore Drill Validation
- Script: `<repo-root>/scripts/ops/restore_drill.sh`
- Performs:
  - snapshot verification (`verify_backup_snapshot.sh`) before restore
  - archive integrity checks
  - single-run lock guard (`restore-drill.lock`) to prevent overlapping drills
  - stale lock auto-recovery (default threshold: 7200 seconds)
  - restore into temporary DB
  - validation query
  - cleanup (drops drill DB)
  - writes restore marker:
    - `status=success` on pass
    - `status=failed` + `errorStep` + `errorCode` on failure
  - marker writes are atomic (temp-file + rename) to avoid partial reads during health checks

### Run restore drill
```bash
cd "<repo-root>"
bash scripts/ops/restore_drill.sh backups/<TIMESTAMP_FOLDER>
# or with default path:
bash scripts/ops/restore_drill.sh "$HOME/mbs-backups/<TIMESTAMP_FOLDER>"
```

Optional lock tuning:
- `HEALTH_RESTORE_DRILL_LOCK_PATH` (override lock path)
- `RESTORE_DRILL_LOCK_MAX_AGE_SECONDS` (default `7200`)

Expected success tail:
```text
[restore-drill] running validation query
 table_count
-------------
 <n>
[restore-drill] success: backup is restorable
```

## Nightly automation commands (Mac mini)
```cron
0 2 * * * cd "<repo-root>" && bash scripts/ops/backup_nightly.sh >> backups/backup.log 2>&1
30 2 * * 1 cd "<repo-root>" && LATEST=$(ls -1dt backups/* | head -n 1) && bash scripts/ops/restore_drill.sh "$LATEST" >> backups/restore-drill.log 2>&1
```

## launchd Jobs (recommended on Mac mini)
Scripts:
- `<repo-root>/scripts/ops/install_launchd_jobs.sh`
- `<repo-root>/scripts/ops/restore_latest_drill.sh`
- `<repo-root>/scripts/ops/load_smoke_record.sh`
- `<repo-root>/scripts/ops/rotate_ops_logs.sh`
- `<repo-root>/scripts/ops/health_check_and_alert.sh`

Render + load jobs:
```bash
cd "<repo-root>"
bash scripts/ops/install_launchd_jobs.sh --load
```

What the installer does:
- Copies ops scripts into `~/.rcs-ops/scripts/ops` (launchd-safe path).
- Writes plists into `~/Library/LaunchAgents`.
- Sets launchd PATH for Docker CLI:
  - `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`
- Uses container-mode backup/restore:
  - Postgres container: `russellcomfortsolutions_postgres_1`
  - MinIO container: `russellcomfortsolutions_minio_1`
  - Backup folder: `~/mbs-backups`

Dry-run render (for review):
```bash
bash scripts/ops/install_launchd_jobs.sh --dry-run --output-dir /tmp/rcs-launchagents
```

Override defaults if needed:
```bash
BACKUP_POSTGRES_CONTAINER=my-postgres \
BACKUP_MINIO_CONTAINER=my-minio \
BACKUP_DIR="$HOME/custom-backups" \
bash scripts/ops/install_launchd_jobs.sh --load
```

Unload and remove jobs:
```bash
bash scripts/ops/install_launchd_jobs.sh --uninstall
```

Installed labels:
- `com.rcs.backup.nightly` (daily 02:00)
- `com.rcs.restore.weekly` (Monday 02:30)
- `com.rcs.logs.rotate.weekly` (Monday 03:00)
- `com.rcs.loadsmoke.weekly` (Monday 03:30)
- `com.rcs.health.hourly` (hourly, run-at-load; emits alerts on WARN/CRITICAL)

Check job state:
```bash
launchctl print gui/$(id -u)/com.rcs.backup.nightly
launchctl print gui/$(id -u)/com.rcs.restore.weekly
launchctl print gui/$(id -u)/com.rcs.logs.rotate.weekly
launchctl print gui/$(id -u)/com.rcs.loadsmoke.weekly
launchctl print gui/$(id -u)/com.rcs.health.hourly
```

One-command health check:
```bash
cd "<repo-root>"
bash scripts/ops/check_launchd_health.sh
```
This prints:
- launchd state/runs/exit code for each RCS ops job
- recent error-like lines from `~/mbs-backups/backup.log`, `~/mbs-backups/restore-drill.log`, `~/mbs-backups/load-smoke.log`, and `~/mbs-backups/health.log`

Repair launchd jobs (bootstrap missing + recycle non-zero last-exit jobs):
```bash
npm run ops:launchd:repair
```

Repair + immediately run hourly health job:
```bash
npm run ops:launchd:repair:run-health
```

If repair prints `Input/output error` from `launchctl bootstrap`, run from an interactive macOS login session and reinstall:
```bash
bash scripts/ops/install_launchd_jobs.sh --load
npm run ops:launchd:repair:run-health
```

If plists are missing, reinstall jobs:
```bash
bash scripts/ops/install_launchd_jobs.sh --load
```

## System Health Gate (containers + DB + backlog + backups)
Script:
- `<repo-root>/scripts/ops/check_system_health.sh`

Run human-readable:
```bash
cd "<repo-root>"
bash scripts/ops/check_system_health.sh
```

Run JSON mode:
```bash
bash scripts/ops/check_system_health.sh --json
```

NPM shortcuts:
```bash
npm run ops:health
npm run ops:health:json
npm run ops:health:alert
npm run ops:health:remediate:dry-run
npm run ops:health:remediate
npm run ops:health:remediate:aggressive
npm run ops:backup:verify
npm run ops:backup:verify:json
npm run ops:load:smoke
npm run ops:load:smoke:json
npm run ops:load:smoke:record
```

Alert behavior:
- `scripts/ops/health_check_and_alert.sh` wraps `check_system_health.sh --json`
- Sends webhook alert on non-zero health exit to:
  - `HEALTH_ALERT_WEBHOOK_URL` (preferred), else
  - `ERROR_TELEMETRY_WEBHOOK_URL`
- Persists incident snapshots for WARN/CRITICAL at:
  - `HEALTH_INCIDENT_DIR` (default: `~/mbs-backups/incidents`)
- Retries webhook delivery with backoff:
  - attempts: `HEALTH_ALERT_RETRY_ATTEMPTS` (default `3`)
  - delay: `HEALTH_ALERT_RETRY_BASE_DELAY_SECONDS` (default `2`, linear backoff)
  - timeout per attempt: `HEALTH_ALERT_MAX_TIME_SECONDS` (default `10`)
- Duplicate alert suppression:
  - `HEALTH_ALERT_DEDUPE_MINUTES` (default `30`) suppresses repeated identical incidents/webhooks within the window
  - state file: `HEALTH_ALERT_STATE_PATH` (default `~/mbs-backups/health-alert-state.env`)
  - state is written atomically (`.tmp` + rename) to avoid partial writes
  - malformed/future-skewed state is quarantined to `*.corrupt.<timestamp>` and ignored for dedupe
  - `HEALTH_ALERT_MAX_CLOCK_SKEW_SECONDS` (default `300`) bounds tolerated future timestamps in state
- Artifact retention controls:
  - `HEALTH_INCIDENT_RETENTION_DAYS` (default `30`) prunes old `incident_*.json` files
  - `HEALTH_SNAPSHOT_MAX_LINES` (default `10000`) trims `health-history.jsonl` to recent lines
- Concurrency lock controls:
  - `HEALTH_ALERT_LOCK_PATH` (default `~/mbs-backups/health-alert.lock`)
  - `HEALTH_ALERT_LOCK_STALE_SECONDS` (default `1800`) removes stale lock before execution
  - If lock is active, the run is skipped (`alert_lock=busy`) to prevent duplicate incidents/webhooks
- Optional worker auto-heal:
  - `HEALTH_AUTO_HEAL_WORKER=true` to auto-start worker when health is non-zero and worker is down
  - worker target defaults to Compose service lookup via `HEALTH_WORKER_SERVICE=worker`
  - optional explicit override: `HEALTH_WORKER_CONTAINER=<container_name>`
  - optional compose project filter: `HEALTH_COMPOSE_PROJECT=<project>`
  - after start, health is re-evaluated before incident/webhook emission
- Optional launchd auto-heal (macOS):
  - `HEALTH_AUTO_HEAL_LAUNCHD=true` to auto-run launchd repair when issues include `launchd_not_loaded` or `launchd_exit_nonzero`
  - `HEALTH_AUTO_HEAL_LAUNCHD_DRY_RUN=true` to log intended repair actions only (no launchctl mutation)
  - after repair, health is re-evaluated before incident/webhook emission
- Logs each run/delivery attempt to:
  - `HEALTH_ALERT_LOG_PATH` (default: `~/mbs-backups/health-alert.log`)
- Appends every health payload (including healthy runs) to:
  - `HEALTH_SNAPSHOT_LOG_PATH` (default: `~/mbs-backups/health-history.jsonl`)
  - This is the trend source for weekly reliability review.

Automated remediation runner:
- Script: `scripts/ops/remediate_from_health.sh`
- Dry-run by default; `--apply` executes mapped remediations.
- Concurrency guard:
  - lock file `HEALTH_REMEDIATE_LOCK_PATH` (default: `~/mbs-backups/remediate.lock`)
  - stale lock threshold `HEALTH_REMEDIATE_LOCK_STALE_SECONDS` (default: `1800`)
  - if lock is active, run exits safely with no mutation.
  - stale lock health warning threshold `HEALTH_MAX_REMEDIATE_LOCK_AGE_MINUTES` (default: `30`)
- Mapped actions include:
  - disk pressure -> `recover_disk_pressure.sh`
  - DB/container reachability -> `docker compose up -d postgres api worker`
  - launchd issues -> `repair_launchd_jobs.sh --run-health-now`
  - backup/restore drift -> `backup_nightly.sh` + `restore_latest_drill.sh`
  - snapshot staleness -> `health_check_and_alert.sh`
  - load smoke drift -> `load_smoke_record.sh`

Exit codes:
- `0`: healthy
- `1`: warning thresholds exceeded
- `2`: critical issue (container/db/backup freshness)

Backup verification utility:
- Script: `scripts/ops/verify_backup_snapshot.sh`
- Verifies latest (or explicit) snapshot for required files, manifest, checksums, and archive structure (`gzip -t` and `tar -tzf`).
- Exit codes:
  - `0`: verified OK
  - `1`: unverified checks (tooling unavailable)
  - `2`: invalid/corrupt backup snapshot

Default threshold env vars (override as needed):
- `HEALTH_MAX_PENDING_OUTBOX=200`
- `HEALTH_MAX_FAILED_OUTBOX=10`
- `HEALTH_MAX_STALE_PENDING_OUTBOX_MINUTES=15`
- `HEALTH_MAX_STALE_PENDING_OUTBOX=50`
- `HEALTH_MAX_STALE_MEDIA_UPLOAD_SESSIONS=50`
- `HEALTH_MAX_PENDING_APPROVALS=100`
- `HEALTH_MAX_FAILED_EXECUTIONS_1H=25`
- `HEALTH_MAX_BACKUP_AGE_HOURS=30`
- `HEALTH_MAX_RESTORE_DRILL_AGE_HOURS=192` (8 days)
- `HEALTH_MAX_LOAD_SMOKE_AGE_HOURS=192` (8 days)
- `HEALTH_MIN_LOAD_SMOKE_SUCCESS_PCT=99`
- `HEALTH_MAX_LOAD_SMOKE_P95_SECONDS=2.5`
- `HEALTH_LOAD_SMOKE_TREND_WINDOW=5`
- `HEALTH_LOAD_SMOKE_MAX_FAILS_WINDOW=2`
- `HEALTH_LOAD_SMOKE_HISTORY_MAX_LINES=5000`
- `HEALTH_MIN_DISK_FREE_GB=10`
- `HEALTH_MIN_DISK_FREE_PCT=10`
- `HEALTH_MAX_SNAPSHOT_AGE_MINUTES=120`
- `HEALTH_BACKUP_CHECKSUM_CACHE_MINUTES=30` (API checksum verification cache window)
  - Cache keys also include backup file signatures (size+mtime), so modified snapshot files invalidate cache immediately.
- `HEALTH_RESTORE_DRILL_MARKER_PATH=<optional absolute path>`
- `HEALTH_LOAD_SMOKE_MARKER_PATH=<optional absolute path>`
- `HEALTH_LOAD_SMOKE_HISTORY_PATH=<optional absolute path>`
- `HEALTH_CHECK_LAUNCHD=auto` (`auto` checks only on macOS; set `true` to force, `false` to skip)
- `HEALTH_LAUNCHD_PLIST_DIR=~/Library/LaunchAgents` (where launchd plist install state is checked)
- `HEALTH_LAUNCHD_EXPECT_ALL_LABELS=false` (default checks only installed labels; set true to enforce all standard labels)
- `HEALTH_WORKER_SERVICE=worker` (worker auto-heal Compose service lookup)
- `HEALTH_WORKER_CONTAINER=<optional explicit worker container name>`
- `HEALTH_REQUIRED_SERVICES=postgres,api,web,minio,worker` (default, Compose service-label based)
- `HEALTH_COMPOSE_PROJECT=<optional compose project name>` (only needed when multiple compose projects share one Docker host)
- `HEALTH_REQUIRED_CONTAINERS=<optional explicit container names>` (overrides service-based checks when set)

Disk pressure behavior:
- If Postgres logs contain `No space left on device`, health emits `postgres_disk_full` (CRITICAL).
- If free space falls below `HEALTH_MIN_DISK_FREE_GB` or `HEALTH_MIN_DISK_FREE_PCT`, health emits critical disk pressure issues.

## Control Room Health API
API now exposes ops health snapshots for the internal dashboard.

Endpoints:
- `GET /api/system/health`
- `GET /api/system/health/incidents?limit=10`
- `GET /api/system/health/history?limit=48`
- `GET /api/system/health/smoke`

Permission required:
- `system:ops:read` (or `system:*` / `*`)

What `/api/system/health` includes:
- Live governance metrics from DB (`EventOutbox`, `ApprovalRequest`, `ToolExecution`, `AgentRun`, kill switch mode)
- Media upload session drift metric:
  - `staleMediaUploadSessions` counts `INITIATED`/`FAILED` sessions with `expiresAt < now`
  - `media_upload_sessions_stale_high` emits when count exceeds `HEALTH_MAX_STALE_MEDIA_UPLOAD_SESSIONS`
- Threshold evaluation (`OK` / `WARN` / `CRITICAL`)
- `recommendedActions` array with deterministic remediation commands keyed by issue code
- snapshot freshness checks:
  - `ops_snapshot_missing` if no latest snapshot line is available
  - `ops_snapshot_stale` if latest snapshot exceeds `HEALTH_MAX_SNAPSHOT_AGE_MINUTES`
- Backup freshness check (`BACKUP_DIR`)
  - If `BACKUP_DIR` is explicitly configured: missing/unreadable backups are `CRITICAL`
  - If `BACKUP_DIR` is not configured: endpoint reports `backup_visibility_unconfigured` as `WARN`
  - Latest backup integrity check: `backup_incomplete` (`CRITICAL`) if required files are missing/empty (`postgres.sql.gz`, `minio-data.tgz`, `manifest.txt`)
  - Manifest check: `backup_manifest_invalid` (`CRITICAL`) if manifest keys are missing or manifest references missing files
  - Checksum check (API + ops script): `backup_checksum_mismatch` (`CRITICAL`) when payload hashes do not match manifest
  - If checksum verification cannot run on node, `backup_checksum_unavailable` (`WARN`)
  - Archive structure check after checksum pass:
    - `backup_archive_corrupt` (`CRITICAL`) when `postgres.sql.gz` fails gzip integrity or `minio-data.tgz` fails tar listing
    - `backup_archive_unavailable` (`WARN`) when node cannot run archive validation tools
- Restore drill freshness check (`HEALTH_RESTORE_DRILL_MARKER_PATH`)
  - `restore_drill_missing` or `restore_drill_invalid` when marker is absent/corrupt
  - `restore_drill_failed` when latest drill marker reports non-success status
  - `restore_drill_stale` when marker age exceeds `HEALTH_MAX_RESTORE_DRILL_AGE_HOURS`
  - `restore_drill_lock_stale` when restore lock age exceeds `HEALTH_MAX_RESTORE_DRILL_LOCK_AGE_MINUTES`
- Health remediation lock check (`HEALTH_REMEDIATE_LOCK_PATH`)
  - `remediate_lock_stale` when remediation lock age exceeds `HEALTH_MAX_REMEDIATE_LOCK_AGE_MINUTES`
- Load smoke freshness/performance check (`HEALTH_LOAD_SMOKE_MARKER_PATH`)
  - `load_smoke_missing` / `load_smoke_marker_invalid` when baseline marker is absent/corrupt
  - `load_smoke_failed` when latest baseline run failed
  - `load_smoke_stale` when marker age exceeds `HEALTH_MAX_LOAD_SMOKE_AGE_HOURS`
  - `load_smoke_regressed` when success rate is below `HEALTH_MIN_LOAD_SMOKE_SUCCESS_PCT`
  - `load_smoke_latency_high` when p95 exceeds `HEALTH_MAX_LOAD_SMOKE_P95_SECONDS`
  - `load_smoke_trend_failed` when last `HEALTH_LOAD_SMOKE_TREND_WINDOW` runs exceed `HEALTH_LOAD_SMOKE_MAX_FAILS_WINDOW` failures
- Optional latest ops snapshot from `HEALTH_SNAPSHOT_LOG_PATH` (or `${BACKUP_DIR}/health-history.jsonl`)

What `/api/system/health/incidents` includes:
- Parsed incident snapshots from `HEALTH_INCIDENT_DIR` (or `${BACKUP_DIR}/incidents`)
- Most recent first, capped by `limit` (max 50)
- Query controls:
  - `collapse=true|false` (default `true`) groups repeated incidents by fingerprint
  - `collapseWindowMinutes` overrides grouping window (default `HEALTH_INCIDENT_COLLAPSE_WINDOW_MINUTES`, `180`)
- Response fields:
  - `rawCount`: incident files scanned before collapse
  - each incident includes:
    - `fingerprint`
    - `duplicateCount` (>=1)

What `/api/system/health/history` includes:
- Parsed timeline from `HEALTH_SNAPSHOT_LOG_PATH` (`health-history.jsonl`)
- Snapshot points with `overall`, timestamp, and key metrics
- Most recent points, capped by `limit` (max 240)

What `/api/system/health/smoke` includes:
- Read-only smoke diagnostics for incident drill validation
- `checks` object confirms health pipeline readability:
  - live health computation
  - snapshot history readability
  - incidents readability
  - latest snapshot availability
  - backup visibility configured
  - restore drill freshness
  - load smoke freshness

## Load Smoke Baseline
Script:
- `<repo-root>/scripts/ops/load_smoke.sh`

Defaults:
- endpoint: `/health`
- requests: `120`
- concurrency: `12`
- timeout: `8s`
- minimum success rate: `100%` (`LOAD_SMOKE_MIN_SUCCESS_PCT`)
- maximum p95 latency: disabled by default (`LOAD_SMOKE_MAX_P95_SECONDS=0`)

Run:
```bash
cd "<repo-root>"
bash scripts/ops/load_smoke.sh
```

Override example:
```bash
LOAD_SMOKE_BASE_URL=http://localhost:3001 \
LOAD_SMOKE_ENDPOINT=/health \
LOAD_SMOKE_REQUESTS=300 \
LOAD_SMOKE_CONCURRENCY=20 \
bash scripts/ops/load_smoke.sh
```

JSON output mode:
```bash
bash scripts/ops/load_smoke.sh --json
```

Record baseline marker/history (used by health gate):
```bash
bash scripts/ops/load_smoke_record.sh
```

Notes:
- `load_smoke_record.sh` now writes the marker atomically (temp-file + rename).
- Health checks accept marker timestamps from either `completedAtEpoch` or `completedAtIso`, reducing false invalid-marker warnings when one field is missing.

## Disk Pressure Recovery (Postgres "No space left")
Status only:
```bash
npm run ops:disk:status
```

Safe cleanup (no volume prune):
```bash
npm run ops:disk:recover
```

Aggressive cleanup (all build cache + unused images):
```bash
npm run ops:disk:recover:aggressive
```

Optional destructive cleanup for orphan volumes:
```bash
bash scripts/ops/recover_disk_pressure.sh --prune-volumes
```

Recovery sequence:
1. Run `npm run ops:disk:status`.
2. Run `npm run ops:disk:recover` (or `npm run ops:disk:recover:aggressive` if disk pressure persists).
3. Restart Postgres: `docker compose up -d postgres`.
4. Verify health: `npm run ops:health:json` and confirm `dbReachable=true`.

Exit behavior:
- `0` when smoke run passes configured thresholds
- `1` when smoke run fails thresholds
- `2` invalid CLI input

## Minimum Weekly Ops Checklist
1. Confirm nightly backup folder exists for each day.
2. Run one restore drill and store result timestamp.
3. Verify no sustained worker outbox failures.
4. Verify API/worker logs include correlation IDs for sampled requests.
