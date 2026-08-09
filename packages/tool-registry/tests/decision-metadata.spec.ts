import { randomUUID } from 'node:crypto';

import {
  ActorType,
  AutonomyLevel,
  Prisma,
  PrismaClient,
  RiskLevel,
  SafetyMode,
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

type DecisionPayload = {
  decision?: {
    decision?: string;
    stage?: string;
    reason?: string;
    details?: {
      policyPath?: string;
      limits?: {
        limit?: number;
        projected?: number;
      };
    };
  };
};

function basePolicyJson(): any {
  return {
    version: 1,
    autonomy: {
      enabled: true,
      defaultMode: 'SAFE',
      maxRiskLevelAutonomous: 'HIGH',
      toolBlocks: {
        deny: [],
        denyIfAutonomous: [],
        allowOnly: [],
      },
      timeWindows: [],
      rateLimits: {
        perRun: {
          maxToolCalls: 120,
          maxQueuedApprovals: 25,
          cooldownSecondsByRisk: {
            LOW: 0,
            MEDIUM: 5,
            HIGH: 30,
            CRITICAL: 999999,
          },
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
        onBreach: {
          mode: 'QUEUE_APPROVAL',
          requireApprovals: 2,
          note: 'Daily financial exposure exceeded',
        },
      },
    },
    approvals: {
      defaults: {
        MEDIUM: { requiredApprovals: 1, expiresMinutes: 120 },
        HIGH: { requiredApprovals: 2, expiresMinutes: 240 },
        CRITICAL: { requiredApprovals: 2, expiresMinutes: 60 },
      },
      escalation: {
        ifPendingMinutes: 60,
        notifyRoles: ['owner', 'dispatcher_manager'],
      },
    },
    killSwitch: {
      enabled: true,
      modes: {
        AUTONOMY_OFF: {
          blocksAutonomousExecution: true,
          stillAllowReadTools: true,
          stillAllowHumanExecution: true,
        },
        FULL_STOP: {
          blocksAutonomousExecution: true,
          stillAllowReadTools: false,
          stillAllowHumanExecution: true,
        },
      },
      currentMode: 'AUTONOMY_OFF',
    },
  };
}

describeIfDb('decision metadata persistence', () => {
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

  async function setupFixture(input?: {
    policyJson?: Prisma.InputJsonValue;
    safetyMode?: SafetyMode;
  }) {
    const suffix = randomUUID().slice(0, 8);

    const org = await prisma.organization.create({
      data: {
        name: `Decision ${suffix}`,
        slug: `decision-${suffix}`,
      },
    });

    const user = await prisma.user.create({
      data: {
        orgId: org.id,
        email: `agent-${suffix}@example.com`,
        name: 'Decision Agent',
        actorType: ActorType.AGENT,
      },
    });

    await prisma.policy.create({
      data: {
        orgId: org.id,
        name: 'default-autonomy-policy',
        version: 1,
        isActive: true,
        policyJson: (input?.policyJson ?? basePolicyJson()) as Prisma.InputJsonValue,
        createdByUserId: user.id,
      },
    });

    await prisma.orgSafetyState.create({
      data: {
        orgId: org.id,
        mode: input?.safetyMode ?? SafetyMode.NORMAL,
        reason: 'test state',
        updatedByUserId: user.id,
      },
    });

    orgId = org.id;
    userId = user.id;
  }

  async function createTool(input: {
    name: string;
    handlerKey: string;
    riskLevel: RiskLevel;
    autonomyLevel: AutonomyLevel;
    inputSchema: Prisma.InputJsonValue;
  }) {
    await prisma.toolDefinition.create({
      data: {
        orgId,
        name: input.name,
        version: '1.0.0',
        description: input.name,
        handlerKey: input.handlerKey,
        active: true,
        riskLevel: input.riskLevel,
        autonomyLevel: input.autonomyLevel,
        requiredPermissions: [],
        inputSchema: input.inputSchema,
        endpointAllowsHumanOverride: false,
        requiresReason: false,
        requiresSnapshot: false,
      },
    });
  }

  async function loadDecision(executionId: string) {
    const execution = await prisma.toolExecution.findUnique({
      where: { id: executionId },
      select: {
        outputPayload: true,
      },
    });

    return (execution?.outputPayload ?? null) as DecisionPayload | null;
  }

  it('stores POLICY_BLOCKLIST decision details for denyIfAutonomous block', async () => {
    const policy = basePolicyJson();
    policy.autonomy.toolBlocks.denyIfAutonomous = ['marketing.sms.send'];

    await setupFixture({ policyJson: policy as Prisma.InputJsonValue });
    await createTool({
      name: 'marketing.sms.send',
      handlerKey: 'marketing.sms.send',
      riskLevel: RiskLevel.MEDIUM,
      autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          customerId: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['customerId', 'body'],
      },
    });

    const result = await registry.execute(
      'marketing.sms.send',
      {
        customerId: 'cust-1',
        body: 'Hello',
      },
      {
        orgId,
        actorType: ActorType.AGENT,
        actorUserId: userId,
        actorLabel: 'decision-test-agent',
        isAutonomous: true,
      },
    );

    expect(result.status).toBe('BLOCKED');
    if (result.status !== 'BLOCKED') {
      return;
    }

    const payload = await loadDecision(result.executionId);
    expect(payload?.decision?.stage).toBe('POLICY_BLOCKLIST');
    expect(payload?.decision?.details?.policyPath).toBe('autonomy.toolBlocks.denyIfAutonomous');
  });

  it('stores TIME_WINDOW decision details for active denyTools block', async () => {
    const policy = basePolicyJson();
    policy.autonomy.timeWindows = [
      {
        name: 'always-on-deny',
        timezone: 'UTC',
        days: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'],
        start: '00:00',
        end: '23:59',
        rules: {
          denyTools: ['marketing.sms.send'],
          maxRiskLevelAutonomous: 'HIGH',
        },
      },
    ];

    await setupFixture({ policyJson: policy as Prisma.InputJsonValue });
    await createTool({
      name: 'marketing.sms.send',
      handlerKey: 'marketing.sms.send',
      riskLevel: RiskLevel.MEDIUM,
      autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          customerId: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['customerId', 'body'],
      },
    });

    const result = await registry.execute(
      'marketing.sms.send',
      {
        customerId: 'cust-1',
        body: 'Hello',
      },
      {
        orgId,
        actorType: ActorType.AGENT,
        actorUserId: userId,
        actorLabel: 'decision-test-agent',
        isAutonomous: true,
      },
    );

    expect(result.status).toBe('BLOCKED');
    if (result.status !== 'BLOCKED') {
      return;
    }

    const payload = await loadDecision(result.executionId);
    expect(payload?.decision?.stage).toBe('TIME_WINDOW');
    expect(payload?.decision?.details?.policyPath).toBe('autonomy.timeWindows[0].rules.denyTools');
  });

  it('stores FINANCIAL_EXPOSURE decision details for breach queue', async () => {
    const policy = basePolicyJson();
    policy.financial.dailyExposure.enabled = true;
    policy.financial.dailyExposure.timezone = 'UTC';
    policy.financial.dailyExposure.limits = {
      subscriptionCreateCents: 10_000,
    };
    policy.financial.dailyExposure.toolCostMap = [
      {
        tool: 'billing.subscription.create',
        amountField: 'amountCents',
        bucket: 'subscriptionCreateCents',
      },
    ];

    await setupFixture({ policyJson: policy as Prisma.InputJsonValue });
    await createTool({
      name: 'billing.subscription.create',
      handlerKey: 'billing.subscription.create',
      riskLevel: RiskLevel.LOW,
      autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          amountCents: { type: 'integer', minimum: 1 },
        },
        required: ['amountCents'],
      },
    });

    const result = await registry.execute(
      'billing.subscription.create',
      {
        amountCents: 20_000,
      },
      {
        orgId,
        actorType: ActorType.AGENT,
        actorUserId: userId,
        actorLabel: 'decision-test-agent',
        isAutonomous: true,
      },
    );

    expect(result.status).toBe('QUEUED_APPROVAL');
    if (result.status !== 'QUEUED_APPROVAL') {
      return;
    }

    const payload = await loadDecision(result.executionId);
    expect(payload?.decision?.stage).toBe('FINANCIAL_EXPOSURE');
    expect(payload?.decision?.details?.policyPath).toBe('financial.dailyExposure.limits.subscriptionCreateCents');
    expect(payload?.decision?.details?.limits?.limit).toBe(10_000);
    expect(payload?.decision?.details?.limits?.projected).toBeGreaterThan(10_000);
  });

  it('stores KILLSWITCH decision details for autonomous AUTONOMY_OFF block', async () => {
    await setupFixture({
      policyJson: basePolicyJson() as Prisma.InputJsonValue,
      safetyMode: SafetyMode.AUTONOMY_OFF,
    });
    await createTool({
      name: 'crm.task.create',
      handlerKey: 'crm.task.create',
      riskLevel: RiskLevel.MEDIUM,
      autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          leadId: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['leadId', 'note'],
      },
    });

    const result = await registry.execute(
      'crm.task.create',
      {
        leadId: 'lead-1',
        note: 'Follow up',
      },
      {
        orgId,
        actorType: ActorType.AGENT,
        actorUserId: userId,
        actorLabel: 'decision-test-agent',
        isAutonomous: true,
      },
    );

    expect(result.status).toBe('BLOCKED');
    if (result.status !== 'BLOCKED') {
      return;
    }

    const payload = await loadDecision(result.executionId);
    expect(payload?.decision?.stage).toBe('KILLSWITCH');
    expect(payload?.decision?.details?.policyPath).toBe('killSwitch.modes.AUTONOMY_OFF.blocksAutonomousExecution');
  });
});
