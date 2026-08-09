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
      AUTONOMY_OFF: { blocksAutonomousExecution: true, stillAllowReadTools: true, stillAllowHumanExecution: true },
      FULL_STOP: { blocksAutonomousExecution: true, stillAllowReadTools: false, stillAllowHumanExecution: true },
    },
    currentMode: 'NORMAL',
  },
} as const satisfies Prisma.InputJsonValue;

function nextWeekdayIsoDate(): string {
  const now = new Date();
  const atUtcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  for (let i = 0; i < 10; i += 1) {
    const candidate = new Date(atUtcMidnight.getTime() + i * 24 * 60 * 60 * 1000);
    const day = candidate.getUTCDay();
    if (day >= 1 && day <= 5) {
      return candidate.toISOString().slice(0, 10);
    }
  }
  return atUtcMidnight.toISOString().slice(0, 10);
}

describeIfDb('dispatch scheduling + media retention', () => {
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
        name: `Dispatch Test ${suffix}`,
        slug: `dispatch-test-${suffix}`,
      },
    });
    const user = await prisma.user.create({
      data: {
        orgId: org.id,
        email: `dispatch-${suffix}@example.com`,
        name: 'Dispatch Operator',
        actorType: ActorType.HUMAN,
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

    await prisma.toolDefinition.createMany({
      data: [
        {
          orgId: org.id,
          name: 'scheduling.settings.update',
          version: '1.0.0',
          description: 'Update scheduling settings',
          handlerKey: 'scheduling.settings.update',
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
          orgId: org.id,
          name: 'scheduling.appointment.bookFromToken',
          version: '1.0.0',
          description: 'Book appointment',
          handlerKey: 'scheduling.appointment.bookFromToken',
          active: true,
          riskLevel: RiskLevel.MEDIUM,
          autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
          requiredPermissions: [],
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['quoteToken', 'date', 'timeBlockCode'],
            properties: {
              quoteToken: { type: 'string' },
              date: { type: 'string' },
              timeBlockCode: { type: 'string' },
              type: { type: 'string' },
              notes: { type: 'string' },
            },
          },
          endpointAllowsHumanOverride: false,
          requiresReason: false,
          requiresSnapshot: false,
        },
        {
          orgId: org.id,
          name: 'admin.media.purgeExpired',
          version: '1.0.0',
          description: 'Purge expired media',
          handlerKey: 'admin.media.purgeExpired',
          active: true,
          riskLevel: RiskLevel.HIGH,
          autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
          requiredPermissions: [],
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              limit: { type: 'integer', minimum: 1 },
            },
          },
          endpointAllowsHumanOverride: false,
          requiresReason: false,
          requiresSnapshot: false,
        },
        {
          orgId: org.id,
          name: 'media.uploadSession.start',
          version: '1.0.0',
          description: 'Start upload session',
          handlerKey: 'media.uploadSession.start',
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
          name: 'media.uploadSession.complete',
          version: '1.0.0',
          description: 'Complete upload session',
          handlerKey: 'media.uploadSession.complete',
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
          name: 'media.uploadSession.fail',
          version: '1.0.0',
          description: 'Fail upload session',
          handlerKey: 'media.uploadSession.fail',
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
          name: 'media.photo.upload',
          version: '1.0.0',
          description: 'Upload media metadata',
          handlerKey: 'media.photo.upload',
          active: true,
          riskLevel: RiskLevel.MEDIUM,
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

  async function createServiceQuoteWithToken(tokenPrefix: string) {
    const customer = await prisma.customer.create({
      data: {
        orgId,
        fullName: `${tokenPrefix} Customer`,
      },
    });

    const token = `${tokenPrefix}-${randomUUID().replace(/-/g, '')}`;
    const quote = await prisma.quote.create({
      data: {
        orgId,
        customerId: customer.id,
        kind: 'SERVICE',
        status: 'SENT',
        publicToken: token,
      },
    });

    return quote;
  }

  async function createInstallQuoteWithToken(tokenPrefix: string) {
    const customer = await prisma.customer.create({
      data: {
        orgId,
        fullName: `${tokenPrefix} Install Customer`,
      },
    });

    const token = `${tokenPrefix}-${randomUUID().replace(/-/g, '')}`;
    const quote = await prisma.quote.create({
      data: {
        orgId,
        customerId: customer.id,
        kind: 'INSTALL',
        status: 'ACCEPTED',
        publicToken: token,
      },
    });

    return quote;
  }

  it('enforces default capacity and throttle for service bookings', async () => {
    await setupFixture();

    const date = nextWeekdayIsoDate();
    const [q1, q2, q3] = await Promise.all([
      createServiceQuoteWithToken('svc-a'),
      createServiceQuoteWithToken('svc-b'),
      createServiceQuoteWithToken('svc-c'),
    ]);

    const first = await registry.execute(
      'scheduling.appointment.bookFromToken',
      {
        quoteToken: q1.publicToken!,
        date,
        timeBlockCode: 'BLOCK_0800_1000',
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'dispatch-test',
        isAutonomous: false,
      },
    );
    const second = await registry.execute(
      'scheduling.appointment.bookFromToken',
      {
        quoteToken: q2.publicToken!,
        date,
        timeBlockCode: 'BLOCK_0800_1000',
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'dispatch-test',
        isAutonomous: false,
      },
    );
    const third = await registry.execute(
      'scheduling.appointment.bookFromToken',
      {
        quoteToken: q3.publicToken!,
        date,
        timeBlockCode: 'BLOCK_0800_1000',
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'dispatch-test',
        isAutonomous: false,
      },
    );

    expect(first.status).toBe('EXECUTED');
    expect(second.status).toBe('EXECUTED');
    expect(third.status).toBe('FAILED');

    const throttle = await registry.execute(
      'scheduling.settings.update',
      {
        throttleServiceEnabled: true,
        throttleServiceCapacityPerBlock: 1,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'dispatch-test',
        isAutonomous: false,
      },
    );
    expect(throttle.status).toBe('EXECUTED');

    const [q4, q5] = await Promise.all([
      createServiceQuoteWithToken('svc-d'),
      createServiceQuoteWithToken('svc-e'),
    ]);

    const fourth = await registry.execute(
      'scheduling.appointment.bookFromToken',
      {
        quoteToken: q4.publicToken!,
        date,
        timeBlockCode: 'BLOCK_1000_1200',
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'dispatch-test',
        isAutonomous: false,
      },
    );
    const fifth = await registry.execute(
      'scheduling.appointment.bookFromToken',
      {
        quoteToken: q5.publicToken!,
        date,
        timeBlockCode: 'BLOCK_1000_1200',
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'dispatch-test',
        isAutonomous: false,
      },
    );

    expect(fourth.status).toBe('EXECUTED');
    expect(fifth.status).toBe('FAILED');
  });

  it('prevents double-booking under concurrent booking attempts', async () => {
    await setupFixture();

    const date = nextWeekdayIsoDate();
    await registry.execute(
      'scheduling.settings.update',
      {
        defaultServiceCapacityPerBlock: 1,
        throttleServiceEnabled: false,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'dispatch-test',
        isAutonomous: false,
      },
    );

    const [q1, q2] = await Promise.all([
      createServiceQuoteWithToken('conc-a'),
      createServiceQuoteWithToken('conc-b'),
    ]);

    const [a, b] = await Promise.all([
      registry.execute(
        'scheduling.appointment.bookFromToken',
        { quoteToken: q1.publicToken!, date, timeBlockCode: 'BLOCK_1200_1400' },
        {
          orgId,
          actorType: ActorType.HUMAN,
          actorUserId: userId,
          actorLabel: 'dispatch-concurrency-test-a',
          isAutonomous: false,
        },
      ),
      registry.execute(
        'scheduling.appointment.bookFromToken',
        { quoteToken: q2.publicToken!, date, timeBlockCode: 'BLOCK_1200_1400' },
        {
          orgId,
          actorType: ActorType.HUMAN,
          actorUserId: userId,
          actorLabel: 'dispatch-concurrency-test-b',
          isAutonomous: false,
        },
      ),
    ]);

    const statuses = [a.status, b.status];
    expect(statuses.filter((status) => status === 'EXECUTED')).toHaveLength(1);
    expect(statuses.filter((status) => status === 'FAILED')).toHaveLength(1);
  });

  it('enforces default and throttled capacity for install bookings independently', async () => {
    await setupFixture();

    const date = nextWeekdayIsoDate();
    const [q1, q2, q3] = await Promise.all([
      createInstallQuoteWithToken('inst-a'),
      createInstallQuoteWithToken('inst-b'),
      createInstallQuoteWithToken('inst-c'),
    ]);

    const first = await registry.execute(
      'scheduling.appointment.bookFromToken',
      {
        quoteToken: q1.publicToken!,
        date,
        timeBlockCode: 'BLOCK_1400_1600',
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'dispatch-test',
        isAutonomous: false,
      },
    );
    const second = await registry.execute(
      'scheduling.appointment.bookFromToken',
      {
        quoteToken: q2.publicToken!,
        date,
        timeBlockCode: 'BLOCK_1400_1600',
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'dispatch-test',
        isAutonomous: false,
      },
    );
    const third = await registry.execute(
      'scheduling.appointment.bookFromToken',
      {
        quoteToken: q3.publicToken!,
        date,
        timeBlockCode: 'BLOCK_1400_1600',
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'dispatch-test',
        isAutonomous: false,
      },
    );

    expect(first.status).toBe('EXECUTED');
    expect(second.status).toBe('EXECUTED');
    expect(third.status).toBe('FAILED');

    const throttle = await registry.execute(
      'scheduling.settings.update',
      {
        throttleInstallEnabled: true,
        throttleInstallCapacityPerBlock: 1,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'dispatch-test',
        isAutonomous: false,
      },
    );
    expect(throttle.status).toBe('EXECUTED');

    const [q4, q5] = await Promise.all([
      createInstallQuoteWithToken('inst-d'),
      createInstallQuoteWithToken('inst-e'),
    ]);

    const fourth = await registry.execute(
      'scheduling.appointment.bookFromToken',
      {
        quoteToken: q4.publicToken!,
        date,
        timeBlockCode: 'BLOCK_1200_1400',
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'dispatch-test',
        isAutonomous: false,
      },
    );
    const fifth = await registry.execute(
      'scheduling.appointment.bookFromToken',
      {
        quoteToken: q5.publicToken!,
        date,
        timeBlockCode: 'BLOCK_1200_1400',
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'dispatch-test',
        isAutonomous: false,
      },
    );

    expect(fourth.status).toBe('EXECUTED');
    expect(fifth.status).toBe('FAILED');
  });

  it('purges expired attachments and soft-deletes rows', async () => {
    await setupFixture();

    const attachment = await prisma.attachment.create({
      data: {
        orgId,
        kind: 'QUOTE_PHOTO',
        storageProvider: 'S3',
        bucket: 'mbs',
        objectKey: `org/${orgId}/expired/original.jpg`,
        displayObjectKey: `org/${orgId}/expired/display.jpg`,
        thumbObjectKey: `org/${orgId}/expired/thumb.jpg`,
        fileName: 'expired-photo.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1234,
        checksumSha256: 'deadbeef',
        uploadedByUserId: userId,
        ownerType: 'QUOTE',
        ownerId: randomUUID(),
        tag: 'OTHER',
        caption: 'expired',
        expiresAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
        isPublic: true,
      },
    });

    const result = await registry.execute(
      'admin.media.purgeExpired',
      { limit: 10 },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'media-purge-test',
        isAutonomous: false,
      },
    );

    expect(result.status).toBe('EXECUTED');

    const refreshed = await prisma.attachment.findUnique({
      where: { id: attachment.id },
      select: { deletedAt: true, isPublic: true, publicToken: true },
    });
    expect(refreshed?.deletedAt).not.toBeNull();
    expect(refreshed?.isPublic).toBe(false);
    expect(refreshed?.publicToken).toBeNull();

    const outbox = await prisma.eventOutbox.findFirst({
      where: {
        orgId,
        eventType: 'media.purged',
      },
    });
    expect(outbox).not.toBeNull();
  });

  it('persists correlationId across execution, audit, and outbox rows', async () => {
    await setupFixture();

    const attachment = await prisma.attachment.create({
      data: {
        orgId,
        kind: 'QUOTE_PHOTO',
        storageProvider: 'S3',
        bucket: 'mbs',
        objectKey: `org/${orgId}/expired-correlation/original.jpg`,
        displayObjectKey: `org/${orgId}/expired-correlation/display.jpg`,
        thumbObjectKey: `org/${orgId}/expired-correlation/thumb.jpg`,
        fileName: 'expired-correlation.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1234,
        checksumSha256: 'deadbeef-correlation',
        uploadedByUserId: userId,
        ownerType: 'QUOTE',
        ownerId: randomUUID(),
        tag: 'OTHER',
        caption: 'expired-correlation',
        expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
    });

    const correlationId = `corr-${randomUUID()}`;
    const result = await registry.execute(
      'admin.media.purgeExpired',
      { limit: 5 },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'media-purge-correlation-test',
        isAutonomous: false,
        correlationId,
      },
    );

    expect(result.status).toBe('EXECUTED');

    const refreshed = await prisma.attachment.findUnique({
      where: { id: attachment.id },
      select: { deletedAt: true },
    });
    expect(refreshed?.deletedAt).not.toBeNull();

    const execution = await prisma.toolExecution.findFirst({
      where: {
        orgId,
        correlationId,
      },
    });
    expect(execution).not.toBeNull();

    const audit = await prisma.auditLog.findFirst({
      where: {
        orgId,
        action: 'tool.executed',
        correlationId,
      },
    });
    expect(audit).not.toBeNull();

    const outbox = await prisma.eventOutbox.findFirst({
      where: {
        orgId,
        eventType: 'media.purged',
        correlationId,
      },
    });
    expect(outbox).not.toBeNull();
  });

  it('keeps media upload sessions and attachment writes idempotent', async () => {
    await setupFixture();
    const quote = await createServiceQuoteWithToken('media-session');
    const sessionKey = `media-${randomUUID()}`;

    const startInput = {
      sessionKey,
      ownerType: 'QUOTE',
      ownerId: quote.id,
      tag: 'BEFORE',
      caption: 'Session test',
      fileName: 'test.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 1234,
    };

    const started = await registry.execute(
      'media.uploadSession.start',
      startInput,
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'media-session-test',
        isAutonomous: false,
      },
    );
    const startedAgain = await registry.execute(
      'media.uploadSession.start',
      startInput,
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'media-session-test',
        isAutonomous: false,
      },
    );

    expect(started.status).toBe('EXECUTED');
    expect(startedAgain.status).toBe('EXECUTED');

    const startOutput = (started as any).output as any;
    const startAgainOutput = (startedAgain as any).output as any;
    const attachmentId = String(startOutput?.session?.attachmentId ?? '');

    expect(attachmentId.length).toBeGreaterThan(10);
    expect(startAgainOutput?.session?.attachmentId).toBe(attachmentId);

    const uploadPayload = {
      attachmentId,
      ownerType: 'QUOTE',
      ownerId: quote.id,
      tag: 'BEFORE',
      caption: 'Session test',
      kind: 'QUOTE_PHOTO',
      fileName: 'test.jpg',
      bucket: 'mbs',
      objectKey: `org/${orgId}/media-session/original.jpg`,
      displayObjectKey: `org/${orgId}/media-session/display.jpg`,
      thumbObjectKey: `org/${orgId}/media-session/thumb.jpg`,
      mimeType: 'image/jpeg',
      sizeBytes: 1234,
      checksumSha256: `checksum-${randomUUID()}`,
      width: 1600,
      height: 900,
    };

    const uploaded = await registry.execute(
      'media.photo.upload',
      uploadPayload,
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'media-session-test',
        isAutonomous: false,
      },
    );
    const uploadedAgain = await registry.execute(
      'media.photo.upload',
      uploadPayload,
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'media-session-test',
        isAutonomous: false,
      },
    );

    expect(uploaded.status).toBe('EXECUTED');
    expect(uploadedAgain.status).toBe('EXECUTED');

    const attachmentCount = await prisma.attachment.count({
      where: {
        orgId,
        id: attachmentId,
      },
    });
    expect(attachmentCount).toBe(1);

    const completed = await registry.execute(
      'media.uploadSession.complete',
      {
        sessionKey,
        attachmentId,
        bucket: 'mbs',
        objectKey: `org/${orgId}/media-session/original.jpg`,
        displayObjectKey: `org/${orgId}/media-session/display.jpg`,
        thumbObjectKey: `org/${orgId}/media-session/thumb.jpg`,
        fileName: 'test.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1234,
        checksumSha256: `checksum-${randomUUID()}`,
        width: 1600,
        height: 900,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'media-session-test',
        isAutonomous: false,
      },
    );
    const completedAgain = await registry.execute(
      'media.uploadSession.complete',
      {
        sessionKey,
        attachmentId,
        bucket: 'mbs',
        objectKey: `org/${orgId}/media-session/original.jpg`,
        displayObjectKey: `org/${orgId}/media-session/display.jpg`,
        thumbObjectKey: `org/${orgId}/media-session/thumb.jpg`,
        fileName: 'test.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1234,
        checksumSha256: `checksum-${randomUUID()}`,
        width: 1600,
        height: 900,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'media-session-test',
        isAutonomous: false,
      },
    );

    expect(completed.status).toBe('EXECUTED');
    expect(completedAgain.status).toBe('EXECUTED');

    const session = await prisma.mediaUploadSession.findUnique({
      where: {
        orgId_sessionKey: {
          orgId,
          sessionKey,
        },
      },
      select: {
        status: true,
        attachmentId: true,
        attemptCount: true,
        completedAt: true,
      },
    });

    expect(session?.status).toBe('COMPLETED');
    expect(session?.attachmentId).toBe(attachmentId);
    expect(session?.attemptCount).toBe(1);
    expect(session?.completedAt).not.toBeNull();
  });

  it('blocks expired media upload sessions by TTL before start/complete writes', async () => {
    await setupFixture();
    const quote = await createServiceQuoteWithToken('media-session-ttl');
    const sessionKey = `expired-by-ttl-${randomUUID()}`;

    await prisma.mediaUploadSession.create({
      data: {
        orgId,
        sessionKey,
        status: 'INITIATED',
        ownerType: 'QUOTE',
        ownerId: quote.id,
        tag: 'OTHER',
        fileName: 'ttl.jpg',
        mimeType: 'image/jpeg',
        createdByUserId: userId,
        expiresAt: new Date(Date.now() - 60 * 1000),
      },
    });

    const startResult = await registry.execute(
      'media.uploadSession.start',
      {
        sessionKey,
        ownerType: 'QUOTE',
        ownerId: quote.id,
        tag: 'OTHER',
        fileName: 'ttl.jpg',
        mimeType: 'image/jpeg',
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'media-session-ttl-test',
        isAutonomous: false,
      },
    );

    expect(startResult.status).toBe('FAILED');
    if (startResult.status === 'FAILED') {
      expect(startResult.errorCode).toBe('MEDIA_SESSION_EXPIRED');
    }

    const completeResult = await registry.execute(
      'media.uploadSession.complete',
      {
        sessionKey,
        attachmentId: `att-${randomUUID()}`,
        bucket: 'mbs',
        objectKey: `org/${orgId}/ttl/original.jpg`,
        displayObjectKey: `org/${orgId}/ttl/display.jpg`,
        thumbObjectKey: `org/${orgId}/ttl/thumb.jpg`,
        fileName: 'ttl.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1234,
        checksumSha256: `checksum-${randomUUID()}`,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'media-session-ttl-test',
        isAutonomous: false,
      },
    );

    expect(completeResult.status).toBe('FAILED');
    if (completeResult.status === 'FAILED') {
      expect(completeResult.errorCode).toBe('MEDIA_SESSION_EXPIRED');
    }

    const persisted = await prisma.mediaUploadSession.findUnique({
      where: {
        orgId_sessionKey: {
          orgId,
          sessionKey,
        },
      },
      select: {
        status: true,
        errorMessage: true,
      },
    });
    expect(persisted?.status).toBe('EXPIRED');
    expect(persisted?.errorMessage).toContain('expired');
  });

  it('expires stale media upload sessions during retention purge', async () => {
    await setupFixture();
    const quote = await createServiceQuoteWithToken('media-session-expire');
    const sessionKeyA = `stale-session-${randomUUID()}`;
    const sessionKeyB = `failed-session-${randomUUID()}`;
    const sessionKeyActive = `active-session-${randomUUID()}`;
    const now = Date.now();

    await prisma.mediaUploadSession.createMany({
      data: [
        {
          orgId,
          sessionKey: sessionKeyA,
          status: 'INITIATED',
          ownerType: 'QUOTE',
          ownerId: quote.id,
          tag: 'OTHER',
          fileName: 'stale-a.jpg',
          mimeType: 'image/jpeg',
          createdByUserId: userId,
          expiresAt: new Date(now - 5 * 60 * 1000),
        },
        {
          orgId,
          sessionKey: sessionKeyB,
          status: 'FAILED',
          ownerType: 'QUOTE',
          ownerId: quote.id,
          tag: 'OTHER',
          fileName: 'stale-b.jpg',
          mimeType: 'image/jpeg',
          createdByUserId: userId,
          expiresAt: new Date(now - 10 * 60 * 1000),
        },
        {
          orgId,
          sessionKey: sessionKeyActive,
          status: 'INITIATED',
          ownerType: 'QUOTE',
          ownerId: quote.id,
          tag: 'OTHER',
          fileName: 'active.jpg',
          mimeType: 'image/jpeg',
          createdByUserId: userId,
          expiresAt: new Date(now + 60 * 60 * 1000),
        },
      ],
    });

    const correlationId = `corr-media-session-expire-${randomUUID()}`;
    const result = await registry.execute(
      'admin.media.purgeExpired',
      { limit: 10 },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'media-purge-session-expire-test',
        isAutonomous: false,
        correlationId,
      },
    );

    expect(result.status).toBe('EXECUTED');
    const output = (result as any).output as Record<string, unknown> | undefined;
    expect(Number(output?.expiredSessionCount ?? 0)).toBe(2);

    const sessions = await prisma.mediaUploadSession.findMany({
      where: {
        orgId,
        sessionKey: {
          in: [sessionKeyA, sessionKeyB, sessionKeyActive],
        },
      },
      select: {
        sessionKey: true,
        status: true,
        errorMessage: true,
      },
    });

    const statusByKey = new Map(sessions.map((session) => [session.sessionKey, session]));
    expect(statusByKey.get(sessionKeyA)?.status).toBe('EXPIRED');
    expect(statusByKey.get(sessionKeyB)?.status).toBe('EXPIRED');
    expect(statusByKey.get(sessionKeyA)?.errorMessage).toContain('retention purge');
    expect(statusByKey.get(sessionKeyActive)?.status).toBe('INITIATED');

    const outbox = await prisma.eventOutbox.findFirst({
      where: {
        orgId,
        eventType: 'media.upload.session.expired',
        correlationId,
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(outbox).not.toBeNull();
  });
});
