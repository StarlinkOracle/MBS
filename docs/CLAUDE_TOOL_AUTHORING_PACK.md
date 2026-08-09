# Claude Tool Authoring Pack (MBS/HAMB)

This pack is the fastest safe path for adding new governed tools in this repo.

Target repo root:
`<repo-root>`

## 1) Non-Negotiables

- All state-changing business operations go through `ToolRegistry.execute(...)`.
- Do not add direct Prisma writes in API routes for domain mutations.
- Every mutation must remain auditable via `ToolExecution`, `AuditLog`, and `EventOutbox`.
- Respect policy gates: kill switch, policy blocklists, rate limits, exposure, autonomy gating.
- Add permissions + tool definitions in seed for new capabilities.

## 2) Files You Always Touch

- Tool definitions/permissions/roles:
  - `<repo-root>/packages/db/prisma/seed.ts`
- Handler implementation:
  - `<repo-root>/packages/tool-registry/src/handlers.ts`
- API wiring:
  - `<repo-root>/apps/api/src/index.ts`
- Prisma schema/migrations (if new data):
  - `<repo-root>/packages/db/prisma/schema.prisma`
  - `<repo-root>/packages/db/prisma/migrations/*`
- Tests:
  - `<repo-root>/packages/tool-registry/tests/*.spec.ts`
  - `<repo-root>/apps/api/tests/*.spec.ts`

## 3) Seed Template (Permission + Tool Definition)

Add permission key in `permissions` array:

```ts
{ key: 'domain:feature:write', description: 'Write access for domain feature' },
```

Assign permission to role(s) in `roleDefinitions`.

Add tool in `toolCatalog`:

```ts
{
  name: 'domain.feature.action',
  description: 'Short description of governed action.',
  handlerKey: 'domain.feature.action',
  riskLevel: RiskLevel.MEDIUM,
  autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
  requiredPermissions: ['domain:feature:write'],
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      entityId: { type: 'string' },
      notes: { type: 'string' },
    },
    required: ['entityId'],
  },
  requiresReason: false,
  requiresSnapshot: false,
  cooldownSeconds: undefined,
  maxCallsPerRun: undefined,
}
```

Notes:
- `inputSchema` is AJV JSON Schema (not zod).
- Keep `additionalProperties: false` unless justified.
- Pick risk/autonomy intentionally because governance behavior depends on it.

## 4) Handler Template (ToolRegistry Handler)

In `buildCoreHandlers(...)` in
`<repo-root>/packages/tool-registry/src/handlers.ts`:

```ts
const domainFeatureActionSchema = z.object({
  entityId: z.string().trim().min(1),
  notes: z.string().trim().optional(),
});

const domainFeatureAction: ToolHandler = async ({ context, payload }) => {
  const input = domainFeatureActionSchema.parse(payload);

  // Optional: resolve actor for immutable audit metadata in domain row.
  const actorUserId = await resolveActorUserId(context.orgId, context.actorUserId);

  const updated = await prisma.$transaction(async (tx) => {
    const existing = await tx.someEntity.findFirst({
      where: { id: input.entityId, orgId: context.orgId },
    });
    if (!existing) {
      throw new Error('Entity not found');
    }

    const next = await tx.someEntity.update({
      where: { id: existing.id },
      data: {
        notes: input.notes ?? existing.notes,
      },
    });

    // Domain outbox event (registry will also emit generic tool.executed).
    await enqueueOutbox(tx, {
      orgId: context.orgId,
      eventType: 'domain.feature.updated',
      correlationId: context.correlationId,
      payload: toInputJson({
        entityId: next.id,
      }),
    });

    return next;
  });

  return jsonResult({
    entity: updated,
  });
};
```

Add handler key in returned map:

```ts
'domain.feature.action': domainFeatureAction,
```

## 5) API Route Template (Always Through Registry)

In `<repo-root>/apps/api/src/index.ts`:

```ts
app.post('/api/domain/feature/:id/action', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, [
      'domain:feature:write',
      '*',
    ]);

    const result = await registry.execute(
      'domain.feature.action',
      {
        entityId: req.params.id,
        notes: req.body?.notes,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-domain-feature-action',
        isAutonomous: false,
        reason:
          typeof req.body?.reason === 'string' && req.body.reason.trim().length > 0
            ? req.body.reason.trim()
            : 'Operator action',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 200
        : result.status === 'BLOCKED'
          ? 403
          : result.status === 'FAILED'
            ? 400
            : 202;

    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});
```

## 6) Prisma Migration Checklist (If New Table/Fields)

1. Edit schema in
   `<repo-root>/packages/db/prisma/schema.prisma`
2. Create migration:

```bash
cd "<repo-root>"
npm run db:migrate:dev -- --name your_change_name
```

3. Regenerate client (if needed):

```bash
npm run db:generate
```

4. Update seed if required and run:

```bash
npm run db:seed
```

## 7) Test Templates

### Tool-registry test skeleton

Create in `packages/tool-registry/tests/domain-feature.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ActorType, prisma } from '@rcs/db';
import { ToolRegistry } from '../src/registry.js';

describe('domain.feature.action', () => {
  it('executes with required permission and writes execution log', async () => {
    const registry = new ToolRegistry(prisma);

    // Arrange seeded org/user/entity as needed.
    const orgId = '...';
    const actorUserId = '...';

    const result = await registry.execute(
      'domain.feature.action',
      { entityId: '...' },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId,
        actorLabel: 'test',
        isAutonomous: false,
      },
    );

    expect(result.status).toBe('EXECUTED');
  });
});
```

### API test skeleton

Create in `apps/api/tests/domain-feature.spec.ts`:

```ts
import request from 'supertest';
import { app } from '../src/index.js';
import { describe, expect, it } from 'vitest';

describe('POST /api/domain/feature/:id/action', () => {
  it('returns execution response', async () => {
    const response = await request(app)
      .post('/api/domain/feature/some-id/action')
      .set('x-org-slug', 'russell-comfort')
      .set('x-actor-user-id', 'seeded-user-id')
      .send({ notes: 'hello' });

    expect([200, 202, 403, 400]).toContain(response.status);
  });
});
```

## 8) Policy / Explain Compatibility Checklist

For any new mutation tool, verify:
- `POST /api/tools/<toolName>/explain` returns deterministic stage/reason.
- Blocked/queued executions persist decision metadata on `ToolExecution.outputPayload`.
- If tool has financial payload amounts, verify exposure config mapping is deliberate.
- If tool should never run autonomously, use `NEVER_AUTONOMOUS`.

## 9) Known Patterns to Reuse

- Idempotent mobile actions:
  - API: `/api/mobile/sync/push` uses `ClientAction` dedupe and forwards `clientActionId` to registry.
- Media upload session model:
  - start -> upload/transform -> complete/fail.
- Scheduling lock:
  - `AppointmentReservation.updateMany(...reservedCount < capacity...)` atomic increment.
- Timeclock structured recoverable errors:
  - use `ToolExecutionError` with stable code + recoverable flag.

## 10) Commands Claude Should Run for Every Tool Slice

```bash
cd "<repo-root>"
npm run typecheck
npm run test -w @rcs/tool-registry
npm run test -w @rcs/api
```

If schema changed:

```bash
npm run db:migrate:dev -- --name your_change_name
npm run db:seed
```

## 11) Done Criteria for New Tool

- Permission seeded and role-mapped.
- ToolDefinition seeded (risk/autonomy/schema correct).
- Handler implemented and mapped.
- API endpoint uses `registry.execute(...)`.
- ToolExecution/AuditLog/Outbox emitted.
- Explain endpoint works for that tool.
- Tests added and passing.

