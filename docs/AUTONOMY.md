# Autonomy v1

This repository implements autonomy governance across `packages/tool-registry`, `apps/api`, `apps/worker`, and `apps/agent` using Prisma + PostgreSQL.

## Core Rules

- Agents do not mutate business data directly; all business actions run through `ToolRegistry.execute()`.
- Tool execution always enforces:
  - RBAC permission checks
  - AJV JSON Schema validation
  - autonomy/risk gating
  - audit logging
  - outbox event emission

## Registry Flow

`packages/tool-registry/src/registry.ts` performs this sequence:

1. Resolve active `ToolDefinition` by `orgId + name` (highest semver unless explicit version).
2. Resolve actor permissions via role bindings.
3. Validate tool payload with AJV.
4. Apply autonomy decision:
   - autonomous + `ALWAYS_ALLOWED` + low risk => execute
   - autonomous + `REQUIRES_APPROVAL` => create `ApprovalRequest(requiredApprovals=1)` and `ToolExecution(QUEUED_APPROVAL)`
   - autonomous + `REQUIRES_2ND_APPROVAL` => create `ApprovalRequest(requiredApprovals=2)` and `ToolExecution(QUEUED_APPROVAL)`
   - autonomous + `CRITICAL` or `NEVER_AUTONOMOUS` => block
5. Enforce tool controls:
   - `maxCallsPerRun`
   - `cooldownSeconds`
   - `requiresReason`
   - `requiresSnapshot` (writes `ContextSnapshot`)
6. Execute handler from `HANDLER_MAP`.
7. Persist `ToolExecution` status/output.
8. Write `AuditLog` and enqueue `EventOutbox` (`tool.executed`, `tool.blocked`, `approval.requested`, etc.).

## Approvals Lifecycle

- API endpoints:
  - `GET /api/approvals`
  - `POST /api/approvals/:id/approve`
  - `POST /api/approvals/:id/reject`
- Approval decisions are stored in `ApprovalDecision`.
- Once approvals meet `requiredApprovals` with no rejection:
  - `ApprovalRequest` becomes `APPROVED`
  - outbox event `approval.approved` is published
- Worker consumes `approval.approved` and calls `ToolRegistry.executeApprovedRequest(...)` to execute previously queued action.

## Master Agent Skill Graph

`apps/agent/src/skill-graph.ts` defines nodes and edges.

- Nodes contain:
  - `allowedTools[]`
  - `entryCriteria(state)`
  - `exitCriteria(state)`
- Edges define allowed transitions and state conditions.
- `assertToolAllowed` prevents tool calls outside the current node allowlist.
- `apps/agent/src/master-agent.ts` creates `AgentRun`, traverses the graph, and executes tools through `ToolRegistry`.
- If a tool returns `QUEUED_APPROVAL`, the run pauses with `PAUSED_FOR_APPROVALS`.

## Seeded Baseline

`packages/db/prisma/seed.ts` seeds:

- permissions + roles + role-permission links
- users including `master-agent@system.russellcomfort.local`
- default policy (`default-autonomy-policy`, v1)
- tool catalog (37 tools across LOW/MEDIUM/HIGH/CRITICAL)

