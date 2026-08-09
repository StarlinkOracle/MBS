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
    currentMode: 'AUTONOMY_OFF',
  },
} as const satisfies Prisma.InputJsonValue;

describeIfDb('kill switch tools', () => {
  const prisma = new PrismaClient();
  const registry = new ToolRegistry(prisma);

  let orgId = '';
  let humanUserId = '';
  let agentUserId = '';

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterEach(async () => {
    if (orgId) {
      await prisma.organization.delete({ where: { id: orgId } });
    }
    orgId = '';
    humanUserId = '';
    agentUserId = '';
  });

  async function setupFixture() {
    const suffix = randomUUID().slice(0, 8);

    const org = await prisma.organization.create({
      data: {
        name: `KillSwitch ${suffix}`,
        slug: `killswitch-${suffix}`,
      },
    });

    const [readPermission, writePermission] = await Promise.all([
      prisma.permission.upsert({
        where: { key: 'system:killswitch:read' },
        update: {},
        create: { key: 'system:killswitch:read', description: 'Read kill switch state' },
      }),
      prisma.permission.upsert({
        where: { key: 'system:killswitch:write' },
        update: {},
        create: { key: 'system:killswitch:write', description: 'Write kill switch state' },
      }),
    ]);

    const role = await prisma.role.create({
      data: {
        orgId: org.id,
        name: `ops-${suffix}`,
        isSystem: false,
      },
    });

    await prisma.rolePermission.createMany({
      data: [
        { roleId: role.id, permissionId: readPermission.id },
        { roleId: role.id, permissionId: writePermission.id },
      ],
    });

    const human = await prisma.user.create({
      data: {
        orgId: org.id,
        email: `human-${suffix}@example.com`,
        name: 'Human Operator',
        actorType: ActorType.HUMAN,
      },
    });

    const agent = await prisma.user.create({
      data: {
        orgId: org.id,
        email: `agent-${suffix}@example.com`,
        name: 'Automation Agent',
        actorType: ActorType.AGENT,
      },
    });

    await prisma.userRole.createMany({
      data: [
        { userId: human.id, roleId: role.id },
        { userId: agent.id, roleId: role.id },
      ],
    });

    await prisma.policy.create({
      data: {
        orgId: org.id,
        name: 'default-autonomy-policy',
        version: 1,
        isActive: true,
        policyJson,
        createdByUserId: human.id,
      },
    });

    await prisma.orgSafetyState.create({
      data: {
        orgId: org.id,
        mode: SafetyMode.NORMAL,
        reason: 'test start',
        updatedByUserId: human.id,
      },
    });

    await prisma.toolDefinition.createMany({
      data: [
        {
          orgId: org.id,
          name: 'system.killswitch.status',
          version: '1.0.0',
          description: 'Status',
          handlerKey: 'system.killswitch.status',
          active: true,
          riskLevel: RiskLevel.LOW,
          autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
          requiredPermissions: ['system:killswitch:read'],
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {},
          },
          endpointAllowsHumanOverride: false,
          requiresReason: false,
          requiresSnapshot: false,
        },
        {
          orgId: org.id,
          name: 'system.killswitch.set',
          version: '1.0.0',
          description: 'Set',
          handlerKey: 'system.killswitch.set',
          active: true,
          riskLevel: RiskLevel.CRITICAL,
          autonomyLevel: AutonomyLevel.NEVER_AUTONOMOUS,
          requiredPermissions: ['system:killswitch:write'],
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              mode: { type: 'string', enum: ['NORMAL', 'AUTONOMY_OFF', 'FULL_STOP'] },
              reason: { type: 'string' },
            },
            required: ['mode'],
          },
          endpointAllowsHumanOverride: true,
          requiresReason: false,
          requiresSnapshot: false,
        },
      ],
    });

    orgId = org.id;
    humanUserId = human.id;
    agentUserId = agent.id;
  }

  it('blocks autonomous calls to system.killswitch.set', async () => {
    await setupFixture();

    const result = await registry.execute(
      'system.killswitch.set',
      {
        mode: 'AUTONOMY_OFF',
        reason: 'autonomous should fail',
      },
      {
        orgId,
        actorType: ActorType.AGENT,
        actorUserId: agentUserId,
        actorLabel: 'agent',
        isAutonomous: true,
      },
    );

    expect(result.status).toBe('BLOCKED');
  });

  it('allows human calls to system.killswitch.set', async () => {
    await setupFixture();

    const result = await registry.execute(
      'system.killswitch.set',
      {
        mode: 'FULL_STOP',
        reason: 'manual intervention',
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: humanUserId,
        actorLabel: 'human',
        isAutonomous: false,
      },
    );

    expect(result.status).toBe('EXECUTED');

    const state = await prisma.orgSafetyState.findUnique({
      where: { orgId },
    });
    expect(state?.mode).toBe(SafetyMode.FULL_STOP);
  });
});
