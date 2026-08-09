# Agent Playbooks Runtime

Runtime implementation lives in:

- `<repo-root>/packages/agent-playbooks/`

Fixture-backed packs live under:

- `<repo-root>/apps/api/tests/fixtures/agent-playbooks/<packId>/`

Default execution pack id from API is `mbs_agent_v1_1`.

Supported fixture packs currently include:

- `mbs_agent_v1`
- `mbs_agent_v1_1`

Source repository:

- [StarlinkOracle/MBS-Agent-Orchestration-Packs](https://github.com/StarlinkOracle/MBS-Agent-Orchestration-Packs)

## READY vs SPEC_ONLY

- `READY`
  - Executable.
  - `requiresTools` must be empty or only contain tools present in `tools_catalog.json`.
  - All referenced skill steps execute in order through `ToolRegistry.execute()`.
- `SPEC_ONLY`
  - Not executable.
  - Executor returns `BLOCKED` with `error.code=PLAYBOOK_SPEC_ONLY`.
  - `missingTools` is returned from `requiresTools`.
  - No tool calls are made.

## requiresTools semantics

- `toolSequence[].toolName` must always exist in `tools_catalog.json` for every skill.
- `requiresTools` is interpreted by playbook status:
  - `READY`: all values must exist in catalog.
  - `SPEC_ONLY`: values may include tools not yet implemented (allowed).

## Pack structure

Required files:

- `tools_catalog.json`
- `skills/*.json`
- `playbooks/*.json`
- `schema/tools_catalog.schema.json` (or root fallback)
- `schema/skill.schema.json` (or root fallback)
- `schema/playbook.schema.json` (or root fallback)

Validation flow:

1. JSON parse for all pack files.
2. AJV schema validation for catalog, each skill, and each playbook.
3. Semantic validation:
   - unique `stableId` across skills and playbooks
   - unique `toolName` rows in `tools_catalog.json`
   - unique `toolSequence[].stableId` within each skill
   - all playbook skill references resolve
   - all `toolSequence[].toolName` exist in catalog
   - `READY` playbook `requiresTools` all exist in catalog

## Execution halt behavior

READY playbooks execute deterministic ordered steps:

- `EXECUTED` -> continue
- `QUEUED_APPROVAL` -> stop and return `NEEDS_APPROVAL`
- `BLOCKED` -> stop and return `BLOCKED`
- `FAILED` -> stop and return `FAILED`

When a skill opts into deterministic request ids, the executor computes a stable hash using:

- pack id
- playbook stable id
- skill stable id
- step stable id
- inputs
- optional correlation id (if enabled by skill policy)

## Hardening controls

- Manifest integrity:
  - API pack loading verifies fixture pack hash against:
    - `apps/api/tests/fixtures/EXTERNAL_PACKS_MANIFEST.json`
  - disable only if needed with:
    - `AGENT_PLAYBOOK_ENFORCE_MANIFEST=false`
- Symlink safety:
  - pack loader rejects symlinked JSON/schema artifacts.
  - this prevents fixture/runtime pack resolution from reading files outside the pack root.
- Result schema enforcement:
  - if playbook sets `resultSchemaId` and pack provides `results.schema.json`,
    final result is AJV-validated.
  - schema mismatch returns:
    - `FAILED` with `error.code=RESULT_SCHEMA_VALIDATION_FAILED`
- Retry safety:
  - executor allows at most one recoverable retry.
  - retry requires deterministic `requestId`.
  - retries are limited to `LOW`/`MEDIUM` risk.
  - `HIGH`/`CRITICAL` are never auto-retried.
- Step budget:
  - runtime enforces max step limit (default `200`).
  - API env `AGENT_PLAYBOOK_MAX_STEPS` is sanitized to positive integer and clamped to hard limit `500`.
  - overflow returns:
    - `FAILED` with `error.code=PLAYBOOK_MAX_STEPS_EXCEEDED`
- Step timeout:
  - runtime enforces per-step timeout (default `15000ms`).
  - API env `AGENT_PLAYBOOK_MAX_STEP_EXECUTION_MS` is sanitized to positive integer and clamped to hard limit `120000ms`.
  - applies to both initial execution and deterministic retry-once path.
  - timeout returns:
    - `FAILED` with `error.code=PLAYBOOK_STEP_TIMEOUT`
  - timeout failures are never auto-retried.
- Request timeout:
  - API enforces a request-level timeout budget around playbook execution.
  - env: `AGENT_PLAYBOOK_REQUEST_TIMEOUT_MS` (default `30000ms`, hard limit `300000ms`).
  - timeout returns:
    - `status=FAILED`
    - `error.code=PLAYBOOK_REQUEST_TIMEOUT`
    - HTTP status `504`.
- Endpoint rate limit:
  - API enforces rate limiting per `(orgId, actorUserId, sourceIp)` for playbook execution.
  - env: `AGENT_PLAYBOOK_RATE_LIMIT_MAX` (default `120`)
  - env: `AGENT_PLAYBOOK_RATE_LIMIT_WINDOW_MS` (default `60000`)
  - over-limit returns:
    - `status=FAILED`
    - `error.code=PLAYBOOK_RATE_LIMITED`
    - HTTP status `429`
    - `Retry-After` response header and `error.retryAfterSeconds`.
- In-flight execution guard:
  - API enforces deterministic concurrency caps before runtime execution.
  - env: `AGENT_PLAYBOOK_MAX_INFLIGHT_GLOBAL` (default `24`, hard cap `500`)
  - env: `AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ORG` (default `8`, hard cap `200`)
  - when saturated, endpoint returns:
    - `status=FAILED`
    - `error.code=PLAYBOOK_INFLIGHT_LIMIT_REACHED`
    - HTTP status `503`
    - `Retry-After: 1`
- Fail-closed governance gate:
  - API can fail closed before playbook execution using live system health.
  - this guard runs before pack load + runtime execution.
  - env: `AGENT_PLAYBOOK_FAIL_CLOSED_ENABLED` (default `false`)
  - env: `AGENT_PLAYBOOK_FAIL_CLOSED_TIMEOUT_MS` (default `3000`, hard cap `30000`)
  - env: `AGENT_PLAYBOOK_FAIL_CLOSED_ISSUE_KEYS` (comma list, default empty)
  - env: `AGENT_PLAYBOOK_FAIL_CLOSED_ON_CRITICAL` (default `false`)
  - blocked response:
    - `status=FAILED`
    - `error.code=PLAYBOOK_FAIL_CLOSED`
    - `error.details.blockedIssueKeys` contains matched keys
    - HTTP status `503`
  - if governance health check cannot be evaluated and fail-closed is enabled:
    - `status=FAILED`
    - `error.code=PLAYBOOK_GOVERNANCE_TIMEOUT` or `PLAYBOOK_GOVERNANCE_UNAVAILABLE`
    - HTTP status `503`
- Input payload guard (API):
  - `/api/agent/playbooks/execute` enforces max input size in bytes.
  - `packId` and `playbookStableId` must match:
    - `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`
  - `x-correlation-id` header is required (deterministic requestId derivation).
  - missing correlation id returns `400` with `PLAYBOOK_CORRELATION_REQUIRED`.
  - invalid correlation format returns `400` with `PLAYBOOK_CORRELATION_INVALID`.
    - required pattern: `^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$`
  - request middleware replaces invalid inbound correlation IDs with a generated UUID for safe logging/telemetry.
  - runtime wrapper also fails fast if no correlation id is provided by caller context.
  - env: `AGENT_PLAYBOOK_MAX_INPUT_BYTES` (default `65536`).
  - oversized requests return `413` with:
    - `status=FAILED`
    - `error.code=PLAYBOOK_INPUT_TOO_LARGE`
  - input shape guard:
    - env: `AGENT_PLAYBOOK_MAX_INPUT_DEPTH` (default `20`, hard cap `200`)
    - env: `AGENT_PLAYBOOK_MAX_INPUT_KEYS` (default `5000`, hard cap `50000`)
    - exceeding limits returns `400` with:
      - `status=FAILED`
      - `error.code=PLAYBOOK_INPUT_SHAPE_INVALID`
      - `error.details.reason` in `{MAX_DEPTH_EXCEEDED|MAX_KEYS_EXCEEDED}`
  - pack load failures return deterministic codes:
    - `PLAYBOOK_PACK_NOT_FOUND`
    - `PLAYBOOK_PACK_INTEGRITY_MISMATCH`
    - `PLAYBOOK_PACK_SYMLINK_FORBIDDEN`
    - `PLAYBOOK_PACK_VALIDATION_FAILED`
- Pack load budget guards (loader):
  - `AGENT_PLAYBOOK_MAX_FILES` (default `500`)
  - `AGENT_PLAYBOOK_MAX_TOTAL_BYTES` (default `5242880`)
  - `AGENT_PLAYBOOK_MAX_JSON_FILE_BYTES` (default `524288`)
  - exceeded limits fail pack loading deterministically before execution.

## Runtime API

- `loadPackFromDir(packDir)`
- `validatePack(pack)`
- `executePlaybook({ playbookStableId, inputs, executionContext, correlationId, registry, pack })`

## API endpoint

`POST /api/agent/playbooks/execute`

```json
{
  "packId": "mbs_agent_v1_1",
  "playbookStableId": "contract_redline_review_v1_1",
  "inputs": {}
}
```

Response:

```json
{
  "status": "COMPLETED|NEEDS_APPROVAL|BLOCKED|FAILED",
  "executedSteps": [
    {
      "skillStableId": "contract_redline_skill_v1",
      "toolName": "contract.redline.generate",
      "outcome": "EXECUTED"
    }
  ],
  "finalResult": {},
  "approval": {},
  "error": {},
  "missingTools": []
}
```

## Fixture testing approach

Tests are offline and fixture-only. They cover:

- No GitHub/network fetches.
- invalid JSON parse
- schema mismatch
- unknown tool references
- EXECUTED/QUEUED_APPROVAL/BLOCKED/FAILED branch handling
- deterministic requestId behavior

## Pinned fixture contract

External pack fixtures are pinned in:

- `apps/api/tests/fixtures/EXTERNAL_PACKS_MANIFEST.json`

Drift checks:

- `npm run external-packs:manifest:verify`

Manual refresh after intentionally updating fixture files:

- `npm run external-packs:manifest:generate`
