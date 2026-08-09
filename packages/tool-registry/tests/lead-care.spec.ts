import { randomUUID } from 'node:crypto';

import {
  ActorType,
  AutonomyLevel,
  Prisma,
  PrismaClient,
  RiskLevel,
  SafetyMode,
  TaskStatus,
} from '@prisma/client';
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';

import { ToolRegistry } from '../src/index.js';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const policyJson = {
  version: 1,
  autonomy: {
    enabled: true,
    defaultMode: 'SAFE',
    maxRiskLevelAutonomous: 'HIGH',
    toolBlocks: { deny: [], denyIfAutonomous: [], allowOnly: [] },
    timeWindows: [],
    rateLimits: {
      perRun: {
        maxToolCalls: 120,
        maxQueuedApprovals: 25,
        cooldownSecondsByRisk: { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 999999 },
      },
      perTool: [],
    },
  },
  financial: {
    currency: 'USD',
    dailyExposure: {
      enabled: false,
      scope: 'ORG',
      resetsAt: '00:00',
      timezone: 'America/Denver',
      limits: {},
      toolCostMap: [],
      onBreach: { mode: 'QUEUE_APPROVAL', requireApprovals: 2, note: 'n/a' },
    },
  },
  approvals: {
    defaults: {
      MEDIUM: { requiredApprovals: 1, expiresMinutes: 120 },
      HIGH: { requiredApprovals: 2, expiresMinutes: 240 },
      CRITICAL: { requiredApprovals: 2, expiresMinutes: 60 },
    },
    escalation: { ifPendingMinutes: 60, notifyRoles: ['owner'] },
  },
  killSwitch: {
    enabled: true,
    modes: {
      AUTONOMY_OFF: { blocksAutonomousExecution: true, stillAllowReadTools: true, stillAllowHumanExecution: true },
      FULL_STOP: { blocksAutonomousExecution: true, stillAllowReadTools: false, stillAllowHumanExecution: true },
    },
    currentMode: 'NORMAL',
  },
} as const satisfies Prisma.InputJsonValue;

