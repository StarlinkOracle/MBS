import { randomUUID } from 'node:crypto';

import {
  ActorType,
  AutonomyLevel,
  MembershipStatus,
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
  customerId: string;
  bundleId: string;
  repairItemId: string;
};

describeIfDb('service pricing tools', () => {
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

  async function seedToolDefinitions(currentOrgId: string) {
    await prisma.toolDefinition.createMany({
      data: [
        {
          orgId: currentOrgId,
          name: 'crm.serviceQuote.createFromBundle',
          version: '1.0.0',
          description: 'Create service quote from bundle',
          handlerKey: 'crm.serviceQuote.createFromBundle',
          active: true,
          riskLevel: RiskLevel.MEDIUM,
          autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
          requiredPermissions: ['crm:service_quote:write'],
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              leadId: { type: 'string' },
              customerId: { type: 'string' },
              bundleTemplateId: { type: 'string' },
              timing: { type: 'string', enum: ['NORMAL', 'AFTER_HOURS'] },
            },
            required: ['leadId', 'bundleTemplateId', 'timing'],
          },
          endpointAllowsHumanOverride: false,
          requiresReason: false,
          requiresSnapshot: false,
        },
        {
          orgId: currentOrgId,
          name: 'crm.serviceQuote.addLineItem',
          version: '1.0.0',
          description: 'Add service quote line item',
          handlerKey: 'crm.serviceQuote.addLineItem',
          active: true,
          riskLevel: RiskLevel.MEDIUM,
          autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
          requiredPermissions: ['crm:service_quote:write'],
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              quoteId: { type: 'string' },
              pricebookItemId: { type: 'string' },
              qty: { type: 'integer' },
            },
            required: ['quoteId'],
          },
          endpointAllowsHumanOverride: false,
          requiresReason: false,
          requiresSnapshot: false,
        },
        {
          orgId: currentOrgId,
          name: 'crm.serviceQuote.removeLineItem',
          version: '1.0.0',
          description: 'Remove service quote line item',
          handlerKey: 'crm.serviceQuote.removeLineItem',
          active: true,
          riskLevel: RiskLevel.MEDIUM,
          autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
          requiredPermissions: ['crm:service_quote:write'],
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              quoteLineItemId: { type: 'string' },
            },
            required: ['quoteLineItemId'],
          },
          endpointAllowsHumanOverride: false,
          requiresReason: false,
          requiresSnapshot: false,
        },
        {
          orgId: currentOrgId,
          name: 'crm.serviceQuote.applyDiscount',
          version: '1.0.0',
          description: 'Apply service quote discount',
          handlerKey: 'crm.serviceQuote.applyDiscount',
          active: true,
          riskLevel: RiskLevel.MEDIUM,
          autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
          requiredPermissions: ['crm:service_quote:write'],
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              quoteId: { type: 'string' },
              discountPctBps: { type: 'integer' },
              discountCents: { type: 'integer' },
              reason: { type: 'string' },
            },
            required: ['quoteId'],
          },
          endpointAllowsHumanOverride: false,
          requiresReason: true,
          requiresSnapshot: false,
        },
        {
          orgId: currentOrgId,
          name: 'system.pricing.overrideBlock',
          version: '1.0.0',
          description: 'Owner override for pricing blocks',
          handlerKey: 'system.pricing.overrideBlock',
          active: true,
          riskLevel: RiskLevel.HIGH,
          autonomyLevel: AutonomyLevel.NEVER_AUTONOMOUS,
          requiredPermissions: ['pricing:block:override'],
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              quoteId: { type: 'string' },
              reason: { type: 'string' },
            },
            required: ['quoteId', 'reason'],
          },
          endpointAllowsHumanOverride: true,
          requiresReason: true,
          requiresSnapshot: false,
        },
      ],
    });
  }

  async function setupFixture(): Promise<Fixture> {
    const suffix = randomUUID().slice(0, 8);

    const org = await prisma.organization.create({
      data: {
        name: `Service Pricing ${suffix}`,
        slug: `service-pricing-${suffix}`,
      },
    });
    orgId = org.id;

    const permissionKeys = [
      'crm:service_quote:read',
      'crm:service_quote:write',
      'pricing:discount:apply_pct',
      'pricing:discount:apply_cents',
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
    const permissionByKey = new Map(
      permissionRecords.map((permission) => [permission.key, permission.id]),
    );

    const salesRole = await prisma.role.create({
      data: { orgId: org.id, name: 'sales_rep' },
    });

    const ownerRole = await prisma.role.create({
      data: { orgId: org.id, name: 'owner' },
    });

    await prisma.rolePermission.createMany({
      data: [
        {
          roleId: salesRole.id,
          permissionId: permissionByKey.get('crm:service_quote:write') as string,
        },
        {
          roleId: salesRole.id,
          permissionId: permissionByKey.get('crm:service_quote:read') as string,
        },
        {
          roleId: salesRole.id,
          permissionId: permissionByKey.get('pricing:discount:apply_pct') as string,
        },
        {
          roleId: salesRole.id,
          permissionId: permissionByKey.get('pricing:discount:apply_cents') as string,
        },
        {
          roleId: ownerRole.id,
          permissionId: permissionByKey.get('crm:service_quote:write') as string,
        },
        {
          roleId: ownerRole.id,
          permissionId: permissionByKey.get('crm:service_quote:read') as string,
        },
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
        email: `service-sales-${suffix}@example.com`,
        name: 'Service Sales',
        actorType: ActorType.HUMAN,
      },
    });

    const ownerUser = await prisma.user.create({
      data: {
        orgId: org.id,
        email: `service-owner-${suffix}@example.com`,
        name: 'Service Owner',
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
        fullName: 'Service Prospect',
        email: `service-lead-${suffix}@example.com`,
        phone: `+1720555${suffix}`,
        status: 'NEW',
      },
    });

    const customer = await prisma.customer.create({
      data: {
        orgId: org.id,
        fullName: 'Service Customer',
        email: `service-customer-${suffix}@example.com`,
        phone: `+1303555${suffix}`,
      },
    });

    const maintenancePlan = await prisma.maintenancePlan.create({
      data: {
        orgId: org.id,
        name: 'Comfort Plan',
        active: true,
        benefits: {
          afterHoursLaborMemberRateCents: 15000,
        },
      },
    });

    await prisma.customerMembership.create({
      data: {
        orgId: org.id,
        customerId: customer.id,
        planId: maintenancePlan.id,
        status: MembershipStatus.ACTIVE,
        startAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
    });

    const feeCategory = await prisma.pricebookCategory.create({
      data: {
        orgId: org.id,
        name: 'Fees',
        slug: 'fees',
      },
    });

    const repairCategory = await prisma.pricebookCategory.create({
      data: {
        orgId: org.id,
        name: 'Repair',
        slug: 'repair',
      },
    });

    const maintenanceCategory = await prisma.pricebookCategory.create({
      data: {
        orgId: org.id,
        name: 'Maintenance',
        slug: 'maintenance',
      },
    });

    const diagnosticItem = await prisma.pricebookItem.create({
      data: {
        orgId: org.id,
        categoryId: feeCategory.id,
        kind: 'FEE',
        name: 'Diagnostic Fee',
        unitType: 'EA',
        defaultSellCents: 12_900,
        active: true,
      },
    });

    const repairItem = await prisma.pricebookItem.create({
      data: {
        orgId: org.id,
        categoryId: repairCategory.id,
        kind: 'SERVICE',
        name: 'Capacitor Replacement',
        unitType: 'EA',
        defaultSellCents: 22_500,
        active: true,
      },
    });

    const maintenanceItem = await prisma.pricebookItem.create({
      data: {
        orgId: org.id,
        categoryId: maintenanceCategory.id,
        kind: 'ADDON',
        name: 'Maintenance Add-on',
        unitType: 'EA',
        defaultSellCents: 14_900,
        active: true,
      },
    });

    const bundle = await prisma.serviceBundleTemplate.create({
      data: {
        orgId: org.id,
        name: 'Capacitor Bundle',
        active: true,
        includeDiagnostic: true,
        defaultLaborHours: 4,
        baseItemIds: [repairItem.id],
        recommendedAddOnItemIds: [maintenanceItem.id],
      },
    });

    await seedToolDefinitions(org.id);

    return {
      orgId: org.id,
      salesUserId: salesUser.id,
      ownerUserId: ownerUser.id,
      leadId: lead.id,
      customerId: customer.id,
      bundleId: bundle.id,
      repairItemId: repairItem.id,
    };
  }

  async function createServiceQuote(
    fixture: Fixture,
    opts?: { customerId?: string; timing?: 'NORMAL' | 'AFTER_HOURS' },
  ) {
    const result = await registry.execute(
      'crm.serviceQuote.createFromBundle',
      {
        leadId: fixture.leadId,
        customerId: opts?.customerId,
        bundleTemplateId: fixture.bundleId,
        timing: opts?.timing ?? 'NORMAL',
      },
      {
        orgId: fixture.orgId,
        actorType: ActorType.HUMAN,
        actorUserId: fixture.salesUserId,
        actorLabel: 'service-pricing-test',
        isAutonomous: false,
        reason: 'Create service quote for test',
      },
    );

    expect(result.status).toBe('EXECUTED');
    const output =
      result.status === 'EXECUTED' &&
      result.output &&
      typeof result.output === 'object' &&
      !Array.isArray(result.output)
        ? (result.output as Record<string, unknown>)
        : null;
    const quotePayload =
      output && output.quote && typeof output.quote === 'object' && !Array.isArray(output.quote)
        ? (output.quote as Record<string, unknown>)
        : null;
    const quoteId = typeof quotePayload?.id === 'string' ? quotePayload.id : null;
    expect(quoteId).toBeTruthy();

    const quote = await prisma.quote.findUnique({
      where: { id: quoteId as string },
      include: {
        lineItems: true,
      },
    });
    expect(quote).not.toBeNull();

    return quote!;
  }

  it('create from bundle persists totals and audit log', async () => {
    const fixture = await setupFixture();

    const quote = await createServiceQuote(fixture, { timing: 'NORMAL' });

    expect(quote.kind).toBe('SERVICE');
    expect(quote.subtotalCents).toBe(22_500);
    expect(quote.diagnosticCreditCents).toBe(12_900);

    const auditCount = await prisma.auditLog.count({
      where: {
        orgId: fixture.orgId,
      },
    });
    expect(auditCount).toBeGreaterThan(0);
  });

  it('add/remove repair line toggles diagnostic credit dynamically', async () => {
    const fixture = await setupFixture();
    const quote = await createServiceQuote(fixture);

    const repairLine = quote.lineItems.find(
      (line) => line.categorySlugSnapshot === 'repair' && line.lineTotalCents > 0,
    );
    expect(repairLine).toBeTruthy();

    const removed = await registry.execute(
      'crm.serviceQuote.removeLineItem',
      {
        quoteLineItemId: repairLine?.id,
      },
      {
        orgId: fixture.orgId,
        actorType: ActorType.HUMAN,
        actorUserId: fixture.salesUserId,
        actorLabel: 'service-pricing-test',
        isAutonomous: false,
        reason: 'Remove repair line for credit toggle test',
      },
    );
    expect(removed.status).toBe('EXECUTED');

    const afterRemove = await prisma.quote.findUnique({
      where: { id: quote.id },
      include: { lineItems: true },
    });
    expect(afterRemove?.diagnosticCreditCents).toBe(0);
    expect(
      afterRemove?.lineItems.some((line) =>
        ((line.meta as Record<string, unknown> | null)?.isDiagnosticCredit === true),
      ),
    ).toBe(false);

    const added = await registry.execute(
      'crm.serviceQuote.addLineItem',
      {
        quoteId: quote.id,
        pricebookItemId: fixture.repairItemId,
        qty: 1,
      },
      {
        orgId: fixture.orgId,
        actorType: ActorType.HUMAN,
        actorUserId: fixture.salesUserId,
        actorLabel: 'service-pricing-test',
        isAutonomous: false,
        reason: 'Re-add repair line for credit toggle test',
      },
    );
    expect(added.status).toBe('EXECUTED');

    const afterAdd = await prisma.quote.findUnique({
      where: { id: quote.id },
      include: { lineItems: true },
    });
    expect(afterAdd?.diagnosticCreditCents).toBe(12_900);
    expect(
      afterAdd?.lineItems.some((line) =>
        ((line.meta as Record<string, unknown> | null)?.isDiagnosticCredit === true),
      ),
    ).toBe(true);
  });

  it('member after-hours quote snapshots 150/hr labor rate', async () => {
    const fixture = await setupFixture();

    const quote = await createServiceQuote(fixture, {
      customerId: fixture.customerId,
      timing: 'AFTER_HOURS',
    });

    expect(quote.isMember).toBe(true);
    expect(quote.timing).toBe('AFTER_HOURS');
    expect(quote.laborRateCents).toBe(15_000);
  });

  it('discount above sales limit queues approval', async () => {
    const fixture = await setupFixture();
    const quote = await createServiceQuote(fixture);

    const result = await registry.execute(
      'crm.serviceQuote.applyDiscount',
      {
        quoteId: quote.id,
        discountPctBps: 0,
        discountCents: 30_000,
        reason: 'Large promo discount',
      },
      {
        orgId: fixture.orgId,
        actorType: ActorType.HUMAN,
        actorUserId: fixture.salesUserId,
        actorLabel: 'service-pricing-test',
        isAutonomous: false,
        reason: 'Apply large discount',
      },
    );

    expect(result.status).toBe('QUEUED_APPROVAL');

    if (result.status === 'QUEUED_APPROVAL') {
      const approval = await prisma.approvalRequest.findUnique({
        where: { id: result.approvalRequestId },
      });
      expect(approval).not.toBeNull();
      expect(approval?.requiredApprovals).toBe(1);
    }
  });

  it('discount causing floor block is blocked and owner override logs event', async () => {
    const fixture = await setupFixture();
    const quote = await createServiceQuote(fixture);

    const blocked = await registry.execute(
      'crm.serviceQuote.applyDiscount',
      {
        quoteId: quote.id,
        discountCents: 60_000,
        reason: 'Aggressive discount',
      },
      {
        orgId: fixture.orgId,
        actorType: ActorType.HUMAN,
        actorUserId: fixture.ownerUserId,
        actorLabel: 'service-pricing-owner-test',
        isAutonomous: false,
        reason: 'Apply aggressive discount',
      },
    );

    expect(blocked.status).toBe('BLOCKED');

    const override = await registry.execute(
      'system.pricing.overrideBlock',
      {
        quoteId: quote.id,
        reason: 'Owner accepted low-floor exception',
      },
      {
        orgId: fixture.orgId,
        actorType: ActorType.HUMAN,
        actorUserId: fixture.ownerUserId,
        actorLabel: 'service-pricing-owner-test',
        isAutonomous: false,
        reason: 'Apply owner override',
      },
    );

    expect(override.status).toBe('EXECUTED');

    const audit = await prisma.auditLog.findFirst({
      where: {
        orgId: fixture.orgId,
        action: 'pricing.block.overridden',
        entityType: 'Quote',
        entityId: quote.id,
      },
    });
    expect(audit).not.toBeNull();

    const outbox = await prisma.eventOutbox.findFirst({
      where: {
        orgId: fixture.orgId,
        eventType: 'pricing.block.overridden',
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(outbox).not.toBeNull();

    const updatedQuote = await prisma.quote.findUnique({ where: { id: quote.id } });
    expect(updatedQuote?.guardrailStatus).toBe('BLOCK');
    const metadata = (updatedQuote?.metadata ?? {}) as Record<string, unknown>;
    expect(
      ((metadata.servicePricing as Record<string, unknown> | undefined)?.ownerBlockOverride as
        | Record<string, unknown>
        | undefined)?.reason,
    ).toBe('Owner accepted low-floor exception');
  });
});
