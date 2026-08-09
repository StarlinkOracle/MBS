# Claude Task Prompt Library (MBS/HAMB)

Use this with:
- `<repo-root>/docs/CLAUDE_TOOL_AUTHORING_PACK.md`
- `<repo-root>/docs/CLAUDE_TOOL_WORKED_EXAMPLES.md`

Default repo root (current):
- `<repo-root>`

Legacy mirror path seen in existing docs/code comments:
- `<repo-root>`

---

## 1) Universal Prompt Header (Paste First)

```md
You are implementing a governed change in the HAMB/MBS monorepo.

Hard rules:
- All state-changing operations must go through ToolRegistry.execute().
- No direct Prisma writes in API routes for domain mutations.
- Every mutation must produce ToolExecution + AuditLog + EventOutbox entries through registry flow.
- Respect governance gates: RBAC, JSON schema, kill switch, policy blocklists/time windows/rate limits, approvals.
- Keep changes small and upgradeable; no architecture pivots.
- Add/extend tests for new behavior.

Work style:
- Use small checkpoints.
- After each checkpoint: list files changed + commands run + results.
- Preserve existing patterns in packages/tool-registry, apps/api, packages/db, apps/web.
```

---

## 2) Prompt: Add New Governed Write Tool + API Endpoint + Tests

```md
Implement a new governed tool and endpoint end-to-end.

Feature:
- Tool name: <domain.feature.action>
- Purpose: <what it does>
- Risk/autonomy: <LOW|MEDIUM|HIGH|CRITICAL> / <ALWAYS_ALLOWED|REQUIRES_APPROVAL|REQUIRES_2ND_APPROVAL|NEVER_AUTONOMOUS>
- Required permissions: [<perm1>, <perm2>]

Required implementation:
1) Seed:
- Add missing permissions in packages/db/prisma/seed.ts
- Add ToolDefinition with AJV inputSchema, risk/autonomy, requiredPermissions
- Map permission to appropriate roles

2) Tool handler:
- Implement handler in packages/tool-registry/src/handlers.ts with zod validation
- Use transaction where needed
- Keep handler idempotent where practical

3) API route:
- Add route in apps/api/src/index.ts
- Require permission guard
- Call registry.execute(...) and return ensureToolExecuted(...) output

4) Tests:
- Add tool-registry test(s) for success + governance edge case
- Add API test for permission/route behavior

Acceptance:
- No direct Prisma write in API mutation path
- Mutation auditable via ToolExecution/AuditLog/Outbox
- npm run typecheck + relevant tests pass

Report:
- files changed
- commands run
- outputs summary
```

---

## 3) Prompt: Add New Read Tool (Derived Read Model)

```md
Add a read-only governed tool for computed data.

Tool:
- Name: <domain.feature.list/read>
- Permission: <domain:read>
- Risk/autonomy: LOW / ALWAYS_ALLOWED

Requirements:
- Define tool in seed.ts with strict AJV input schema (additionalProperties: false)
- Implement handler in tool-registry handlers with zod parsing
- No domain writes in handler
- Add API GET route that still uses registry.execute for consistent governed path
- Add tests for input validation + response shape

Acceptance:
- Deterministic output
- Permission enforced
- Typecheck/tests pass
```

---

## 4) Prompt: Add High-Risk Approval-Queued Action

```md
Implement a high-risk action that must queue approval and execute only after approval.

Tool:
- Name: <domain.highRisk.action>
- riskLevel: HIGH
- autonomyLevel: REQUIRES_APPROVAL (or REQUIRES_2ND_APPROVAL)
- requiresReason: true

Requirements:
1) seed.ts:
- add permission(s)
- add ToolDefinition with required approvals behavior

2) handler:
- implement domain mutation logic (idempotent)

3) API:
- endpoint calls registry.execute(...)
- return queued response details if QUEUED_APPROVAL

4) approval replay:
- ensure existing approval execution path uses registry approved execution (no direct handler bypass)

5) tests:
- assert initial request queues approval
- assert approval executes exactly once
- assert audit/outbox/tool execution records exist

Output:
- checkpointed file list + commands + results
```

---

## 5) Prompt: Add Prisma Schema + Migration + Seed Safely

```md
Add schema changes safely in MBS monorepo.

Schema goal:
- <new models/enums/fields>

Rules:
- Evolve existing models; do not delete unrelated tables.
- Keep migrations upgradeable and additive.
- Add indexes/uniques explicitly.
- Update seed for default records + permissions + tool definitions if needed.

Required steps:
1) Update packages/db/prisma/schema.prisma
2) Create migration named <migration_name>
3) Update packages/db/prisma/seed.ts
4) Run migrate + seed
5) Run targeted tests and typecheck

Report:
- schema diff summary
- migration name
- command outputs
```

---

## 6) Prompt: Add UI Action That Must Stay Governed

```md
Implement UI action in apps/web, but keep all writes governed.

UI feature:
- Page/component: <path>
- Action(s): <approve/reject/send/update/etc>

Rules:
- No direct DB writes from UI.
- UI calls API endpoints only.
- API endpoints call ToolRegistry.execute for any mutation.
- Show blocked/queued statuses with reason when available.
- Enforce RBAC-based visibility.

Deliverables:
- UI component/page changes
- API route wiring
- tests (UI/API as applicable)
- typecheck pass
```

---

## 7) Prompt: Add “Explain Why Blocked/Queued” Support

```md
Implement deterministic decision explainability for blocked/queued executions.

Requirements:
- Use policy engine structured decision object (decision/stage/reason/details)
- Persist decision details on ToolExecution metadata for BLOCKED/QUEUED_APPROVAL
- Add:
  - GET /api/tools/executions/:id/explain
  - POST /api/tools/:toolName/explain (dry-run, no writes)
- Reuse same evaluation functions for execute and dry-run
- Add tests for parity between dry-run and real decision path
```

---

## 8) Prompt: Bugfix Patch (No Refactor)

```md
Fix this bug with a minimal patch:
- Symptom: <bug>
- Expected: <expected behavior>

Constraints:
- No architecture refactor
- Change only required files
- Keep governance intact (ToolRegistry path, audit/outbox)
- Add regression test

Output:
- root cause
- files changed
- tests proving fix
```

---

## 9) Prompt: Hardening Pass (Reliability First)

```md
Do a reliability hardening pass for <module>.

Focus:
- determinism and idempotency
- race-condition safety (transactions/unique keys)
- clear structured error codes
- retry-safe behaviors
- observability hooks (logs/outbox where relevant)

Do not add new product features unless required to close reliability gaps.
Provide findings ranked by severity and patch them.
```

---

## 10) Validation Command Block (Copy/Paste)

```bash
cd "<repo-root>"
npm run typecheck
npm run test --workspace @mbs/tool-registry
npm run test --workspace @mbs/api
```

If schema changed:

```bash
cd "<repo-root>"
npx prisma migrate dev --schema packages/db/prisma/schema.prisma --name <migration_name>
npm run db:seed --workspace @mbs/db
```

