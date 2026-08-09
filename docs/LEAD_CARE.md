# Lead Care

Lead Care is the governed lead-pipeline discipline layer in MBS. It is implemented with ToolRegistry tools only for all mutations.

## Pipeline Taxonomy

### Lead types
- `RESIDENTIAL_SINGLE`
- `RESIDENTIAL_MULTI_PROPERTY`
- `COMMERCIAL`

### Stages
- `NEW`
- `CONTACTED`
- `QUALIFIED`
- `APPOINTMENT_SET`
- `ESTIMATE_SENT`
- `WON`
- `LOST`
- `NURTURE`

### Lost outcomes
- `NO_CONTACT`
- `NO_SHOW`
- `PRICE`
- `TIMING`
- `COMPETITOR`
- `NOT_A_FIT`
- `DUPLICATE`
- `OTHER`

## SLA Rules

- SLA is based on `nextTouchDueAt` and org policy (`LeadSlaPolicy`).
- `lead.touch.record` sets:
  - `lastTouchAt = now`
  - `nextTouchDueAt = now + SLA(stage)`
- `lead.stage.update` sets:
  - `stageEnteredAt = now`
  - `nextTouchDueAt = now + SLA(toStage)` for non-terminal stages
- Non-terminal stages (`!= WON/LOST`) must have an open next-action task.
- Terminal stages (`WON`/`LOST`) close open next-action tasks.

## Tool Contracts

Mutating tools:
- `lead.profile.upsert`
- `lead.site.upsert`
- `lead.stage.update`
- `lead.owner.assign`
- `lead.touch.record`
- `lead.nextAction.set`
- `lead.nurture.enroll`

Read tool:
- `lead.sla.evaluate`

Each mutation writes:
- `ToolExecution`
- `AuditLog`
- `TimelineEvent`
- `EventOutbox`

## Outbox Events

- `lead.profile.updated`
- `lead.site.updated`
- `lead.stage.changed`
- `lead.owner.assigned`
- `lead.touched`
- `lead.next_action.set`
- `lead.nurture.enrolled`
- Worker-generated detection events:
  - `lead.sla.warning.detected`
  - `lead.sla.breach.detected`

## API Endpoints

Reads:
- `GET /api/leads`
- `GET /api/leads/pipeline`
- `GET /api/users/lead-owners`
- `GET /api/leads/:id`
- `GET /api/leads/:id/sla`
- `GET /api/leads/:id/sites`
- `GET /api/leads/:id/next-action`

Mutations (ToolRegistry-backed):
- `POST /api/leads/profile/upsert`
- `POST /api/leads/:id/sites`
- `PATCH /api/leads/:id/stage`
- `PATCH /api/leads/:id/owner`
- `POST /api/leads/:id/touch`
- `POST /api/leads/:id/next-action`
- `POST /api/leads/:id/nurture`

## UI

- `/pipeline`: stage board with filters by owner, lead type, and SLA status.
- `/leads/:id`: profile, SLA badge, owner assignment, next action, sites + site upsert, stage history, attribution, timeline.

## Worker Automation (Phase 2)

Worker performs periodic SLA sweeps:
- evaluates active leads via `lead.sla.evaluate`
- emits warning/breach outbox events
- creates fallback internal next-action tasks (via `lead.nextAction.set`) only when no open next-action exists
- no outbound customer sends by default
