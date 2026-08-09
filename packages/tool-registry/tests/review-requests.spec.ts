import { randomUUID } from 'node:crypto';

import {
  ActorType,
  ApprovalStatus,
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

describeIfDb('review request automation foundation', () => {
  const prisma = new PrismaClient();
  const registry = new ToolRegistry(prisma);

  let orgId = '';
  let userId = '';
  let jobId = '';

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterEach(async () => {
    if (orgId) {
      await prisma.organization.delete({ where: { id: orgId } });
    }
    orgId = '';
    userId = '';
    jobId = '';
  });

  async function setupFixture() {
    const suffix = randomUUID().slice(0, 8);
    const org = await prisma.organization.create({
      data: {
        name: `Reviews ${suffix}`,
        slug: `reviews-${suffix}`,
      },
    });

    const user = await prisma.user.create({
      data: {
        orgId: org.id,
        email: `reviews-${suffix}@example.com`,
        name: 'Review Operator',
        actorType: ActorType.HUMAN,
      },
    });

    const customer = await prisma.customer.create({
      data: {
        orgId: org.id,
        fullName: 'Maya Customer',
        phone: '+17205550001',
        email: 'maya@example.com',
      },
    });

    const job = await prisma.job.create({
      data: {
        orgId: org.id,
        customerId: customer.id,
        title: 'Install condenser fan motor',
        status: 'COMPLETED',
      },
    });

    await prisma.toolDefinition.createMany({
      data: [
        {
          orgId: org.id,
          name: 'marketing.review.request.auto',
          version: '1.0.0',
          description: 'Auto draft review request',
          handlerKey: 'marketing.review.request.auto',
          active: true,
          riskLevel: RiskLevel.MEDIUM,
          autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
          requiredPermissions: [],
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              jobId: { type: 'string' },
              queueSend: { type: 'boolean' },
            },
            required: ['jobId'],
          },
          endpointAllowsHumanOverride: false,
          requiresReason: false,
          requiresSnapshot: false,
        },
        {
          orgId: org.id,
          name: 'marketing.review.request.send',
          version: '1.0.0',
          description: 'Send review request',
          handlerKey: 'marketing.review.request.send',
          active: true,
          riskLevel: RiskLevel.HIGH,
          autonomyLevel: AutonomyLevel.REQUIRES_APPROVAL,
          requiredPermissions: [],
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              reviewRequestId: { type: 'string' },
            },
            required: ['reviewRequestId'],
          },
          endpointAllowsHumanOverride: false,
          requiresReason: true,
          requiresSnapshot: false,
        },
      ],
    });

    orgId = org.id;
    userId = user.id;
    jobId = job.id;
  }

  it('drafts review request from job context', async () => {
    await setupFixture();

    const result = await registry.execute(
      'marketing.review.request.auto',
      {
        jobId,
      },
      {
        orgId,
        actorType: ActorType.SYSTEM,
        actorUserId: userId,
        actorLabel: 'review-auto-test',
        isAutonomous: false,
      },
    );

    expect(result.status).toBe('EXECUTED');
    const reviewRequests = await prisma.reviewRequest.findMany({
      where: { orgId },
    });
    expect(reviewRequests).toHaveLength(1);
    expect(reviewRequests[0]?.status).toBe('DRAFT');
    expect(reviewRequests[0]?.jobId).toBe(jobId);
  });

  it('queues approval for autonomous send and sends after approval execution', async () => {
    await setupFixture();

    const draft = await registry.execute(
      'marketing.review.request.auto',
      {
        jobId,
      },
      {
        orgId,
        actorType: ActorType.SYSTEM,
        actorUserId: userId,
        actorLabel: 'review-auto-test',
        isAutonomous: false,
      },
    );
    expect(draft.status).toBe('EXECUTED');

    const reviewRequest = await prisma.reviewRequest.findFirst({
      where: { orgId, jobId },
      orderBy: { createdAt: 'desc' },
    });
    expect(reviewRequest).not.toBeNull();

    const queued = await registry.execute(
      'marketing.review.request.send',
      {
        reviewRequestId: reviewRequest?.id,
      },
      {
        orgId,
        actorType: ActorType.SYSTEM,
        actorUserId: userId,
        actorLabel: 'review-auto-test',
        isAutonomous: true,
        reason: 'Queue approval for review request send',
      },
    );

    expect(queued.status).toBe('QUEUED_APPROVAL');
    if (queued.status !== 'QUEUED_APPROVAL') {
      return;
    }

    await prisma.approvalRequest.update({
      where: { id: queued.approvalRequestId },
      data: { status: ApprovalStatus.APPROVED },
    });

    const executed = await registry.executeApprovedRequest(queued.approvalRequestId, {
      orgId,
      actorType: ActorType.HUMAN,
      actorUserId: userId,
      actorLabel: 'review-approver',
      isAutonomous: false,
    });

    expect(executed.status).toBe('EXECUTED');

    const updated = await prisma.reviewRequest.findUnique({
      where: { id: reviewRequest?.id },
    });
    expect(updated?.status).toBe('SENT');
    expect(updated?.sentAt).not.toBeNull();
  });
});
