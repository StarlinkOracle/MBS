# Governance Runbook

This document describes the governance controls that make autonomy safe and upgradeable in this repository.

## Policy JSON v1

The active policy is loaded from `Policy` (`orgId`, `name`, `version`, `isActive`, `policyJson`) and enforced in `ToolRegistry.execute()`.

Policy areas:

- `autonomy`
  - global enable/mode
  - deny/denyIfAutonomous/allowOnly tool rules
  - time-window overlays (deny tools + risk cap)
  - per-run limits
  - per-tool hour/day limits
- `financial.dailyExposure`
  - per-bucket daily cents limits
  - tool-to-bucket cost mapping
  - on-breach behavior (queue approval)
- `approvals`
  - default required approvals + expiry windows
- `killSwitch`
  - mode model (`NORMAL`, `AUTONOMY_OFF`, `FULL_STOP`)
  - behavior controls for autonomous execution

## Kill Switch Operations

### Read current mode

`GET /api/system/killswitch`

This endpoint calls `registry.execute('system.killswitch.status', ...)` so reads are audited consistently.

### Update mode

`POST /api/system/killswitch`

Body:

```json
{
  "mode": "AUTONOMY_OFF",
  "reason": "Operator intervention"
}
```

Notes:

- `system.killswitch.set` is `CRITICAL` + `NEVER_AUTONOMOUS`.
- Autonomous calls are blocked.
- Human calls execute and update `OrgSafetyState`.

## Daily Financial Exposure

Exposure is enforced in `ToolRegistry.execute()` before normal autonomy gating:

1. Map tool to cost rule from `financial.dailyExposure.toolCostMap`.
2. Derive amount from payload field (with invoice fallback for `billing.invoice.issue`).
3. Resolve local policy date (timezone aware).
4. Read `FinancialExposureDaily` by `(orgId, date, bucket)`.
5. If projected usage breaches limit:
   - queue approval (`QUEUED_APPROVAL`)
   - emit `finance.exposure.breached`
6. If within limit:
   - execute tool
   - increment `FinancialExposureDaily.usedCents` inside execution transaction.

## Auditing and Logs

All governance outcomes are persisted:

- `ToolExecution`
  - `BLOCKED`, `QUEUED_APPROVAL`, `EXECUTED`, `FAILED`
  - risk/autonomy snapshots at execution time
- `AuditLog`
  - action trail for blocks, approvals, breach events, executions
- `EventOutbox`
  - `tool.blocked`, `approval.requested`, `finance.exposure.breached`, `tool.executed`, etc.

Operator endpoints for review:

- `GET /api/tools/executions`
- `GET /api/approvals?status=PENDING`
- `GET /api/agent/runs`

