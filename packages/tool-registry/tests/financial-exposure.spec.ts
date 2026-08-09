import { randomUUID } from 'node:crypto';

import {
  ActorType,
  AutonomyLevel,
  PrismaClient,
  RiskLevel,
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

const basePolicy = {
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
        cooldownSecondsByRisk: { LOW: 0, MEDIUM: 5, HIGH: 30, CRITICAL: 999999 },
      },
      perTool: [],
    },
  },
  financial: {
    currency: 'USD',
    dailyExposure: {
      enabled: true,
      scope: 'ORG',
      resetsAt: '00:00',
      timezone: 'America/Denver',
      limits: {
        invoiceIssueCents: 250000,
        subscriptionCreateCents: 150000,
        discountTotalCents: 50000,
      },
      toolCostMap: [
        { tool: 'billing.invoice.issue', amountField: 'totalCents', bucket: 'invoiceIssueCents' },
        { tool: 'billing.subscription.create', amountField: 'amountCents', bucket: 'subscriptionCreateCents' },
        { tool: 'pricing.discount.apply', amountField: 'discountCents', bucket: 'discountTotalCents' },
      ],
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
      AUTONOMY_OFF: { blocksAutonomousExecution: true, stillAllowReadTools: true, stillAllowHumanExecution: true },
      FULL_STOP: { blocksAutonomousExecution: true, stillAllowReadTools: false, stillAllowHumanExecution: true },
    },
    currentMode: 'AUTONOMY_OFF',
  },
} as const;

describeIfDb('financial exposure governance', () => {
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

  async function setupOrgAndTools() {
    const suffix = randomUUID().slice(0, 8);
    const org = await prisma.organization.create({
      data: {
        name: `Exposure Test ${suffix}`,
        slug: `exposure-test-${suffix}`,
      },
    });

    const user = await prisma.user.create({
      data: {
        orgId: org.id,
        email: `agent-${suffix}@example.com`,
        name: 'Exposure Agent',
        actorType: ActorType.AGENT,
      },
    });

    await prisma.policy.create({
      data: {
        orgId: org.id,
        name: 'default-autonomy-policy',
        version: 1,
        isActive: true,
        policyJson: basePolicy,
        createdByUserId: user.id,
      },
    });

    await prisma.toolDefinition.createMany({
      data: [
        {
          orgId: org.id,
          name: 'billing.subscription.create',
          version: '1.0.0',
          description: 'Test subscription create',
          handlerKey: 'billing.subscription.create',
          active: true,
          riskLevel: RiskLevel.LOW,
          autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
          requiredPermissions: [],
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              amountCents: { type: 'integer', minimum: 1 },
            },
            required: ['amountCents'],
          },
          requiresReason: false,
          requiresSnapshot: false,
          endpointAllowsHumanOverride: false,
        },
        {
          orgId: org.id,
          name: 'pricing.discount.apply',
          version: '1.0.0',
          description: 'Test discount apply',
          handlerKey: 'pricing.discount.apply',
          active: true,
          riskLevel: RiskLevel.LOW,
          autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
          requiredPermissions: [],
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              discountCents: { type: 'integer', minimum: 1 },
            },
            required: ['discountCents'],
          },
          requiresReason: false,
          requiresSnapshot: false,
          endpointAllowsHumanOverride: false,
        },
      ],
    });

    orgId = org.id;
    userId = user.id;

    return { org, user };
  }

  it('queues approval when financial exposure breaches limit', async () => {
    await setupOrgAndTools();

    const result = await registry.execute(
      'billing.subscription.create',
      { amountCents: 200_000 },
      {
        orgId,
        actorType: ActorType.AGENT,
        actorUserId: userId,
        actorLabel: 'financial-test-agent',
        isAutonomous: true,
      },
    );

    expect(result.status).toBe('QUEUED_APPROVAL');
    if (result.status === 'QUEUED_APPROVAL') {
      expect(result.requiredApprovals).toBe(2);
      const approval = await prisma.approvalRequest.findUnique({
        where: { id: result.approvalRequestId },
      });
      expect(approval?.reason).toContain('Daily financial exposure exceeded');
    }
  });

  it('executes below limit and increments usedCents', async () => {
    await setupOrgAndTools();

    const result = await registry.execute(
      'billing.subscription.create',
      { amountCents: 40_000 },
      {
        orgId,
        actorType: ActorType.AGENT,
        actorUserId: userId,
        actorLabel: 'financial-test-agent',
        isAutonomous: true,
      },
    );

    expect(result.status).toBe('EXECUTED');

    const rows = await prisma.financialExposureDaily.findMany({
      where: {
        orgId,
        bucket: 'subscriptionCreateCents',
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.usedCents).toBe(40_000);
  });

  it('tracks increments per bucket per local date', async () => {
    await setupOrgAndTools();

    const first = await registry.execute(
      'billing.subscription.create',
      { amountCents: 20_000 },
      {
        orgId,
        actorType: ActorType.AGENT,
        actorUserId: userId,
        actorLabel: 'financial-test-agent',
        isAutonomous: true,
      },
    );

    const second = await registry.execute(
      'pricing.discount.apply',
      { discountCents: 3_000 },
      {
        orgId,
        actorType: ActorType.AGENT,
        actorUserId: userId,
        actorLabel: 'financial-test-agent',
        isAutonomous: true,
      },
    );

    expect(first.status).toBe('EXECUTED');
    expect(second.status).toBe('EXECUTED');

    const rows = await prisma.financialExposureDaily.findMany({
      where: { orgId },
      orderBy: { bucket: 'asc' },
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]?.bucket).toBe('discountTotalCents');
    expect(rows[0]?.usedCents).toBe(3_000);
    expect(rows[1]?.bucket).toBe('subscriptionCreateCents');
    expect(rows[1]?.usedCents).toBe(20_000);
    expect(rows[0]?.date.toISOString().slice(0, 10)).toBe(
      rows[1]?.date.toISOString().slice(0, 10),
    );
  });
});