describeIfDb('lead care tools', () => {
  const prisma = new PrismaClient();
  const registry = new ToolRegistry(prisma);

  let orgId = '';
  let userId = '';

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterEach(async () => {
    if (orgId) {
      await prisma.organization.delete({ where: { id: orgId } });
    }
    orgId = '';
    userId = '';
  });

  async function setupFixture() {
    const suffix = randomUUID().slice(0, 8);
    const org = await prisma.organization.create({
      data: {
        name: `Lead Care Test ${suffix}`,
        slug: `lead-care-test-${suffix}`,
      },
    });
    orgId = org.id;

    const user = await prisma.user.create({
      data: {
        orgId,
        email: `lead-care-${suffix}@example.com`,
        name: 'Lead Care User',
        actorType: ActorType.HUMAN,
      },
    });
    userId = user.id;

    await prisma.policy.create({
      data: {
        orgId,
        name: 'default-autonomy-policy',
        version: 1,
        isActive: true,
        policyJson,
        createdByUserId: userId,
      },
    });

    await prisma.orgSafetyState.create({
      data: {
        orgId,
        mode: SafetyMode.NORMAL,
        updatedByUserId: userId,
      },
    });

    await prisma.leadSlaPolicy.create({
      data: {
        orgId,
        hoursByStage: {
          NEW: 1,
          CONTACTED: 2,
          QUALIFIED: 6,
          APPOINTMENT_SET: 24,
          ESTIMATE_SENT: 24,
          WON: 0,
          LOST: 0,
          NURTURE: 168,
        },
        dueSoonMinutes: 60,
      },
    });

    await prisma.toolDefinition.createMany({
      data: [
        {
          orgId,
          name: 'lead.profile.upsert',
          version: '1.0.0',
          description: 'Upsert lead profile',
          handlerKey: 'lead.profile.upsert',
          active: true,
          riskLevel: RiskLevel.LOW,
          autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
          requiredPermissions: [],
          inputSchema: { type: 'object', additionalProperties: true },
          endpointAllowsHumanOverride: false,
          requiresReason: false,
          requiresSnapshot: false,
        },
        {
          orgId,
          name: 'lead.stage.update',
          version: '1.0.0',
          description: 'Update lead stage',
          handlerKey: 'lead.stage.update',
          active: true,
          riskLevel: RiskLevel.MEDIUM,
          autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
          requiredPermissions: [],
          inputSchema: { type: 'object', additionalProperties: true },
          endpointAllowsHumanOverride: false,
          requiresReason: false,
          requiresSnapshot: false,
        },
        {
          orgId,
          name: 'lead.touch.record',
          version: '1.0.0',
          description: 'Record lead touch',
          handlerKey: 'lead.touch.record',
          active: true,
          riskLevel: RiskLevel.LOW,
          autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
          requiredPermissions: [],
          inputSchema: { type: 'object', additionalProperties: true },
          endpointAllowsHumanOverride: false,
          requiresReason: false,
          requiresSnapshot: false,
        },
        {
          orgId,
          name: 'lead.sla.evaluate',
          version: '1.0.0',
          description: 'Evaluate lead SLA',
          handlerKey: 'lead.sla.evaluate',
          active: true,
          riskLevel: RiskLevel.LOW,
          autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
          requiredPermissions: [],
          inputSchema: { type: 'object', additionalProperties: true },
          endpointAllowsHumanOverride: false,
          requiresReason: false,
          requiresSnapshot: false,
        },
      ],
    });
  }

  function getExecutedOutput(result: unknown): Record<string, unknown> {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error('Expected tool execution result object');
    }
    const execution = result as { status?: string; output?: unknown };
    if (execution.status !== 'EXECUTED') {
      throw new Error(`Expected EXECUTED result, received ${String(execution.status)}`);
    }
    if (!execution.output || typeof execution.output !== 'object' || Array.isArray(execution.output)) {
      return {};
    }
    return execution.output as Record<string, unknown>;
  }

  it('creates timeline + next action and keeps stage updates idempotent with requestId', async () => {
    await setupFixture();

    const createResult = await registry.execute(
      'lead.profile.upsert',
      {
        leadType: 'RESIDENTIAL_SINGLE',
        displayName: 'Lead Care Fixture',
        primaryContact: {
          email: 'leadcare-fixture@example.com',
          phone: '+13035550100',
        },
        requestId: 'lead-profile-1',
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        isAutonomous: false,
      },
    );

    expect(createResult.status).toBe('EXECUTED');
    const createOutput = getExecutedOutput(createResult);
    const leadId = createOutput.leadId as string;
    expect(leadId).toBeTruthy();
    expect(createOutput.nextActionTaskId).toBeTruthy();

    const stageRequestId = 'lead-stage-qualified-1';
    const firstStage = await registry.execute(
      'lead.stage.update',
      {
        leadId,
        toStage: 'QUALIFIED',
        reason: 'Initial qualification call',
        requestId: stageRequestId,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        isAutonomous: false,
      },
    );
    expect(firstStage.status).toBe('EXECUTED');

    const secondStage = await registry.execute(
      'lead.stage.update',
      {
        leadId,
        toStage: 'QUALIFIED',
        reason: 'Retry same request',
        requestId: stageRequestId,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        isAutonomous: false,
      },
    );
    expect(secondStage.status).toBe('EXECUTED');

    const [stageTimelineEvents, outboxEvents] = await Promise.all([
      prisma.timelineEvent.findMany({
        where: {
          orgId,
          leadId,
          type: 'LEAD_STAGE_CHANGED',
          requestId: stageRequestId,
        },
      }),
      prisma.eventOutbox.findMany({
        where: {
          orgId,
          eventType: 'lead.stage.changed',
        },
      }),
    ]);

    expect(stageTimelineEvents).toHaveLength(1);
    expect(outboxEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('touch updates SLA timestamps and evaluates deterministic SLA status', async () => {
    await setupFixture();

    const createResult = await registry.execute(
      'lead.profile.upsert',
      {
        leadType: 'RESIDENTIAL_SINGLE',
        displayName: 'SLA Fixture',
        primaryContact: {
          email: 'sla-fixture@example.com',
        },
        requestId: 'lead-profile-sla',
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        isAutonomous: false,
      },
    );
    expect(createResult.status).toBe('EXECUTED');
    const leadId = getExecutedOutput(createResult).leadId as string;

    const touchResult = await registry.execute(
      'lead.touch.record',
      {
        leadId,
        channel: 'CALL',
        direction: 'OUTBOUND',
        summary: 'Reached homeowner and qualified next steps.',
        outcome: 'CONNECTED',
        requestId: 'lead-touch-1',
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        isAutonomous: false,
      },
    );
    expect(touchResult.status).toBe('EXECUTED');

    const lead = await prisma.lead.findUnique({ where: { id: leadId } });
    expect(lead?.lastTouchAt).toBeTruthy();
    expect(lead?.nextTouchDueAt).toBeTruthy();

    const slaResult = await registry.execute(
      'lead.sla.evaluate',
      { leadId },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        isAutonomous: false,
      },
    );
    expect(slaResult.status).toBe('EXECUTED');
    const slaOutput = getExecutedOutput(slaResult);
    expect(['OK', 'DUE_SOON', 'OVERDUE']).toContain(slaOutput.slaStatus);
    expect(typeof slaOutput.minutesUntilDue).toBe('number');
  });

  it('terminal stages close outstanding next-action tasks', async () => {
    await setupFixture();

    const createResult = await registry.execute(
      'lead.profile.upsert',
      {
        leadType: 'RESIDENTIAL_SINGLE',
        displayName: 'Terminal Stage Fixture',
        primaryContact: {
          email: 'terminal-fixture@example.com',
        },
        requestId: 'lead-profile-terminal',
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        isAutonomous: false,
      },
    );
    expect(createResult.status).toBe('EXECUTED');
    const leadId = getExecutedOutput(createResult).leadId as string;

    const beforeOpenTasks = await prisma.task.count({
      where: {
        orgId,
        leadId,
        isNextAction: true,
        status: {
          in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS],
        },
      },
    });
    expect(beforeOpenTasks).toBeGreaterThan(0);

    const stageResult = await registry.execute(
      'lead.stage.update',
      {
        leadId,
        toStage: 'WON',
        reason: 'Customer accepted proposal',
        requestId: 'lead-stage-won',
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        isAutonomous: false,
      },
    );
    expect(stageResult.status).toBe('EXECUTED');

    const afterOpenTasks = await prisma.task.count({
      where: {
        orgId,
        leadId,
        isNextAction: true,
        status: {
          in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS],
        },
      },
    });
    expect(afterOpenTasks).toBe(0);
  });
});
