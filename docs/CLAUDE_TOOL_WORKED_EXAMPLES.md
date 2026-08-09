# Claude Worked Examples (Real MBS Tools)

Use this with:
- `<repo-root>/docs/CLAUDE_TOOL_AUTHORING_PACK.md`

This file gives two concrete, already-implemented patterns from this repo.

## Example A: Low-Risk Read Tool
Tool: `scheduling.blocks.listAvailability`

### Where it is defined
- Seed definition:
  - `<repo-root>/packages/db/prisma/seed.ts:723`
- Handler implementation:
  - `<repo-root>/packages/tool-registry/src/handlers.ts:3264`
- API route:
  - `<repo-root>/apps/api/src/index.ts:5801`

### Why this is a good template
- Risk/autonomy is clean:
  - `riskLevel: LOW`
  - `autonomyLevel: ALWAYS_ALLOWED`
  - permission-gated as `scheduling:read`
- No mutation logic in handler.
- API route still goes through `registry.execute(...)` to keep a consistent governed path.

### What the handler does
1. Validates payload with zod.
2. Validates date range and guards max span.
3. Loads scheduling settings + block templates + business hours + blackout dates + reservations.
4. Computes per-day/per-block capacity/remaining/availability/reason.
5. Returns a normalized JSON result for UI and public booking flows.

### API wiring pattern
`GET /api/scheduling/availability`:
- Requires permission with `requireAnyPermission(...)`.
- Calls:
  - `registry.execute('scheduling.blocks.listAvailability', ...)`
- Uses `ensureToolExecuted(...)` before returning data.

### Practical reuse guidance
Use this pattern for:
- dashboard queries
- read-model style list tools
- anything that computes derived state without writing domain records

---

## Example B: High-Risk Approval-Queued Tool
Tool: `marketing.review.request.send`

### Where it is defined
- Seed definition:
  - `<repo-root>/packages/db/prisma/seed.ts:1405`
- Handler implementation:
  - `<repo-root>/packages/tool-registry/src/handlers.ts:2626`
- API route:
  - `<repo-root>/apps/api/src/index.ts:8346`
- End-to-end queue/approve test:
  - `<repo-root>/packages/tool-registry/tests/review-requests.spec.ts:1`

### Why this is a good template
- Risk/autonomy design is explicit:
  - `riskLevel: HIGH`
  - `autonomyLevel: REQUIRES_APPROVAL`
  - `requiresReason: true`
- Route intentionally sets `isAutonomous: true` to force queue behavior.
- Approval completion path reuses registry approved execution (`executeApprovedRequest`), not manual handler bypass.

### What the handler does
1. Validates `reviewRequestId`.
2. Loads existing `ReviewRequest`.
3. Handles idempotent already-sent case.
4. Marks request as sent and writes provider metadata.
5. Emits domain outbox event `marketing.review.request.sent`.

Note:
- Generic governance records (`ToolExecution`, `AuditLog`, `tool.executed`, `approval.requested`) are handled by registry.

### API wiring pattern
`POST /api/marketing/reviews/requests/:id/send`:
- Requires owner/admin/manager role gate.
- Calls:
  - `registry.execute('marketing.review.request.send', ...)`
- Context uses:
  - `isAutonomous: true`
  - reason string present
- Returns `202` for queued responses and `200` for immediate execute.

### Approval completion flow
1. Registry queues approval (`QUEUED_APPROVAL`) and creates `ApprovalRequest`.
2. Approval route or worker sets request approved.
3. Worker processes `approval.approved` outbox event.
4. Worker calls:
   - `registry.executeApprovedRequest(approvalRequestId, context)`
5. Same handler executes under governed approved path.

---

## Side-by-Side Pattern Summary

- Safe read tool pattern:
  - LOW + ALWAYS_ALLOWED + permission check + computed read result.
- High-risk send pattern:
  - HIGH + REQUIRES_APPROVAL + autonomous API context + approval queue + approved execution replay.

If you are adding a new tool:
1. Start from Example A if read/compute only.
2. Start from Example B if action can affect customers, money, or external comms.

---

## Commands to validate after implementing a new tool using these patterns

```bash
cd "<repo-root>"
npm run typecheck
npm run test -w @rcs/tool-registry
npm run test -w @rcs/api
```

If schema/seed changed:

```bash
npm run db:migrate:dev -- --name your_tool_change
npm run db:seed
```

