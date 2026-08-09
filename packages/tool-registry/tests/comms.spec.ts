import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

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

const execFileAsync = promisify(execFile);

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
    escalation: {
      ifPendingMinutes: 60,
      notifyRoles: ['owner'],
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
    currentMode: 'NORMAL',
  },
} as const satisfies Prisma.InputJsonValue;

async function createIMessageFixtureDb(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rcs-comms-imessage-'));
  const dbPath = join(dir, 'chat.db');

  const sql = `
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT);
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, date INTEGER, is_from_me INTEGER, handle_id INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);

    INSERT INTO chat (ROWID, guid) VALUES (1, 'chat-guid-1');
    INSERT INTO handle (ROWID, id, service) VALUES (1, '+13035551234', 'iMessage');
    INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1, 1);
    INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id) VALUES (1, 'msg-guid-1', 'Need a quote', 700000000, 0, 1);
    INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1);
  `;

  await execFileAsync('sqlite3', [dbPath, sql]);
  return dbPath;
}

describeIfDb('communications tools', () => {
  const prisma = new PrismaClient();
  const registry = new ToolRegistry(prisma);

  let orgId = '';
  let userId = '';
  let tmpDbDir: string | null = null;

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterEach(async () => {
    if (tmpDbDir) {
      await rm(tmpDbDir, { recursive: true, force: true });
      tmpDbDir = null;
    }
    delete process.env.IMESSAGE_CHAT_DB_PATH;
    delete process.env.COMMS_SEND_STUB;
    delete process.env.COMMS_SKIP_TIME_WINDOW;

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
        name: `Comms Test ${suffix}`,
        slug: `comms-test-${suffix}`,
      },
    });
    orgId = org.id;

    const user = await prisma.user.create({
      data: {
        orgId,
        email: `comms-${suffix}@example.com`,
        name: 'Comms Operator',
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
        reason: 'test',
        updatedByUserId: userId,
      },
    });

    await prisma.toolDefinition.createMany({
      data: [
        {
          orgId,
          name: 'comms.imessage.sync',
          version: '1.0.0',
          description: 'sync',
          handlerKey: 'comms.imessage.sync',
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
          name: 'comms.thread.link',
          version: '1.0.0',
          description: 'link',
          handlerKey: 'comms.thread.link',
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
          name: 'comms.draft.create',
          version: '1.0.0',
          description: 'draft',
          handlerKey: 'comms.draft.create',
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
          name: 'comms.draft.approveAndSend',
          version: '1.0.0',
          description: 'send',
          handlerKey: 'comms.draft.approveAndSend',
          active: true,
          riskLevel: RiskLevel.HIGH,
          autonomyLevel: AutonomyLevel.NEVER_AUTONOMOUS,
          requiredPermissions: [],
          inputSchema: { type: 'object', additionalProperties: true },
          endpointAllowsHumanOverride: true,
          requiresReason: true,
          requiresSnapshot: false,
        },
      ],
    });

    await prisma.customer.create({
      data: {
        orgId,
        fullName: 'Matched Customer',
        phone: '+13035551234',
      },
    });
  }

  it('syncs iMessage history idempotently and links by phone', async () => {
    await setupFixture();

    const dbPath = await createIMessageFixtureDb();
    tmpDbDir = join(dbPath, '..');
    process.env.IMESSAGE_CHAT_DB_PATH = dbPath;

    const first = await registry.execute(
      'comms.imessage.sync',
      { fullSync: true, batchSize: 100 },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'test',
        isAutonomous: false,
      },
    );
    expect(first.status).toBe('EXECUTED');

    const second = await registry.execute(
      'comms.imessage.sync',
      { fullSync: false, batchSize: 100 },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'test',
        isAutonomous: false,
      },
    );
    expect(second.status).toBe('EXECUTED');

    const [threadCount, messageCount, customerLinks] = await Promise.all([
      prisma.commsThread.count({ where: { orgId } }),
      prisma.commsMessage.count({ where: { orgId } }),
      prisma.commsEntityLink.count({
        where: {
          orgId,
          entityType: 'CUSTOMER',
        },
      }),
    ]);

    expect(threadCount).toBe(1);
    expect(messageCount).toBe(1);
    expect(customerLinks).toBe(1);
  });

  it('queues approval and sends draft only via approved execution', async () => {
    await setupFixture();
    process.env.COMMS_SEND_STUB = 'true';
    process.env.COMMS_SKIP_TIME_WINDOW = 'true';

    const thread = await prisma.commsThread.create({
      data: {
        orgId,
        channel: 'EMAIL',
        externalThreadId: 'thread-1',
        participantsJson: [{ email: 'customer@example.com' }],
        subject: 'Need help',
        lastMessageAt: new Date(),
      },
    });

    const createDraft = await registry.execute(
      'comms.draft.create',
      {
        threadId: thread.id,
        channel: 'EMAIL',
        to: [{ email: 'customer@example.com' }],
        subject: 'Re: Need help',
        bodyText: 'Draft reply',
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'test',
        isAutonomous: false,
      },
    );
    expect(createDraft.status).toBe('EXECUTED');

    const createdDraft = await prisma.outboundDraft.findFirst({
      where: { orgId, threadId: thread.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(createdDraft).not.toBeNull();

    const queue = await registry.execute(
      'comms.draft.approveAndSend',
      { draftId: createdDraft!.id },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'test',
        isAutonomous: false,
        reason: 'Send approved response',
      },
    );
    expect(queue.status).toBe('QUEUED_APPROVAL');

    const queueAgain = await registry.execute(
      'comms.draft.approveAndSend',
      { draftId: createdDraft!.id },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'test',
        isAutonomous: false,
        reason: 'Retry same send request',
      },
    );
    expect(queueAgain.status).toBe('EXECUTED');

    const approvalCountBeforeSend = await prisma.approvalRequest.count({
      where: { orgId },
    });
    expect(approvalCountBeforeSend).toBe(1);

    const approval = await prisma.approvalRequest.findFirst({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
    });
    expect(approval).not.toBeNull();

    await prisma.approvalRequest.update({
      where: { id: approval!.id },
      data: { status: 'APPROVED' },
    });

    const executed = await registry.executeApprovedRequest(approval!.id, {
      orgId,
      actorType: ActorType.HUMAN,
      actorUserId: userId,
      actorLabel: 'approval-test',
      isAutonomous: false,
    });
    expect(executed.status).toBe('EXECUTED');

    const refreshed = await prisma.outboundDraft.findUnique({
      where: { id: createdDraft!.id },
      select: { status: true, sentAt: true },
    });
    expect(refreshed?.status).toBe('SENT');
    expect(refreshed?.sentAt).not.toBeNull();

    const sentMessageCountBeforeRetry = await prisma.commsMessage.count({
      where: {
        orgId,
        threadId: thread.id,
        status: 'SENT',
      },
    });

    const retryAfterSend = await registry.execute(
      'comms.draft.approveAndSend',
      { draftId: createdDraft!.id },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'test',
        isAutonomous: false,
        reason: 'Retry after already sent',
      },
    );
    expect(retryAfterSend.status).toBe('EXECUTED');

    const sentMessageCountAfterRetry = await prisma.commsMessage.count({
      where: {
        orgId,
        threadId: thread.id,
        status: 'SENT',
      },
    });
    expect(sentMessageCountAfterRetry).toBe(sentMessageCountBeforeRetry);

    await prisma.orgSafetyState.update({
      where: { orgId },
      data: { mode: SafetyMode.FULL_STOP },
    });

    const blocked = await registry.execute(
      'comms.draft.approveAndSend',
      { draftId: createdDraft!.id },
      {
        orgId,
        actorType: ActorType.AGENT,
        actorUserId: userId,
        actorLabel: 'agent-test',
        isAutonomous: true,
        reason: 'autonomous send',
      },
    );
    expect(blocked.status).toBe('BLOCKED');
  });
});
