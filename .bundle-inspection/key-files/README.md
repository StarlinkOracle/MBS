# MBS Monorepo (Master Business Suite)

Governed HVAC operating system for Russell Comfort Solutions.  
This repository contains the internal CRM/control-room platform, agent runtime, worker automation, pricing engines, dispatch scheduling, media pipeline, mobile offline sync backend, and supporting packages.

## What This Repo Contains

### Applications

| Path | Package | Purpose |
| --- | --- | --- |
| `apps/api` | `@rcs/api` | Main API surface (REST, governance endpoints, intake, approvals, playbooks, scheduling, pricing, media, mobile sync). |
| `apps/web` | `@rcs/web` | Internal web app (control room, sales workspace, dispatch, governance views). |
| `apps/worker` | `@rcs/worker` | Background jobs (outbox/event processing, ingestion pipelines, maintenance tasks). |
| `apps/agent` | `@rcs/agent` | Master agent runtime and skill-graph execution loop. |
| `apps/mobile_flutter` | N/A (Flutter) | Offline-first mobile client scaffold for tech/dispatch flows. |

### Shared Packages

| Path | Package | Purpose |
| --- | --- | --- |
| `packages/db` | `@rcs/db` | Prisma schema, migrations, and seed data. |
| `packages/tool-registry` | `@rcs/tool-registry` | Governance execution engine (RBAC, schema validation, policy, approvals, audit, outbox). |
| `packages/shared` | `@rcs/shared` | Shared types/utilities, pricing helpers, common logic. |
| `packages/auth` | `@rcs/auth` | Auth/session/JWT support. |
| `packages/event-bus` | `@rcs/event-bus` | Event/outbox abstractions. |
| `packages/storage` | `@rcs/storage` | S3-compatible storage adapter (MinIO supported). |
| `packages/agent-graph` | `@rcs/agent-graph` | Skill graph definitions and reachability helpers. |
| `packages/agent-playbooks` | `@rcs/agent-playbooks` | Deterministic playbook loader/validator/executor runtime. |
| `packages/connectors` | `@rcs/connectors` | Connector interfaces/adapters (e.g., comms sync). |
| `packages/geocode` | `@rcs/geocode` | Geocoding abstraction helpers. |
| `packages/equipment-decoder` | `@rcs/equipment-decoder` | Equipment model/spec normalization/decoder logic. |

### Additional Folder

| Path | Purpose |
| --- | --- |
| `website` | Public marketing website codebase (separate nested git repo) forwarding intake to MBS ingestion endpoints. |

## Core System Principles

- All business mutations go through `ToolRegistry.execute(...)`.
- Governance is enforced centrally: RBAC + JSON schema validation + policy + kill switch + approvals + audit + outbox.
- Mobile write flows are idempotent (`clientActionId`) and sync-cursor based.
- Determinism over autonomy: playbooks and agent flows fail closed on governance blockers.

## Local Development

### 1) Prerequisites

- Node.js 20+
- Docker Desktop

### 2) Install

```bash
npm install
cp .env.example .env
```

### 3) Start infra + apps (dockerized)

```bash
docker compose up -d --build
```

Services:
- API: `http://localhost:3001`
- Web: `http://localhost:5173`
- Postgres: `localhost:5432`
- MinIO API: `http://localhost:9000`
- MinIO Console: `http://localhost:9001`

### 4) Database lifecycle

```bash
npm run db:generate
npm run db:migrate:dev
npm run db:seed
```

or deployment mode:

```bash
npm run db:migrate:deploy
```

### 5) Run app processes locally (non-docker)

```bash
npm run dev
```

This runs API + web + worker + agent concurrently via workspaces.

## Build, Test, Typecheck

```bash
npm run build
npm run typecheck
npm run test
```

Targeted examples:

```bash
npm run test -w @rcs/api
npm run test -w @rcs/tool-registry
npm run smoke -w @rcs/web
```

## Operations Scripts

The root `package.json` includes production-hardening scripts for health, remediation, backups, and smoke/load checks:

- `npm run ops:health`
- `npm run ops:health:json`
- `npm run ops:health:alert`
- `npm run ops:health:remediate:dry-run`
- `npm run ops:health:remediate`
- `npm run ops:backup:verify`
- `npm run ops:load:smoke`
- `npm run ops:disk:status`
- `npm run ops:disk:recover`

## Environment Variables

Use `.env.example` as the source of truth. Major groups:

- Database/auth: `DATABASE_URL`, `JWT_SECRET`
- Ingestion security: `MBS_INGEST_TOKENS`, `MBS_IP_HASH_SALT`, `CALL_WEBHOOK_SECRET`
- Mobile sync + auth limits: `MOBILE_*`
- Playbook runtime guardrails: `AGENT_PLAYBOOK_*`
- Health/alerting: `HEALTH_*`, `ERROR_TELEMETRY_WEBHOOK_URL`
- S3/MinIO storage: `S3_*`, `MINIO_*`
- Media lifecycle: `MEDIA_*`
- Backup automation: `BACKUP_*`

## API Surface (High-Level)

The API currently includes:

- Identity/auth (`/api/me`, mobile PIN auth)
- Tool execution and explain endpoints
- Approvals, execution logs, and audit-adjacent APIs
- Lead care pipeline and sales intake
- Service/install pricing flows
- Quote lifecycle + public quote accept/book
- Scheduling/dispatch day view
- Media upload/list/view/public toggle/purge
- Agent runs + skill graph + playbook execution
- Governance and system health endpoints
- Accounting/receipt/referral/review foundation APIs
- Jobber CSV import APIs
- SSE stream feed (`/api/stream`)

See `docs/INTEGRATIONS.md` for integration contracts and endpoint details.

## Documentation Index

- `docs/GOVERNANCE.md`
- `docs/AUTONOMY.md`
- `docs/LEAD_CARE.md`
- `docs/MOBILE_OFFLINE_V1.md`
- `docs/PILOT_DISPATCH_MEDIA.md`
- `docs/AGENT_PLAYBOOKS.md`
- `docs/LEGAL_PACKS_IMPORT.md`
- `docs/OPERATIONS_HARDENING.md`
- `docs/INTEGRATIONS.md`

## Integration and External Repos

This monorepo integrates with external artifacts and pack repos without runtime test-network dependency:

- Agent orchestration packs consumed via vendored fixtures and manifest verification.
- Legal artifact packs imported via deterministic, idempotent importer tooling.
- Public website forwards intake to governed MBS endpoints.

Integration details and governance constraints are documented in:
- `docs/INTEGRATIONS.md`

## Safety Notes

- Never bypass `ToolRegistry.execute` for business mutations.
- Never commit secrets. Keep `.env` local and out of git.
- Keep infra and governance checks green before production rollout.

## Security

- JWT authentication with 24h expiration
- bcrypt password hashing (12 rounds)
- Role-based access control (Admin, Manager, Technician, Office)
- Helmet security headers
- Rate limiting (1000 req/15 min)
- Input validation via Zod on all endpoints
- Audit logging on all mutations
- Soft-delete pattern preserves data integrity
