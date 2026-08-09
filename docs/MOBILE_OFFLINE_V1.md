# Mobile Offline-First v1 (Tech + Dispatch)

Runbook for `<repo-root>/apps/mobile_flutter` and mobile sync/timeclock APIs.

## Scope

- Offline queue + idempotent replay (`clientActionId`)
- Mobile sync push/pull with per-device cursors
- PIN-based pilot login for techs
- Timeclock invariants + clock-out auto-heal for open JOB/BREAK entries
- RBAC-gated Tech/Dispatch views
- No GPS permissions in v1

## Backend setup

```bash
docker compose up -d
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/rcs?schema=public npm run migrate:deploy -w @rcs/db
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/rcs?schema=public npm run db:seed
npm run typecheck
```

Optional dev PIN seed for all seeded human users:

```bash
SEED_DEMO_MOBILE_PIN=1234 DATABASE_URL=postgresql://postgres:postgres@localhost:5432/rcs?schema=public npm run db:seed
```

## Mobile setup

From `<repo-root>/apps/mobile_flutter`:

```bash
flutter pub get
flutter pub run build_runner build --delete-conflicting-outputs
flutter test
flutter run
```

## PIN auth

### Login

`POST /api/auth/mobile/pin/login`

Body:

```json
{
  "orgSlug": "russell-comfort",
  "identifier": "tech@russellcomfort.com",
  "pin": "1234",
  "deviceId": "ios-..."
}
```

Returns:
- `accessToken`
- `refreshToken`
- `user`, `roles`, `permissions`, `org`

Sync endpoints require `Authorization: Bearer <accessToken>`.
Access tokens are device-bound (`deviceId` claim); sync push/pull must send the same `deviceId` used at login.
Mismatch returns `403` with `MOBILE_SYNC_DEVICE_MISMATCH`.
`deviceId` must match `^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$`; invalid values return `400` with `AUTH_PIN_INVALID_PAYLOAD`.
Sync/refresh also require an active `MobileClient` session record for `(orgId, userId, deviceId)` created at login.
Access tokens are validated as `HS256` only, and token claims must match the active user/org session (`orgSlug`, `orgId`, `deviceId`).
Access tokens are also bound to current PIN state; admin PIN set/reset invalidates previously issued access tokens.
Any token claim mismatch or unsupported token algorithm returns `401` with `MOBILE_AUTH_INVALID_TOKEN`.

### Refresh

`POST /api/auth/mobile/refresh`

Body:

```json
{
  "refreshToken": "<token>",
  "deviceId": "ios-tech-1"
}
```

Rules:
- refresh token is device-bound and must match `deviceId`
- refresh token is validated with `HS256` + issuer/audience checks
- refresh token is bound to current PIN state; admin PIN set/reset invalidates older refresh tokens
- refresh endpoint is rate-limited by `deviceId + source IP`
- deterministic error codes:
  - `AUTH_REFRESH_INVALID_PAYLOAD` (400)
  - `AUTH_REFRESH_INVALID_TOKEN` (401)
  - `AUTH_REFRESH_PIN_STATE_CHANGED` (401)
  - `AUTH_REFRESH_DEVICE_MISMATCH` (403)
  - `AUTH_REFRESH_SESSION_INVALID` (401)
  - `AUTH_REFRESH_RATE_LIMITED` (429)

### Admin PIN management

- `POST /api/admin/users/:id/pin/set` `{ newPin, reason? }`
- `POST /api/admin/users/:id/pin/reset` `{ temporaryPin?, reason? }`
- Invalid admin payloads return deterministic `400` codes:
  - `AUTH_PIN_SET_INVALID_PAYLOAD`
  - `AUTH_PIN_RESET_INVALID_PAYLOAD`

Both go through ToolRegistry tools:
- `auth.mobile.pin.set`
- `auth.mobile.pin.reset`

### Lockout rules

- 5 failed attempts => lock 15 minutes
- Structured error codes include:
  - `AUTH_PIN_INVALID`
  - `AUTH_PIN_LOCKED`
  - `AUTH_PIN_NOT_SET`
  - `recoverable` boolean

## Timeclock hardening

Invariants:
- only one open SHIFT, BREAK, JOB per user
- BREAK requires open SHIFT
- JOB requires open SHIFT
- BREAK cannot overlap JOB

