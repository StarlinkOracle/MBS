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

describeIfDb('assessment attachment tools', () => {
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
        name: `Assess ${suffix}`,
        slug: `assess-${suffix}`,
      },
    });

    const user = await prisma.user.create({
      data: {
        orgId: org.id,
        email: `assess-${suffix}@example.com`,
        name: 'Assessment User',
        actorType: ActorType.HUMAN,
      },
    });

    await prisma.toolDefinition.createMany({
      data: [
        {
          orgId: org.id,
          name: 'crm.assessment.create',
          version: '1.0.0',
          description: 'Create system assessment',
          handlerKey: 'crm.assessment.create',
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
          orgId: org.id,
          name: 'crm.attachmentRef.create',
          version: '1.0.0',
          description: 'Create attachment ref',
          handlerKey: 'crm.attachmentRef.create',
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
          orgId: org.id,
          name: 'crm.assessment.attachment.add',
          version: '1.0.0',
          description: 'Attach nameplate photo to assessment',
          handlerKey: 'crm.assessment.attachment.add',
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

    orgId = org.id;
    userId = user.id;
  }

  it('creates assessment + attachment link with NAMEPLATE_PHOTO kind', async () => {
    await setupFixture();

    const assessmentResult = await registry.execute(
      'crm.assessment.create',
      {
        existingManufacturer: 'Goodman',
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'assessment-test',
        isAutonomous: false,
      },
    );

    expect(assessmentResult.status).toBe('EXECUTED');
    if (assessmentResult.status !== 'EXECUTED') {
      return;
    }

    const assessmentOutput =
      assessmentResult.output && typeof assessmentResult.output === 'object' && !Array.isArray(assessmentResult.output)
        ? (assessmentResult.output as Record<string, unknown>)
        : {};
    const assessmentId = String(assessmentOutput.assessmentId);

    const attachmentResult = await registry.execute(
      'crm.attachmentRef.create',
      {
        provider: 'URL',
        fileName: 'nameplate.jpg',
        url: 'https://example.com/nameplate.jpg',
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'assessment-test',
        isAutonomous: false,
      },
    );

    expect(attachmentResult.status).toBe('EXECUTED');
    if (attachmentResult.status !== 'EXECUTED') {
      return;
    }

    const attachmentOutput =
      attachmentResult.output && typeof attachmentResult.output === 'object' && !Array.isArray(attachmentResult.output)
        ? (attachmentResult.output as Record<string, unknown>)
        : {};
    const attachmentRefId = String(attachmentOutput.attachmentRefId);

    const linkResult = await registry.execute(
      'crm.assessment.attachment.add',
      {
        assessmentId,
        attachmentRefId,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'assessment-test',
        isAutonomous: false,
      },
    );

    expect(linkResult.status).toBe('EXECUTED');

    const linked = await prisma.assessmentAttachment.findUnique({
      where: {
        assessmentId_attachmentRefId: {
          assessmentId,
          attachmentRefId,
        },
      },
    });

    expect(linked).not.toBeNull();
    expect(linked?.kind).toBe('NAMEPLATE_PHOTO');
  });
});
