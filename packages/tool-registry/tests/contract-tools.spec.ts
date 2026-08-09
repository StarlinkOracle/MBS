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
      HIGH: { requiredApprovals: 1, expiresMinutes: 240 },
      CRITICAL: { requiredApprovals: 2, expiresMinutes: 60 },
    },
    escalation: { ifPendingMinutes: 60, notifyRoles: ['owner'] },
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
    currentMode: 'NORMAL',
  },
} as const satisfies Prisma.InputJsonValue;

describeIfDb('contract tools registration + deterministic execution', () => {
  const prisma = new PrismaClient();
  const registry = new ToolRegistry(prisma);

  let orgId = '';
  let userId = '';
  let quoteId = '';

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterEach(async () => {
    if (orgId) {
      await prisma.organization.delete({
        where: { id: orgId },
      });
    }
    orgId = '';
    userId = '';
    quoteId = '';
  });

  async function setupFixture() {
    const suffix = randomUUID().slice(0, 8);
    const org = await prisma.organization.create({
      data: {
        name: `Contract Org ${suffix}`,
        slug: `contract-org-${suffix}`,
      },
    });
    orgId = org.id;

    const user = await prisma.user.create({
      data: {
        orgId,
        email: `contract-${suffix}@example.com`,
        name: 'Contract Operator',
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

    const quote = await prisma.quote.create({
      data: {
        orgId,
        status: 'SENT',
        kind: 'INSTALL',
        totalCents: 950000,
        finalTotalCents: 950000,
      },
    });
    quoteId = quote.id;

    await prisma.toolDefinition.createMany({
      data: [
        {
          orgId,
          name: 'contract.draft.createFromQuote',
          version: '1.0.0',
          description: 'draft create',
          handlerKey: 'contract.draft.createFromQuote',
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
          name: 'contract.signatureEnvelope.createForQuote',
          version: '1.0.0',
          description: 'envelope create',
          handlerKey: 'contract.signatureEnvelope.createForQuote',
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
          name: 'contract.esign.send',
          version: '1.0.0',
          description: 'esign send',
          handlerKey: 'contract.esign.send',
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
          name: 'contract.redline.generate',
          version: '1.0.0',
          description: 'redline generate',
          handlerKey: 'contract.redline.generate',
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
          name: 'contract.references.extract',
          version: '1.0.0',
          description: 'references extract',
          handlerKey: 'contract.references.extract',
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

  function getOutputObject(output: unknown): Record<string, unknown> {
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
      return {};
    }
    return output as Record<string, unknown>;
  }

  it('reuses draft and envelope creates by requestId for deterministic idempotency', async () => {
    await setupFixture();
    const draftRequestId = `draft-${randomUUID().slice(0, 8)}`;
    const envelopeRequestId = `env-${randomUUID().slice(0, 8)}`;

    const firstDraft = await registry.execute(
      'contract.draft.createFromQuote',
      {
        quoteId,
        requestId: draftRequestId,
        templateId: 'template-standard',
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        isAutonomous: false,
      },
    );
    expect(firstDraft.status).toBe('EXECUTED');
    const firstDraftOutput = getOutputObject((firstDraft as { output?: unknown }).output);
    const draft = getOutputObject(firstDraftOutput.draft);
    const draftId = String(draft.draftId || '');
    expect(draftId).not.toBe('');

    const secondDraft = await registry.execute(
      'contract.draft.createFromQuote',
      {
        quoteId,
        requestId: draftRequestId,
        templateId: 'template-standard',
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        isAutonomous: false,
      },
    );
    expect(secondDraft.status).toBe('EXECUTED');
    const secondDraftOutput = getOutputObject((secondDraft as { output?: unknown }).output);
    const secondDraftRow = getOutputObject(secondDraftOutput.draft);
    expect(secondDraftRow.draftId).toBe(draftId);
    expect(secondDraftOutput.idempotent).toBe(true);

    const envelope = await registry.execute(
      'contract.signatureEnvelope.createForQuote',
      {
        quoteId,
        draftId,
        requestId: envelopeRequestId,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        isAutonomous: false,
      },
    );
    expect(envelope.status).toBe('EXECUTED');
    const envelopeOutput = getOutputObject((envelope as { output?: unknown }).output);
    const envelopeRow = getOutputObject(envelopeOutput.envelope);
    const envelopeId = String(envelopeRow.envelopeId || '');
    expect(envelopeId).not.toBe('');

    const sendResult = await registry.execute(
      'contract.esign.send',
      {
        quoteId,
        envelopeId,
        requestId: `send-${randomUUID().slice(0, 8)}`,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        isAutonomous: false,
      },
    );
    expect(sendResult.status).toBe('EXECUTED');

    const sendAgain = await registry.execute(
      'contract.esign.send',
      {
        quoteId,
        envelopeId,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        isAutonomous: false,
      },
    );
    expect(sendAgain.status).toBe('EXECUTED');
    const sendAgainOutput = getOutputObject((sendAgain as { output?: unknown }).output);
    expect(sendAgainOutput.idempotent).toBe(true);
  });

  it('generates deterministic redline summary and extracts section references', async () => {
    await setupFixture();

    const redline = await registry.execute(
      'contract.redline.generate',
      {
        baselineText: 'Section 2.1 Payment within 30 days\nSection 4 Warranty is limited',
        proposedText: 'Section 2.1 Payment within 15 days\nSection 4 Warranty is extended',
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        isAutonomous: false,
      },
    );
    expect(redline.status).toBe('EXECUTED');
    const redlineOutput = getOutputObject((redline as { output?: unknown }).output);
    expect(typeof redlineOutput.diffSummary).toBe('string');
    expect(Array.isArray(redlineOutput.sectionChanges)).toBe(true);
    expect(Array.isArray(redlineOutput.references)).toBe(true);

    const refs = await registry.execute(
      'contract.references.extract',
      {
        text: 'Please review Section 2.1, Section 4 and sec. 5.3 for updates.',
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        isAutonomous: false,
      },
    );
    expect(refs.status).toBe('EXECUTED');
    const refsOutput = getOutputObject((refs as { output?: unknown }).output);
    expect(refsOutput.references).toEqual(
      expect.arrayContaining(['Section 2.1', 'Section 4', 'Section 5.3']),
    );
  });
});
