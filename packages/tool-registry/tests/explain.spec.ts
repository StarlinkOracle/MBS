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

describeIfDb('registry explain dry-run', () => {
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

  async function setupFixture(policyJson: Prisma.InputJsonValue) {
    const suffix = randomUUID().slice(0, 8);

    const org = await prisma.organization.create({
      data: {
        name: `Explain ${suffix}`,
        slug: `explain-${suffix}`,
      },
    });

    const user = await prisma.user.create({
      data: {
        orgId: org.id,
        email: `agent-${suffix}@example.com`,
        name: 'Explain Agent',
        actorType: ActorType.AGENT,
      },
    });

    await prisma.policy.create({
      data: {
        orgId: org.id,
        name: 'default-autonomy-policy',
        version: 1,
        isActive: true,
        policyJson,
        createdByUserId: user.id,
      },
    });

    await prisma.orgSafetyState.create({
      data: {
        orgId: org.id,
        mode: SafetyMode.NORMAL,
        reason: 'test setup',
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

  it('dry-run blocked decision matches execute and writes nothing by itself', async () => {
    const policy = basePolicyJson();
    policy.autonomy.toolBlocks.denyIfAutonomous = ['marketing.sms.send'];

    await setupFixture(policy as Prisma.InputJsonValue);
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

    const beforeCount = await prisma.toolExecution.count({ where: { orgId } });

    const dry = await registry.explain(
      'marketing.sms.send',
      { customerId: 'c-1', body: 'Hi' },
      {
        orgId,
        actorType: ActorType.AGENT,
        actorUserId: userId,
        actorLabel: 'dry-run',
        isAutonomous: true,
      },
    );

    const afterCount = await prisma.toolExecution.count({ where: { orgId } });
    expect(afterCount).toBe(beforeCount);
    expect(dry.status).toBe('BLOCKED');
    expect(dry.decision.stage).toBe('POLICY_BLOCKLIST');
    expect(dry.decision.details.policyPath).toBe('autonomy.toolBlocks.denyIfAutonomous');

    const real = await registry.execute(
      'marketing.sms.send',
      { customerId: 'c-1', body: 'Hi' },
      {
        orgId,
        actorType: ActorType.AGENT,
        actorUserId: userId,
        actorLabel: 'execute',
        isAutonomous: true,
      },
    );

    expect(real.status).toBe('BLOCKED');
    if (real.status !== 'BLOCKED') {
      return;
    }

    const execution = await prisma.toolExecution.findUnique({
      where: { id: real.executionId },
      select: { outputPayload: true },
    });
    const stored = execution?.outputPayload as any;
    expect(stored?.decision?.stage).toBe(dry.decision.stage);
    expect(stored?.decision?.details?.policyPath).toBe(dry.decision.details.policyPath);
  });

  it('dry-run queued decision matches execute and writes nothing by itself', async () => {
    const policy = basePolicyJson();
    policy.financial.dailyExposure.enabled = true;
    policy.financial.dailyExposure.timezone = 'UTC';
    policy.financial.dailyExposure.limits = {
      subscriptionCreateCents: 5000,
    };
    policy.financial.dailyExposure.toolCostMap = [
      {
        tool: 'billing.subscription.create',
        amountField: 'amountCents',
        bucket: 'subscriptionCreateCents',
      },
    ];

    await setupFixture(policy as Prisma.InputJsonValue);
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

    const beforeCount = await prisma.toolExecution.count({ where: { orgId } });

    const dry = await registry.explain(
      'billing.subscription.create',
      { amountCents: 10000 },
      {
        orgId,
        actorType: ActorType.AGENT,
        actorUserId: userId,
        actorLabel: 'dry-run',
        isAutonomous: true,
      },
    );

    const afterCount = await prisma.toolExecution.count({ where: { orgId } });
    expect(afterCount).toBe(beforeCount);
    expect(dry.status).toBe('QUEUED_APPROVAL');
    expect(dry.decision.stage).toBe('FINANCIAL_EXPOSURE');

    const real = await registry.execute(
      'billing.subscription.create',
      { amountCents: 10000 },
      {
        orgId,
        actorType: ActorType.AGENT,
        actorUserId: userId,
        actorLabel: 'execute',
        isAutonomous: true,
      },
    );

    expect(real.status).toBe('QUEUED_APPROVAL');
    if (real.status !== 'QUEUED_APPROVAL') {
      return;
    }

    const execution = await prisma.toolExecution.findUnique({
      where: { id: real.executionId },
      select: { outputPayload: true },
    });
    const stored = execution?.outputPayload as any;
    expect(stored?.decision?.stage).toBe(dry.decision.stage);
    expect(stored?.decision?.details?.policyPath).toBe(dry.decision.details.policyPath);
  });
});
