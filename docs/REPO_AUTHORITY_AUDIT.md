# Repo Authority Audit (Conceptual)

Scope requested:
- MBS-Operators
- MBS-Constitution
- MBS-Master-Orchestrator
- Artifacts-Legal-Packs
- russell-comfort-solutions (website)

Note: those external repos are not mounted in this workspace as standalone folders. This audit is conceptual and based on the current MBS monorepo contracts and integration points.

## 1) Architecture Assessment

- Current monorepo structure (`apps/api`, `apps/agent`, `apps/worker`, `apps/web`, `packages/*`) aligns with governed execution through ToolRegistry.
- Governance primitives are present and active: policy engine, kill switch, approvals, audit log, outbox.
- Playbook runtime support exists and is deterministic-oriented.
- Legal pack ingestion path exists and is fixture-testable.
- Mobile sync/idempotency model exists and is aligned with deterministic operations.

Authority model alignment (conceptual):
- Constitution as sovereign: partially aligned via policy/killswitch enforcement, but not yet visibly wired as explicit "gatekeeper before all side effects" artifact in every orchestration path.
- Master-Orchestrator as brain: partially aligned; skill graph and playbook execution exist, but cross-repo contract boundaries are not yet visibly formalized in this workspace.
- Operators as domain executors: conceptually aligned; API/worker tool-execution pattern supports this model.
- OpenClaw runtime-only role: not fully verifiable from this workspace alone.

## 2) Integration Gaps

1. Constitution runtime contract gap
- Need explicit, versioned Constitution check binding in all orchestrated side effects (manifest embed + fail-closed evidence).

2. Cross-repo contract pinning gap
- Need deterministic version pinning across Master/Operators/Constitution pack releases (manifest references and compatibility matrix).

3. OpenClaw pipeline operational gap
- Need enforced pipeline schedule + kill switch propagation + artifact/log directories with retention policy.

4. Website intake replacement completion gap
- Ingestion and idempotent intake are present, but full production observability/alerts and flow-state auto-updates need final hardening.

5. Policy drift protection gap
- Need automated drift detection between configured governance policy and expected Constitution version.

6. Compliance automation gap
- GBP and schema compliance checks should be run by deterministic jobs with approval-gated publication actions.

## 3) Risk Areas

1. Governance bypass risk in future integrations
- Any new side-effect path not routed through ToolRegistry would violate core controls.

2. Capacity overflow risk
- Dispatch/scheduling can be overwhelmed if throttle policies are not consistently enforced in all booking surfaces.

3. Marketing spend creep risk
- Geo expansion and budget pacing logic need hard guardrails and review gates.

4. Seasonal mismatch risk
- Campaign/operator actions need season gates to avoid AC-in-winter or furnace-in-peak-cooling misfires.

5. Operational observability risk
- Without complete traces and daily health checks, silent failures in worker/agent loops can degrade lead response quality.

## 4) Governance Gaps

- Explicit Constitution version stamping in all orchestration manifests is not yet verified end-to-end here.
- Fail-closed behavior on Constitution check failure is not yet demonstrated as a universal invariant in this workspace.
- Approval policy templates for outbound comms/financial actions should be centrally versioned and validated per release.
- Change-management workflow for self-evolution proposals needs strict two-phase separation (propose vs apply) with mandatory approval artifacts.

## 5) Production Hardening Checklist

1. Constitution gate
- Add mandatory pre-side-effect gate check wrapper for orchestrator/operator executions.
- Persist constitutionVersion on manifests and execution records.
- Enforce fail-closed on check failure.

2. Cross-repo release contracts
- Define compatibility matrix: `constitutionVersion`, `masterPackVersion`, `operatorPackVersion`, `legalPackVersion`.
- Block startup if versions violate declared compatibility.

3. Intake reliability
- Complete queue health alerts, dead-letter handling, replay tooling, and dashboard indicators.

4. Scheduling/capacity protection
- Enforce capacity + throttle invariants in every booking path.
- Add daily reconciliation job for reservations vs appointments.

5. Compliance controls
- Deterministic schema/GBP rule checks before publish actions.
- Approval-required publication tools only.

6. Backup/restore
- Nightly backup automation with periodic restore validation drills.

7. Observability
- CorrelationId-first logs across API/worker/agent.
- Daily SLO report for intake latency, SLA breaches, approval backlog, booking failures.

## 6) 30-Day Execution Plan (Sequence)

1. Week 1: Governance closure
- Constitution gatekeeper enforcement + fail-closed semantics
- Version stamping and compatibility check framework

2. Week 2: Intake + dispatch reliability
- Intake alerting/replay hardening
- Scheduling reconciliation + capacity-throttle invariant tests

3. Week 3: Compliance automation
- GBP/schema validation job + approval-gated publication pipeline

4. Week 4: Ops hardening
- Backup/restore validation automation
- SLO dashboard and daily health summary artifact

## 7) Repo Role Clarification (Final)

- `MBS-Constitution`: sovereign policy/rules source, versioned and mandatory at runtime
- `MBS-Master-Orchestrator`: decision planner and orchestration contracts, Constitution-bound
- `MBS-Operators`: deterministic domain operators called by Master
- `Artifacts-Legal-Packs`: schema contracts + release artifacts only (no runtime side effects)
- `russell-comfort-solutions` website: public intake source only, forwards governed requests inward
- OpenClaw: runtime executor only; never policy source

## 8) Open Questions

1. Which repo owns the canonical compatibility matrix artifact?
2. What is the authoritative Constitution version pin strategy (tag-only vs tag+digest)?
3. Should Master reject startup when Operators are ahead/behind, or degrade to read-only mode?
4. Where should the weekly compliance evidence bundle be stored (repo artifact vs object store)?
5. What is the required backup restore RTO/RPO target for the Mac mini production node?