Clock-out auto-heal:
- open JOB entries are auto-stopped at clock-out timestamp
- open BREAK entries are auto-stopped at clock-out timestamp
- audit actions:
  - `TIME_AUTO_STOP_JOB_ON_CLOCK_OUT`
  - `TIME_AUTO_STOP_BREAK_ON_CLOCK_OUT`
- outbox events:
  - `time.job.autostopped`
  - `time.break.autostopped`

## Mobile sync contracts

### Push

`POST /api/mobile/sync/push`

```json
{
  "deviceId": "ios-tech-1",
  "actions": [
    {
      "clientActionId": "8a31f9b7-2ef9-4e69-9d33-9f3b0e0f4e18",
      "toolName": "time.clockIn",
      "payload": {},
      "reason": "Mobile clock in"
    }
  ]
}
```

Result rows include:
- `status: APPLIED|FAILED`
- `errorCode` (deterministic for FAILED results)
- `recoverable` (deterministic boolean for FAILED results)

Hardening behavior:
- Duplicate `clientActionId` values inside one push payload are rejected with `MOBILE_SYNC_DUPLICATE_ACTION_IDS`.
- Reusing a prior `clientActionId` with a different `toolName` or different payload is rejected with `MOBILE_SYNC_IDEMPOTENCY_CONFLICT` (`recoverable: false`).
- If one action fails (for example unknown tool), remaining actions in the same batch still execute; push does not abort globally.
- Tool name boundary validation:
  - `actions[].toolName` must match `^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$`
  - invalid tool names fail with `400` and `MOBILE_SYNC_INVALID_PAYLOAD`
- Device ID boundary validation:
  - `deviceId` in login/sync payloads must match `^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$`
  - invalid device IDs fail with `400` and deterministic payload validation errors
- Legacy failed-action replay behavior:
  - if stored failure metadata is missing `errorCode`, replay now returns:
    - `errorCode: MOBILE_SYNC_ACTION_PREVIOUSLY_FAILED`
    - `recoverable: false`
- Pending-claim race guard:
  - server marks pending actions with an internal in-progress claim marker.
  - concurrent replay of the same `clientActionId` returns:
    - `errorCode: MOBILE_SYNC_ACTION_IN_PROGRESS`
    - `recoverable: true`
  - stale claims are reclaimed after `MOBILE_SYNC_PENDING_CLAIM_STALE_SECONDS` (default `90`) and replay proceeds deterministically.
- If an action is stuck `PENDING` but a matching `ToolExecution` already exists, the server reconciles from that execution result instead of re-running the mutation.
- Pull cursors are boundary-safe for same-timestamp events:
  - server stores an internal cursor boundary (`timestamp + seen IDs at that timestamp`)
  - API still returns plain ISO cursor timestamps for client compatibility
  - prevents silent drops when multiple events share identical `createdAt`.
- Pull response guardrails:
  - `MOBILE_SYNC_PULL_MAX_AUDIT_EVENTS` (default `500`)
  - `MOBILE_SYNC_PULL_MAX_OUTBOX_EVENTS` (default `500`)
  - `MOBILE_SYNC_PULL_MAX_TIME_EDIT_REQUESTS` (default `50`)
  - `MOBILE_SYNC_PULL_MAX_TODAY_APPOINTMENTS` (default `120`)
  - `MOBILE_SYNC_PULL_MAX_TODAY_TIME_ENTRIES` (default `40`)
  - `MOBILE_SYNC_PULL_MAX_DISPATCH_APPOINTMENTS` (default `300`)
  - response now includes `pageInfo.auditHasMore` / `pageInfo.outboxHasMore` and active limit values.
  - read models include truncation flags when capped (`appointmentsTruncated`, `timeEntriesTruncated`).
  - incoming future cursors are ignored beyond `MOBILE_SYNC_MAX_CURSOR_FUTURE_SKEW_SECONDS` (default `300`) and server falls back to a safe start cursor.
  - incoming cursor size guard:
    - `MOBILE_SYNC_CURSOR_MAX_BYTES` (default `2048`)
    - oversized cursors return `413` with `MOBILE_SYNC_CURSOR_TOO_LARGE`
