# Legal Packs Import

This document covers deterministic import of legal artifacts from:

- [StarlinkOracle/Artifacts-Legal-Packs](https://github.com/StarlinkOracle/Artifacts-Legal-Packs)

The agent playbook side is handled separately by fixture-backed pack loading from:

- [StarlinkOracle/MBS-Agent-Orchestration-Packs](https://github.com/StarlinkOracle/MBS-Agent-Orchestration-Packs)

## Command

```bash
node scripts/import-legal-pack.ts \
  --repo StarlinkOracle/Artifacts-Legal-Packs \
  --tag CO-v1.0.0 \
  --pack packs/CO/v1
```

Optional:

- `--orgId <orgId>`: explicitly choose org.
- `--sourceDir <dir>`: offline mode (use local extracted repo root instead of downloading).
- `--expectedArchiveSha256 <sha256>`: verifies the downloaded GitHub tag archive bytes before extraction.
- `--pack <packPath>` is validated against the selected root; traversal outside root is rejected.

Import safety limits (env-configurable):
- `LEGAL_PACK_IMPORT_MAX_ARCHIVE_BYTES` (default `20971520`)
- `LEGAL_PACK_IMPORT_MAX_EXTRACTED_BYTES` (default `157286400`)
- `LEGAL_PACK_IMPORT_MAX_EXTRACTED_FILES` (default `5000`)
- `LEGAL_PACK_IMPORT_DOWNLOAD_MAX_ATTEMPTS` (default `3`)
- `LEGAL_PACK_IMPORT_DOWNLOAD_TIMEOUT_MS` (default `15000`)
- `LEGAL_PACK_IMPORT_DOWNLOAD_RETRY_DELAY_MS` (default `250`)
- fail-closed governance gate (optional, deterministic):
  - `LEGAL_PACK_IMPORT_FAIL_CLOSED_ENABLED` (default `false`)
  - `LEGAL_PACK_IMPORT_FAIL_CLOSED_ON_CRITICAL` (default `false`)
  - `LEGAL_PACK_IMPORT_FAIL_CLOSED_ISSUE_KEYS` (comma-separated issue keys)
  - `LEGAL_PACK_IMPORT_HEALTH_SNAPSHOT_PATH` (optional override)
  - if enabled and health snapshot cannot be read/parsed, importer blocks with `LEGAL_PACK_GOVERNANCE_UNAVAILABLE`
  - if enabled and configured blockers match, importer blocks with `LEGAL_PACK_FAIL_CLOSED`

Download retry policy is deterministic:
- Retries only transient download failures (`HTTP 429/5xx`, network errors, timeout).
- Does not retry deterministic validation failures (oversize archive, SHA mismatch, non-retryable `HTTP 4xx`).

If `--orgId` is omitted, importer uses:

1. `MBS_IMPORT_ORG_ID` env var
2. oldest org row in DB

## Import flow

1. Download and extract GitHub tag archive (or use `--sourceDir`).
2. Load files:
   - `legal_pack.json`
   - `clauses.json` or `clauses_*.json`
   - `templates.json` or `templates_*.json`
   - `variable_schemas.json` or `variable_schemas_*.json`
   - `placeholder_whitelist.json`
   - `schema/*.schema.json`
3. Validate:
   - JSON parse
   - AJV schema validation
   - jurisdiction is `CO`
   - stableId uniqueness
   - placeholder whitelist
   - reject symlinked pack files (prevents file-level path escape)
   - reject pack paths that resolve outside source root via symlinked directories
4. Execute import through `ToolRegistry.execute()` only.
5. Return structured summary and halt immediately on `QUEUED_APPROVAL`, `BLOCKED`, or `FAILED`.
6. Optional governance preflight can fail-closed before any tool calls are made.

## Idempotency model

Batch request id:

`import:<repoName>:<tag>:<sha256(legal_pack.json)>`

Per-entity request ids:

- Clause: `<batch>:clause:<stableId>:v<version>`
- Template: `<batch>:template:<templateStableId>:v<version>`
- Legal pack metadata: `<batch>:legal-pack:<packStableId>:v<version>`

Reruns:

- Existing `(stableId, version)` clauses/templates return idempotent response.
- Published versions are not updated or republished.
- Existing legal pack version is upserted deterministically.

## Governance and safety

- No direct Prisma writes in API routes for clause/template/legal-pack mutations.
- Importer writes domain state only by calling tools:
  - `contract.clause.*`
  - `contract.template.*`
  - `contract.legalPack.upsert`
- ToolRegistry remains the single governance gate (RBAC, policy, approvals, audit, outbox).
- Import preflight governance (if enabled) occurs before tool execution and prevents partial imports under unhealthy conditions.

## Publish workflow

- `publish: true` in `clauses.json` or `templates.json` triggers publish tool call.
- No auto-publish otherwise.
- Deprecated clause workflow uses `deprecate` + `deprecateReason`.

## Rollback strategy

- Do not mutate published versions.
- Publish a new version with corrected content.
- Deprecate older versions if required by legal policy.
- Re-import with same tag is safe and idempotent.
- For emergency rollback, publish a prior known-good version and deprecate the broken one.

## Offline tests

Importer tests run against vendored fixtures under:

`apps/api/tests/fixtures/legal-packs/CO/v1`

Tests do not call network and use a mocked registry to verify deterministic tool-only ingestion.

## Fixture pinning and drift checks

Both external pack snapshots (legal + agent orchestration) are pinned in:

`apps/api/tests/fixtures/EXTERNAL_PACKS_MANIFEST.json`

Verify no drift:

```bash
npm run external-packs:manifest:verify
```

If fixtures are intentionally updated, regenerate:

```bash
npm run external-packs:manifest:generate
```
