# Phase 2 Geo Intelligence + Marketing Ops Runbook

This runbook covers the v1 operating model for:
- Receipt OCR extraction into governed expense drafts
- Mandatory job geotagging
- Daily geo analytics rollups
- Review request automation foundation
- Referral tracking foundation

All state changes are enforced through `ToolRegistry.execute()` and are auditable through `ToolExecution`, `AuditLog`, and `EventOutbox`.

## Environment Variables

### OCR
- `OPENAI_API_KEY`: Enables OpenAI Vision provider for receipt extraction.
- `GOOGLE_APPLICATION_CREDENTIALS`: Enables Google Vision provider.
- If neither OCR provider is configured, OCR jobs mark result as `FAILED` with provider-not-configured message.

### Geocoding
- `MAPBOX_TOKEN`: Enables Mapbox geocoding provider.
- `GOOGLE_MAPS_KEY`: Enables Google Geocoding provider.
- If no geocoding provider is configured, fallback mode still writes `JobGeo` with normalized address/city/state/zip and `lat/lng = null`.

### Storage
- `S3_ENDPOINT`
- `S3_ACCESS_KEY`
- `S3_SECRET_KEY`
- `S3_BUCKET`
- `S3_REGION`

### Worker Scheduling
- `WORKER_POLL_MS` (default `2000`)
- `GEO_ROLLUP_TIMEZONE` (default `America/Denver`)
- `GEO_ROLLUP_HOUR` (default `3`)

## Receipt OCR Flow

1. Receipt upload API stores file in object storage (MinIO/S3).
2. `accounting.receipt.upload` creates `Attachment`, `Receipt`, and draft `Expense`.
3. Outbox event `receipt.uploaded` is consumed by worker OCR pipeline.
4. Worker runs OCR provider and writes `ReceiptOcrResult`.
5. High-confidence fields are applied via `accounting.receipt.applyOcr`.
6. Low-confidence outcomes set OCR metadata and keep manual review required.

Important:
- OCR never auto-approves or auto-posts.
- OCR only populates draft fields and confidence metadata.

## Mandatory Job Geotagging

Geotag enforcement is attached to governed job tools:
- `jobs.job.create`
- `jobs.schedule.change`
- `jobs.dispatch.assign`
- `jobs.geo.ensure`

Each execution ensures a `JobGeo` row exists and emits `job.geotagged`.

### Backfill Existing Jobs

Enqueue:
- Outbox event `geo.backfill.jobs`

Worker behavior:
- Finds jobs missing `JobGeo`
- Calls `jobs.geo.ensure` through Tool Registry as SYSTEM actor

## Geo Rollup Daily Job

Worker enqueues `geo.rollup.daily` for each org once per day after configured schedule hour.

Rollup source inputs:
- Leads by date + geo
- Jobs by date + geo
- Invoices for revenue
- Marketing spend (`MarketingMetricDaily`) if table exists
- Reviews + referrals counts

Materialized output:
- `GeoRollupDaily` rows keyed by org/date/zip/geohashPrefix

API endpoints:
- `GET /api/geo/summary?range=7d`
- `GET /api/geo/heatmap?range=30d&precision=zip|geohash5`
- `GET /api/geo/areas/top?metric=revenue|leads|closeRate&range=30d`

## Review Request Automation Foundation

Tools:
- `marketing.review.request.draft`
- `marketing.review.request.auto`
- `marketing.review.request.send` (HIGH, approval-governed)

Automation trigger:
- Worker consumes `job.completed`
- Drafts request via `marketing.review.request.auto`
- Optional send request can be attempted via `marketing.review.request.send`

API:
- `GET /api/marketing/reviews/requests`
- `POST /api/marketing/reviews/requests/:id/send`

Note:
- Send actions are still subject to active policy gates (kill switch, autonomy caps, time windows, approvals).

## Referral Foundation

Seeded program:
- `Standard Referral` (active, `$25` credit = `2500` cents)

Tools:
- `marketing.referral.invite`
- `marketing.referral.convert`
- `marketing.referral.reward.issue` (HIGH, approval-governed)

API:
- `GET /api/marketing/referrals/events`
- `POST /api/marketing/referrals/invite`

Lead-detail UI includes a minimal **Send referral invite** action that calls the API endpoint.

## Governance + Approvals Interaction

All phase-2 writes flow through Tool Registry and therefore inherit:
- RBAC checks
- JSON Schema input validation
- Kill switch enforcement
- Policy blocklists + time window overlays
- Rate limits/per-run limits
- Financial exposure limits where applicable
- Autonomy/approval gating
- Tool execution logging + audit logging + outbox emission

Operationally, if an action is blocked or queued:
- Inspect `ToolExecution` and its decision metadata
- Review pending approvals in `/api/approvals`
- Confirm policy and kill switch state before retrying
