import { randomUUID } from 'node:crypto';

import {
  ActorType,
  AutonomyLevel,
  GuardrailStatus,
  Prisma,
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

import { computeInstallPriceBreakdown } from '@rcs/shared';

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
        cooldownSecondsByRisk: { LOW: 0, MEDIUM: 5, HIGH: 30, CRITICAL: 999999 },
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
} as const satisfies Prisma.InputJsonValue;

type Fixture = {
  orgId: string;
  salesUserId: string;
  ownerUserId: string;
  leadId: string;
  assessmentId: string;
};

describeIfDb('install pricing tools', () => {
  const prisma = new PrismaClient();
  const registry = new ToolRegistry(prisma);

  let orgId = '';

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterEach(async () => {
    if (orgId) {
      await prisma.organization.delete({ where: { id: orgId } });
    }
    orgId = '';
  });

  async function setupFixture(): Promise<Fixture> {
    const suffix = randomUUID().slice(0, 8);

    const org = await prisma.organization.create({
      data: {
        name: `Install Pricing ${suffix}`,
        slug: `install-pricing-${suffix}`,
      },
    });
    orgId = org.id;

    const permissionKeys = [
      'crm:write',
      'pricing:discount:apply_pct',
      'pricing:discount:apply_cents',
      'pricing:discount:override_limits',
      'pricing:block:override',
    ];

    const permissionRecords = await Promise.all(
      permissionKeys.map((key) =>
        prisma.permission.upsert({
          where: { key },
          update: {},
          create: { key, description: `${key} permission` },
        }),
      ),
    );
    const permissionByKey = new Map(permissionRecords.map((permission) => [permission.key, permission.id]));

    const salesRole = await prisma.role.create({
      data: {
        orgId: org.id,
        name: 'sales_rep',
      },
    });

    const managerRole = await prisma.role.create({
      data: {
        orgId: org.id,
        name: 'billing_manager',
      },
    });

    const ownerRole = await prisma.role.create({
      data: {
        orgId: org.id,
        name: 'owner',
      },
    });

    await prisma.rolePermission.createMany({
      data: [
        { roleId: salesRole.id, permissionId: permissionByKey.get('crm:write') as string },
        {
          roleId: salesRole.id,
          permissionId: permissionByKey.get('pricing:discount:apply_pct') as string,
        },
        {
          roleId: salesRole.id,
          permissionId: permissionByKey.get('pricing:discount:apply_cents') as string,
        },
        { roleId: managerRole.id, permissionId: permissionByKey.get('crm:write') as string },
        {
          roleId: managerRole.id,
          permissionId: permissionByKey.get('pricing:discount:apply_pct') as string,
        },
        {
          roleId: managerRole.id,
          permissionId: permissionByKey.get('pricing:discount:apply_cents') as string,
        },
        { roleId: ownerRole.id, permissionId: permissionByKey.get('crm:write') as string },
        {
          roleId: ownerRole.id,
          permissionId: permissionByKey.get('pricing:discount:apply_pct') as string,
        },
        {
          roleId: ownerRole.id,
          permissionId: permissionByKey.get('pricing:discount:apply_cents') as string,
        },
        {
          roleId: ownerRole.id,
          permissionId: permissionByKey.get('pricing:block:override') as string,
        },
      ],
    });

    const salesUser = await prisma.user.create({
      data: {
        orgId: org.id,
        email: `sales-${suffix}@example.com`,
        name: 'Sales Rep',
        actorType: ActorType.HUMAN,
      },
    });

    const ownerUser = await prisma.user.create({
      data: {
        orgId: org.id,
        email: `owner-${suffix}@example.com`,
        name: 'Owner',
        actorType: ActorType.HUMAN,
      },
    });

    await prisma.userRole.createMany({
      data: [
        { userId: salesUser.id, roleId: salesRole.id },
        { userId: ownerUser.id, roleId: ownerRole.id },
      ],
    });

    await prisma.policy.create({
      data: {
        orgId: org.id,
        name: 'default-autonomy-policy',
        version: 1,
        isActive: true,
        policyJson,
        createdByUserId: ownerUser.id,
      },
    });

    const lead = await prisma.lead.create({
      data: {
        orgId: org.id,
        fullName: 'Install Prospect',
        email: `lead-${suffix}@example.com`,
        phone: `+1720${suffix}`,
        status: 'NEW',
      },
    });

    const assessment = await prisma.systemAssessment.create({
      data: {
        orgId: org.id,
        installType: 'COMBO',
        accessType: 'STANDARD',
        baseLaborCostCents: 200_000,
        manualLaborAdjustmentCents: 0,
        permitCostCents: 30_000,
      },
    });

    await prisma.toolDefinition.createMany({
      data: [
        {
          orgId: org.id,
          name: 'crm.quote.generateInstallOptions',
          version: '1.0.0',
          description: 'Generate options',
          handlerKey: 'crm.quote.generateInstallOptions',
          active: true,
          riskLevel: RiskLevel.MEDIUM,
          autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
          requiredPermissions: ['crm:write'],
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              leadId: { type: 'string' },
              assessmentId: { type: 'string' },
              tierSelections: { type: 'object' },
            },
            required: ['leadId', 'assessmentId', 'tierSelections'],
          },
          requiresReason: true,
          requiresSnapshot: false,
          endpointAllowsHumanOverride: false,
        },
        {
          orgId: org.id,
          name: 'crm.quote.applyDiscount',
          version: '1.0.0',
          description: 'Apply discount',
          handlerKey: 'crm.quote.applyDiscount',
          active: true,
          riskLevel: RiskLevel.MEDIUM,
          autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
          requiredPermissions: ['crm:write'],
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              quoteOptionId: { type: 'string' },
              discountPctBps: { type: 'integer' },
              discountCents: { type: 'integer' },
              reason: { type: 'string' },
            },
            required: ['quoteOptionId'],
          },
          requiresReason: true,
          requiresSnapshot: false,
          endpointAllowsHumanOverride: false,
        },
        {
          orgId: org.id,
          name: 'system.pricing.overrideBlock',
          version: '1.0.0',
          description: 'Override block',
          handlerKey: 'system.pricing.overrideBlock',
          active: true,
          riskLevel: RiskLevel.HIGH,
          autonomyLevel: AutonomyLevel.NEVER_AUTONOMOUS,
          requiredPermissions: ['pricing:block:override'],
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              quoteOptionId: { type: 'string' },
              reason: { type: 'string' },
            },
            required: ['quoteOptionId', 'reason'],
          },
          requiresReason: true,
          requiresSnapshot: false,
          endpointAllowsHumanOverride: true,
        },
      ],
    });

    return {
      orgId: org.id,
      salesUserId: salesUser.id,
      ownerUserId: ownerUser.id,
      leadId: lead.id,
      assessmentId: assessment.id,
    };
  }

  function tierSelections() {
    return {
      GOOD: {
        equipment: [{ sku: 'GOOD-EQ', label: 'Good Eq', costCents: 500_000 }],
        materials: [{ sku: 'GOOD-MAT', label: 'Good Mat', costCents: 100_000 }],
      },
      BETTER: {
        equipment: [{ sku: 'BETTER-EQ', label: 'Better Eq', costCents: 550_000 }],
        materials: [{ sku: 'BETTER-MAT', label: 'Better Mat', costCents: 125_000 }],
      },
      BEST: {
        equipment: [{ sku: 'BEST-EQ', label: 'Best Eq', costCents: 600_000 }],
        materials: [{ sku: 'BEST-MAT', label: 'Best Mat', costCents: 150_000 }],
      },
    };
  }

  async function createQuoteFixture(fixture: Fixture) {
    const result = await registry.execute(
      'crm.quote.generateInstallOptions',
      {
        leadId: fixture.leadId,
        assessmentId: fixture.assessmentId,
        tierSelections: tierSelections(),
      },
      {
        orgId: fixture.orgId,
        actorType: ActorType.HUMAN,
        actorUserId: fixture.salesUserId,
        actorLabel: 'pricing-test-sales',
        isAutonomous: false,
        reason: 'generate install options for testing',
      },
    );

    expect(result.status).toBe('EXECUTED');

    const quoteId =
      result.status === 'EXECUTED' &&
      result.output &&
      typeof result.output === 'object' &&
      !Array.isArray(result.output)
        ? (result.output as Record<string, any>)?.quote?.id
        : null;

    expect(typeof quoteId).toBe('string');
    return quoteId as string;
  }

  it('generate options persists breakdown and audit log', async () => {
    const fixture = await setupFixture();

    const result = await registry.execute(
      'crm.quote.generateInstallOptions',
      {
        leadId: fixture.leadId,
        assessmentId: fixture.assessmentId,
        tierSelections: tierSelections(),
      },
      {
        orgId: fixture.orgId,
        actorType: ActorType.HUMAN,
        actorUserId: fixture.salesUserId,
        actorLabel: 'pricing-test-sales',
        isAutonomous: false,
        reason: 'generate install options for testing',
      },
    );

    expect(result.status).toBe('EXECUTED');
    if (result.status !== 'EXECUTED') {
      return;
    }

    const quoteId = ((result.output as Record<string, any>)?.quote?.id ?? '') as string;
    expect(quoteId).not.toHaveLength(0);

    const quote = await prisma.quote.findFirst({
      where: { id: quoteId, orgId: fixture.orgId },
      include: { options: true },
    });

    expect(quote).not.toBeNull();
    expect(quote?.options).toHaveLength(3);

    const goodOption = quote?.options.find((option) => option.optionKey === 'GOOD');
    expect(goodOption).toBeDefined();

    const expected = computeInstallPriceBreakdown({
      installType: 'COMBO',
      accessType: 'STANDARD',
      equipmentCostCents: 500_000,
      materialsCostCents: 100_000,
      baseLaborCostCents: 200_000,
      manualLaborAdjustmentCents: 0,
      permitCostCents: 30_000,
    });

    expect(goodOption?.pricingMode).toBe(
      'INSTALL_CUSHION20_FLOOR_ACCESS500_SALES5_DISCOUNT',
    );
    expect(goodOption?.equipmentAdjustedCents).toBe(expected.equipmentAdjustedCents);
    expect(goodOption?.materialsAdjustedCents).toBe(expected.materialsAdjustedCents);
    expect(goodOption?.priceBeforeDiscountCents).toBe(expected.priceBeforeDiscountCents);
    expect(goodOption?.finalSellPriceCents).toBe(expected.finalSellPriceCents);

    const audit = await prisma.auditLog.findFirst({
      where: {
        orgId: fixture.orgId,
        entityType: 'ToolExecution',
        entityId: result.executionId,
        action: 'tool.executed',
      },
    });
    expect(audit).not.toBeNull();
  });

  it('apply discount within SALES limit succeeds', async () => {
    const fixture = await setupFixture();
    const quoteId = await createQuoteFixture(fixture);

    const option = await prisma.quoteOption.findFirst({
      where: { orgId: fixture.orgId, quoteId, optionKey: 'GOOD' },
    });
    expect(option).not.toBeNull();
    if (!option) {
      return;
    }

    const result = await registry.execute(
      'crm.quote.applyDiscount',
      {
        quoteOptionId: option.id,
        discountCents: 50_000,
        reason: 'competitive adjustment',
      },
      {
        orgId: fixture.orgId,
        actorType: ActorType.HUMAN,
        actorUserId: fixture.salesUserId,
        actorLabel: 'pricing-test-sales',
        isAutonomous: false,
        reason: 'apply controlled discount',
      },
    );

    expect(result.status).toBe('EXECUTED');

    const refreshed = await prisma.quoteOption.findUnique({
      where: { id: option.id },
    });
    expect(refreshed?.discountTotalCents).toBe(50_000);
    expect(refreshed?.guardrailStatus).not.toBe(GuardrailStatus.BLOCK);
  });

  it('apply discount exceeding SALES limit queues approval', async () => {
    const fixture = await setupFixture();
    const quoteId = await createQuoteFixture(fixture);

    const option = await prisma.quoteOption.findFirst({
      where: { orgId: fixture.orgId, quoteId, optionKey: 'GOOD' },
    });
    expect(option).not.toBeNull();
    if (!option) {
      return;
    }

    const result = await registry.execute(
      'crm.quote.applyDiscount',
      {
        quoteOptionId: option.id,
        discountCents: 90_000,
        reason: 'discount exceeds sales threshold',
      },
      {
        orgId: fixture.orgId,
        actorType: ActorType.HUMAN,
        actorUserId: fixture.salesUserId,
        actorLabel: 'pricing-test-sales',
        isAutonomous: false,
        reason: 'apply high discount',
      },
    );

    expect(result.status).toBe('QUEUED_APPROVAL');
    if (result.status !== 'QUEUED_APPROVAL') {
      return;
    }

    const approval = await prisma.approvalRequest.findUnique({
      where: { id: result.approvalRequestId },
    });

    expect(approval).not.toBeNull();
    expect(approval?.requiredApprovals).toBe(1);
    expect(approval?.reason).toContain('requires approval');
  });

  it('blocks discount that breaches guardrail and allows owner override with event log', async () => {
    const fixture = await setupFixture();
    const quoteId = await createQuoteFixture(fixture);

    const option = await prisma.quoteOption.findFirst({
      where: { orgId: fixture.orgId, quoteId, optionKey: 'GOOD' },
    });
    expect(option).not.toBeNull();
    if (!option) {
      return;
    }

    const blocked = await registry.execute(
      'crm.quote.applyDiscount',
      {
        quoteOptionId: option.id,
        discountCents: 500_000,
        reason: 'aggressive discount test',
      },
      {
        orgId: fixture.orgId,
        actorType: ActorType.HUMAN,
        actorUserId: fixture.salesUserId,
        actorLabel: 'pricing-test-sales',
        isAutonomous: false,
        reason: 'attempt blocked discount',
      },
    );

    expect(blocked.status).toBe('BLOCKED');

    const blockedOption = await prisma.quoteOption.findUnique({
      where: { id: option.id },
    });
    expect(blockedOption?.guardrailStatus).toBe(GuardrailStatus.BLOCK);

    const override = await registry.execute(
      'system.pricing.overrideBlock',
      {
        quoteOptionId: option.id,
        reason: 'Owner override for approved strategic deal',
      },
      {
        orgId: fixture.orgId,
        actorType: ActorType.HUMAN,
        actorUserId: fixture.ownerUserId,
        actorLabel: 'pricing-test-owner',
        isAutonomous: false,
        reason: 'owner pricing block override',
      },
    );

    expect(override.status).toBe('EXECUTED');

    const overrideAudit = await prisma.auditLog.findFirst({
      where: {
        orgId: fixture.orgId,
        action: 'pricing.block.overridden',
        entityType: 'QuoteOption',
        entityId: option.id,
      },
    });
    expect(overrideAudit).not.toBeNull();

    const outboxEvent = await prisma.eventOutbox.findFirst({
      where: {
        orgId: fixture.orgId,
        eventType: 'pricing.block.overridden',
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(outboxEvent).not.toBeNull();
  });
});
