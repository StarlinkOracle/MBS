# Install Pricing Engine Runbook

This runbook covers local execution and verification for the finalized install pricing engine.

## Scope

Applies to install quote pricing (`crm.quote.generateInstallOptions`, `crm.quote.applyDiscount`, `system.pricing.overrideBlock`) and assessment pricing inputs (`crm.assessment.updateInstallPricingInputs`).

## Pricing Formula (Locked)

Order of operations:

1. `equipmentAdjusted = round(equipmentCostCents * 1.20)`
2. `materialsAdjusted = round(materialsCostCents * 1.20)`
3. `labor = baseLaborCostCents + manualLaborAdjustmentCents` (reason required if adjustment != 0)
4. `adjustedCost = equipmentAdjusted + materialsAdjusted + labor + permitCostCents`
5. Add profit floor:
   - `COMBO = 350000`
   - `FURNACE_ONLY` / `AC_ONLY = 200000`
6. Add access add-on before sales cushion:
   - `ATTIC` / `CONFINED_CRAWLSPACE = +50000`
7. `priceBeforeDiscount = round(basePrice * 1.05)`
8. Discount amount:
   - `discountPctAmount = round(priceBeforeDiscount * discountPctBps / 10000)`
   - `discountTotal = discountPctAmount + discountCents`
9. `finalSellPrice = max(0, priceBeforeDiscount - discountTotal)`

Guardrails (computed from raw cost, not cushioned cost):

- `effectiveMarginBps = ((finalSellPrice - rawCostTotal) / finalSellPrice) * 10000`
- `< 18%` => `WARNING`
- `< 15%` => `REQUIRE_APPROVAL`
- `< 12%` or final sell price `0` => `BLOCK`

## Discount Limits

- SALES: up to `max(5%, $250)` without approval
- MANAGER: up to `max(15%, $1000)` without approval
- OWNER: unlimited (reason required)

If limit exceeded without `pricing:discount:override_limits`, discount queues approval.

## Local Commands

From repo root:

```bash
npm install
npm run db:migrate:dev
npm run db:seed
npm run test -w @rcs/shared
npm run test -w @rcs/tool-registry
npm run typecheck
npm run build -w @rcs/web
npm run typecheck -w @rcs/api
```

If running Postgres via Docker:

```bash
docker compose up -d
```

## Manual Verification (Sample Numbers)

Use these sample inputs for one quote option:

- equipment cost: `$5,000` (`500000`)
- materials cost: `$1,000` (`100000`)
- base labor: `$2,000` (`200000`)
- manual labor adjustment: `$0`
- permit: `$300` (`30000`)
- install type: `COMBO`
- access: `STANDARD`

Expected:

- equipment adjusted = `$6,000`
- materials adjusted = `$1,200`
- adjusted cost = `$9,500`
- + floor (`$3,500`) => base price `$13,000`
- + sales cushion 5% => `priceBeforeDiscount = $13,650`

Checks:

1. Save assessment pricing inputs via `/api/assessments/:id/install-pricing-inputs`.
2. Generate options via `/api/quotes/install/generate`.
3. Apply `$500` discount as sales => should execute immediately.
4. Apply `$900` discount as sales => should queue approval.
5. Apply `$5,000` discount as sales => should block (`BLOCK`).
6. Use owner override endpoint `/api/quotes/options/:id/override-block` with reason => executes and emits `pricing.block.overridden` event.

## Audit Expectations

For every action above, verify:

- `ToolExecution` row exists with status (`EXECUTED`, `QUEUED_APPROVAL`, `BLOCKED`).
- `AuditLog` contains action trail (`tool.executed`, `approval.requested`, `tool.blocked`, `pricing.block.overridden`).
- `EventOutbox` contains corresponding events.
