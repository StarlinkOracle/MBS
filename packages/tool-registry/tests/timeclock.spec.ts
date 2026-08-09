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

describeIfDb('timeclock + edit request tools', () => {
  const prisma = new PrismaClient();
  const registry = new ToolRegistry(prisma);

  let orgId = '';
  let techUserId = '';
  let managerUserId = '';
  let jobId = '';

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
    techUserId = '';
    managerUserId = '';
    jobId = '';
  });

  async function setupFixture() {
    const suffix = randomUUID().slice(0, 8);
    const org = await prisma.organization.create({
      data: {
        name: `Time Org ${suffix}`,
        slug: `time-org-${suffix}`,
      },
    });
    orgId = org.id;

    const tech = await prisma.user.create({
      data: {
        orgId,
        email: `tech-${suffix}@example.com`,
        name: 'Tech',
        actorType: ActorType.HUMAN,
      },
    });
    techUserId = tech.id;

    const manager = await prisma.user.create({
      data: {
        orgId,
        email: `manager-${suffix}@example.com`,
        name: 'Manager',
        actorType: ActorType.HUMAN,
      },
    });
    managerUserId = manager.id;

    await prisma.policy.create({
      data: {
        orgId,
        name: 'default-autonomy-policy',
        version: 1,
        isActive: true,
        policyJson,
        createdByUserId: managerUserId,
      },
    });

    await prisma.orgSafetyState.create({
      data: {
        orgId,
        mode: SafetyMode.NORMAL,
        updatedByUserId: managerUserId,
      },
    });

    await prisma.toolDefinition.createMany({
      data: [
        {
          orgId,
          name: 'time.clockIn',
          version: '1.0.0',
          description: 'clock in',
          handlerKey: 'time.clockIn',
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
          name: 'time.clockOut',
          version: '1.0.0',
          description: 'clock out',
          handlerKey: 'time.clockOut',
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
          name: 'time.breakStart',
          version: '1.0.0',
          description: 'break start',
          handlerKey: 'time.breakStart',
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
          name: 'time.breakEnd',
          version: '1.0.0',
          description: 'break end',
          handlerKey: 'time.breakEnd',
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
          name: 'time.jobStart',
          version: '1.0.0',
          description: 'job start',
          handlerKey: 'time.jobStart',
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
          name: 'time.jobStop',
          version: '1.0.0',
          description: 'job stop',
          handlerKey: 'time.jobStop',
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
          name: 'time.edit.request',
          version: '1.0.0',
          description: 'edit request',
          handlerKey: 'time.edit.request',
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
          name: 'time.edit.review',
          version: '1.0.0',
          description: 'edit review',
          handlerKey: 'time.edit.review',
          active: true,
          riskLevel: RiskLevel.HIGH,
          autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
          requiredPermissions: [],
          inputSchema: { type: 'object', additionalProperties: true },
          endpointAllowsHumanOverride: false,
          requiresReason: false,
          requiresSnapshot: false,
        },
      ],
    });

    const customer = await prisma.customer.create({
      data: {
        orgId,
        fullName: 'Time Customer',
      },
    });
    const quote = await prisma.quote.create({
      data: {
        orgId,
        kind: 'SERVICE',
        status: 'DRAFT',
        customerId: customer.id,
      },
    });
    const job = await prisma.job.create({
      data: {
        orgId,
        customerId: customer.id,
        quoteId: quote.id,
        title: 'Time Job',
      },
    });
    jobId = job.id;
  }

  it('clockOut auto-stops open job entries and writes audit trail', async () => {
    await setupFixture();

    const actorContext = {
      orgId,
      actorType: ActorType.HUMAN,
      actorUserId: techUserId,
      actorLabel: 'time-test',
      isAutonomous: false,
    } as const;

    const clockIn = await registry.execute('time.clockIn', {}, actorContext);
    expect(clockIn.status).toBe('EXECUTED');

    const jobStart = await registry.execute('time.jobStart', { jobId }, actorContext);
    expect(jobStart.status).toBe('EXECUTED');

    const clockOut = await registry.execute('time.clockOut', {}, actorContext);
    expect(clockOut.status).toBe('EXECUTED');

    const openJobs = await prisma.timeEntry.count({
      where: {
        orgId,
        userId: techUserId,
        type: 'JOB',
        status: 'OPEN',
      },
    });
    expect(openJobs).toBe(0);

    const openShifts = await prisma.timeEntry.count({
      where: {
        orgId,
        userId: techUserId,
        type: 'SHIFT',
        status: 'OPEN',
      },
    });
    expect(openShifts).toBe(0);

    const autoStopAudit = await prisma.auditLog.count({
      where: {
        orgId,
        action: 'TIME_AUTO_STOP_JOB_ON_CLOCK_OUT',
      },
    });
    expect(autoStopAudit).toBeGreaterThan(0);

    const autoStopEvent = await prisma.eventOutbox.count({
      where: {
        orgId,
        eventType: 'time.job.autostopped',
      },
    });
    expect(autoStopEvent).toBeGreaterThan(0);
  });

  it('clockOut auto-stops open breaks and closes shift', async () => {
    await setupFixture();

    const actorContext = {
      orgId,
      actorType: ActorType.HUMAN,
      actorUserId: techUserId,
      actorLabel: 'time-test',
      isAutonomous: false,
    } as const;

    const clockIn = await registry.execute('time.clockIn', {}, actorContext);
    expect(clockIn.status).toBe('EXECUTED');

    const breakStart = await registry.execute('time.breakStart', {}, actorContext);
    expect(breakStart.status).toBe('EXECUTED');

    const clockOut = await registry.execute('time.clockOut', {}, actorContext);
    expect(clockOut.status).toBe('EXECUTED');

    const openBreaks = await prisma.timeEntry.count({
      where: {
        orgId,
        userId: techUserId,
        type: 'BREAK',
        status: 'OPEN',
      },
    });
    expect(openBreaks).toBe(0);

    const autoStopBreakAudit = await prisma.auditLog.count({
      where: {
        orgId,
        action: 'TIME_AUTO_STOP_BREAK_ON_CLOCK_OUT',
      },
    });
    expect(autoStopBreakAudit).toBeGreaterThan(0);
  });

  it('rejects breakStart while a job timer is open', async () => {
    await setupFixture();

    const actorContext = {
      orgId,
      actorType: ActorType.HUMAN,
      actorUserId: techUserId,
      actorLabel: 'time-test',
      isAutonomous: false,
    } as const;

    await registry.execute('time.clockIn', {}, actorContext);
    await registry.execute('time.jobStart', { jobId }, actorContext);

    const breakStart = await registry.execute('time.breakStart', {}, actorContext);
    expect(breakStart.status).toBe('FAILED');
    if (breakStart.status === 'FAILED') {
      expect(breakStart.errorCode).toBe('TIME_BREAK_JOB_CONFLICT');
      expect(breakStart.recoverable).toBe(true);
    }
  });

  it('rejects jobStart when there is no open shift', async () => {
    await setupFixture();

    const actorContext = {
      orgId,
      actorType: ActorType.HUMAN,
      actorUserId: techUserId,
      actorLabel: 'time-test',
      isAutonomous: false,
    } as const;

    const jobStart = await registry.execute('time.jobStart', { jobId }, actorContext);
    expect(jobStart.status).toBe('FAILED');
    if (jobStart.status === 'FAILED') {
      expect(jobStart.errorCode).toBe('TIME_NO_OPEN_SHIFT');
      expect(jobStart.recoverable).toBe(true);
    }
  });

  it('keeps edits pending until review and applies changes only after approval', async () => {
    await setupFixture();

    const entry = await prisma.timeEntry.create({
      data: {
        orgId,
        userId: techUserId,
        type: 'SHIFT',
        startedAt: new Date('2026-02-22T14:00:00.000Z'),
        endedAt: new Date('2026-02-22T20:00:00.000Z'),
        status: 'CLOSED',
      },
    });

    const requestResult = await registry.execute(
      'time.edit.request',
      {
        timeEntryId: entry.id,
        requestedChanges: {
          startedAt: '2026-02-22T13:45:00.000Z',
          endedAt: '2026-02-22T20:15:00.000Z',
          notes: 'Adjusted for travel time',
        },
        reason: 'Clock-in button was delayed while loading',
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: techUserId,
        actorLabel: 'time-test',
        isAutonomous: false,
      },
    );
    expect(requestResult.status).toBe('EXECUTED');

    const pendingRequest = await prisma.timeEditRequest.findFirst({
      where: {
        orgId,
        timeEntryId: entry.id,
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(pendingRequest?.status).toBe('PENDING');

    const unchangedEntry = await prisma.timeEntry.findUnique({
      where: { id: entry.id },
    });
    expect(unchangedEntry?.startedAt.toISOString()).toBe(
      '2026-02-22T14:00:00.000Z',
    );

    const reviewResult = await registry.execute(
      'time.edit.review',
      {
        timeEditRequestId: pendingRequest?.id,
        decision: 'APPROVE',
        reviewNote: 'Approved based on tech call log',
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: managerUserId,
        actorLabel: 'time-review-test',
        isAutonomous: false,
      },
    );
    expect(reviewResult.status).toBe('EXECUTED');

    const approvedRequest = await prisma.timeEditRequest.findUnique({
      where: { id: pendingRequest?.id },
    });
    expect(approvedRequest?.status).toBe('APPROVED');
    expect(approvedRequest?.reviewedByUserId).toBe(managerUserId);

    const updatedEntry = await prisma.timeEntry.findUnique({
      where: { id: entry.id },
    });
    expect(updatedEntry?.startedAt.toISOString()).toBe(
      '2026-02-22T13:45:00.000Z',
    );
    expect(updatedEntry?.endedAt?.toISOString()).toBe(
      '2026-02-22T20:15:00.000Z',
    );
    expect(updatedEntry?.notes).toContain('Adjusted for travel time');

    const auditCount = await prisma.auditLog.count({
      where: {
        orgId,
        action: 'time.edit.applied',
        entityType: 'TimeEntry',
        entityId: entry.id,
      },
    });
    expect(auditCount).toBeGreaterThan(0);
  });
});
