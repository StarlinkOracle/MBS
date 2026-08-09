# Service Pricing v1 Runbook

This runbook covers the SERVICE quote workflow introduced in v1:

- Flat-rate pricebook items
- Labor hours rounded to nearest 0.5 hour
- Timing-aware labor rates
- Membership-aware after-hours labor rate
- Dynamic diagnostic credit line
- Discount approvals and floor guardrails
- Owner block override

## 1) Local setup

From `<repo-root>`:

```bash
docker compose up -d
npm install
npm run db:generate
```

Apply migrations and seed:

```bash
docker compose exec api npx prisma migrate dev --schema=packages/db/prisma/schema.prisma --name service_pricing_v1
docker compose exec api npm run seed -w @rcs/db
```

Start apps:

```bash
npm run dev
```

## 2) Service pricing behavior (v1)

- Labor rounding: `round(hours * 2) / 2`
- Labor rates:
  - `NORMAL`: `$100/hr`
  - `AFTER_HOURS`: `$200/hr`
  - `AFTER_HOURS + member`: `$150/hr`
- After-hours affects labor only.
- Diagnostic credit is an actual negative line item (`Diagnostic Credit`) and is auto-managed.
- Discount logic uses percent + fixed-dollar **SUM**.
- Floors (after discount):
  - Default floor: `$99`
  - Maintenance-only floor: `$149`
- Floor breach => `BLOCK` unless owner override tool is used.

## 3) UI paths

- Service quote builder: `/quotes/service/new`
- Service quote detail: `/quotes/service/:id`
- Admin pricebook: `/admin/service-pricing`
- Admin bundles: `/admin/service-bundles`

## 4) Manual verification

1. Open `/quotes/service/new` and create a quote from a seeded bundle.
2. Confirm line items include diagnostic fee and repair line.
3. Confirm `Diagnostic Credit` appears automatically when repair subtotal meets fee.
4. Remove repair line and confirm credit disappears.
5. Re-add repair line and confirm credit returns.
6. Set timing to `AFTER_HOURS` with a member customer and confirm labor rate label shows `$150/hr`.
7. Apply a small discount (within role limit) and confirm immediate execution.
8. Apply a larger discount (sales role) and confirm it queues approval.
9. Apply a discount that drops total below floor and confirm `BLOCK`.
10. As owner, run override and confirm quote remains auditable with `pricing.block.overridden` event.

## 5) API endpoints used by UI

- `POST /api/quotes/service/bundle`
- `POST /api/quotes/service/:id/line-items`
- `DELETE /api/quotes/service/line-items/:lineItemId`
- `POST /api/quotes/service/:id/labor-hours`
- `POST /api/quotes/service/:id/timing`
- `POST /api/quotes/service/:id/discount`
- `POST /api/quotes/service/:id/override-block`
- `GET /api/quotes/service/:id`
- `GET /api/service/bundles`
- `GET /api/pricebook/items`
- `GET /api/admin/pricebook/categories`
- `GET /api/admin/pricebook/items`
- `GET /api/admin/bundles`
- `POST /api/admin/pricebook/categories`
- `POST /api/admin/pricebook/items`
- `POST /api/admin/bundles`

All state-changing operations route through `ToolRegistry.execute()` and remain auditable (`ToolExecution`, `AuditLog`, `EventOutbox`).