- Push payload size guardrails:
  - max actions per push: `MOBILE_SYNC_MAX_ACTIONS_PER_PUSH` (default `200`, hard cap `200`)
  - violation returns `413` with `MOBILE_SYNC_TOO_MANY_ACTIONS`
  - per-action payload max bytes: `MOBILE_SYNC_ACTION_MAX_PAYLOAD_BYTES` (default `65536`)
  - per-batch payload max bytes: `MOBILE_SYNC_BATCH_MAX_PAYLOAD_BYTES` (default `524288`)
  - per-action payload shape limits:
    - `MOBILE_SYNC_ACTION_MAX_PAYLOAD_DEPTH` (default `20`)
    - `MOBILE_SYNC_ACTION_MAX_PAYLOAD_KEYS` (default `5000`)
  - violations return `413` with codes:
    - `MOBILE_SYNC_PAYLOAD_TOO_LARGE`
    - `MOBILE_SYNC_BATCH_PAYLOAD_TOO_LARGE`
  - payload-shape violations return `400` with `MOBILE_SYNC_PAYLOAD_SHAPE_INVALID`
- Action execution timeout guardrail:
  - `MOBILE_SYNC_ACTION_TIMEOUT_MS` (default `15000`)
  - timeout marks action `FAILED` with:
    - `errorCode: MOBILE_SYNC_ACTION_TIMEOUT`
    - `recoverable: true`
  - if the same `clientActionId` is replayed later:
    - server first checks for an already-completed `ToolExecution` and reconciles without re-running
    - if none exists, server retries the action once through normal execution path (still idempotent by `clientActionId`)
  - remaining actions in the same push continue processing.
- Push endpoint rate limit guard:
  - key: `userId + deviceId + sourceIp`
  - `MOBILE_SYNC_PUSH_RATE_LIMIT_MAX` (default `120`)
  - `MOBILE_SYNC_PUSH_RATE_LIMIT_WINDOW_MS` (default `60000`)
  - limit exceeded returns `429` with `MOBILE_SYNC_PUSH_RATE_LIMITED` (`recoverable: true`).

### Pull

`POST /api/mobile/sync/pull`

```json
{
  "deviceId": "ios-tech-1",
  "cursors": {
    "auditCursor": "2026-02-22T20:00:00.000Z",
    "outboxCursor": "2026-02-22T20:00:00.000Z"
  }
}
```

Returns deltas + read models (`todaySchedule`, `dispatchDay`, `entities`).

Pull endpoint rate limit guard:
- key: `userId + deviceId + sourceIp`
- `MOBILE_SYNC_PULL_RATE_LIMIT_MAX` (default `240`)
- `MOBILE_SYNC_PULL_RATE_LIMIT_WINDOW_MS` (default `60000`)
- limit exceeded returns `429` with `MOBILE_SYNC_PULL_RATE_LIMITED` (`recoverable: true`).

### Endpoint-level mobile sync auth errors

- Missing bearer token on sync endpoints returns `401` with:
  - `code: MOBILE_AUTH_REQUIRED`
  - `recoverable: true`
- Invalid/expired token returns `401` with:
  - `code: MOBILE_AUTH_INVALID_TOKEN`
  - `recoverable: true`
- Session user missing/deactivated returns `401` with:
  - `code: MOBILE_AUTH_SESSION_INVALID`
  - `recoverable: false`
- Session PIN state changed after token issuance returns `401` with:
  - `code: MOBILE_AUTH_PIN_STATE_CHANGED`
  - `recoverable: true`

## Demo flow

1. Admin sets tech PIN with `/api/admin/users/:id/pin/set`.
2. Tech logs in via mobile PIN screen.
3. Go offline, start a JOB timer, then clock out.
4. Go online and trigger sync.
5. Verify in DB/logs:
   - `ClientAction` is `APPLIED`
   - `ToolExecution.clientActionId` populated
   - JOB entry auto-stopped when clock-out replayed
   - `TIME_AUTO_STOP_JOB_ON_CLOCK_OUT` audit exists

## Tests

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/rcs?schema=public npm --workspace packages/tool-registry test -- tests/timeclock.spec.ts
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/rcs?schema=public npm --workspace apps/api test -- tests/mobile-sync.spec.ts
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/rcs?schema=public npm --workspace apps/api test -- tests/mobile-pin-auth.spec.ts
```

## Troubleshooting

- `Database ... does not exist`: use database `rcs`.
- `flutter: command not found`: install Flutter stable and add to PATH.
- Drift missing generated files: run build_runner.
- `AUTH_PIN_LOCKED`: wait lock window or reset PIN as admin.
- Sync failures: open sync status chip, inspect failed queue items, retry.
