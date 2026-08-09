import { randomUUID } from 'node:crypto';

import {
  ActorType,
  AgentRunStatus,
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

function buildPolicyJson(input?: {
  deny?: string[];
  denyIfAutonomous?: string[];
}): Prisma.InputJsonValue {
  return {
    version: 1,
    autonomy: {
      enabled: true,
      defaultMode: 'SAFE',
      maxRiskLevelAutonomous: 'HIGH',
      toolBlocks: {
        deny: input?.deny ?? [],
        denyIfAutonomous: input?.denyIfAutonomous ?? [],
        allowOnly: [],
      },
      timeWindows: [],
      rateLimits: {
        perRun: {
          maxToolCalls: 120,
          maxQueuedApprovals: 25,
          cooldownSecondsByRisk: {
            LOW: 0,
            MEDIUM: 5,
            HIGH: 30,
            CRITICAL: 999999,
          },
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
}

describeIfDb('agent steering governance', () => {
  const prisma = new PrismaClient();
  const registry = new ToolRegistry(prisma);

  let orgId = '';
  let humanUserId = '';

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterEach(async () => {
    if (orgId) {
      await prisma.organization.delete({ where: { id: orgId } });
    }

    orgId = '';
    humanUserId = '';
  });

  async function setupFixture(input?: {
    safetyMode?: SafetyMode;
    policyDeny?: string[];
  }) {
    const suffix = randomUUID().slice(0, 8);

    const org = await prisma.organization.create({
      data: {
        name: `Steering ${suffix}`,
        slug: `steering-${suffix}`,
      },
    });

    const permission = await prisma.permission.upsert({
      where: { key: 'reporting:*' },
      update: {},
      create: {
        key: 'reporting:*',
        description: 'Reporting access',
      },
    });

    const role = await prisma.role.create({
      data: {
        orgId: org.id,
        name: `ops-${suffix}`,
      },
    });

    await prisma.rolePermission.create({
      data: {
        roleId: role.id,
        permissionId: permission.id,
      },
    });

    const human = await prisma.user.create({
      data: {
        orgId: org.id,
        email: `ops-${suffix}@example.com`,
        name: 'Ops User',
        actorType: ActorType.HUMAN,
      },
    });

    await prisma.userRole.create({
      data: {
        userId: human.id,
        roleId: role.id,
      },
    });

    await prisma.policy.create({
      data: {
        orgId: org.id,
        name: 'default-autonomy-policy',
        version: 1,
        isActive: true,
        policyJson: buildPolicyJson({ deny: input?.policyDeny }),
        createdByUserId: human.id,
      },
    });

    await prisma.orgSafetyState.create({
      data: {
        orgId: org.id,
        mode: input?.safetyMode ?? SafetyMode.NORMAL,
        reason: 'test bootstrap',
        updatedByUserId: human.id,
      },
    });

    await prisma.toolDefinition.createMany({
      data: [
        {
          orgId: org.id,
          name: 'system.agent.run.start',
          version: '1.0.0',
          description: 'Start run',
          handlerKey: 'system.agent.run.start',
          active: true,
          riskLevel: RiskLevel.MEDIUM,
          autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
          requiredPermissions: ['reporting:*'],
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              goal: { type: 'string' },
              mode: { type: 'string' },
            },
            required: ['goal'],
          },
          requiresReason: false,
          requiresSnapshot: false,
          endpointAllowsHumanOverride: false,
        },
        {
          orgId: org.id,
          name: 'system.agent.run.suggest_skill',
          version: '1.0.0',
          description: 'Suggest skill',
          handlerKey: 'system.agent.run.suggest_skill',
          active: true,
          riskLevel: RiskLevel.LOW,
          autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
          requiredPermissions: ['reporting:*'],
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              agentRunId: { type: 'string' },
              skillId: { type: 'string' },
            },
            required: ['agentRunId', 'skillId'],
          },
          requiresReason: false,
          requiresSnapshot: false,
          endpointAllowsHumanOverride: false,
        },
        {
          orgId: org.id,
          name: 'crm.lead.score',
          version: '1.0.0',
          description: 'Score lead',
          handlerKey: 'crm.lead.score',
          active: true,
          riskLevel: RiskLevel.LOW,
          autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
          requiredPermissions: ['reporting:*'],
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              leadId: { type: 'string' },
              score: { type: 'integer' },
            },
            required: ['leadId', 'score'],
          },
          requiresReason: false,
          requiresSnapshot: false,
          endpointAllowsHumanOverride: false,
        },
      ],
    });

    orgId = org.id;
    humanUserId = human.id;
  }

  it('kill switch AUTONOMY_OFF blocks autonomous start', async () => {
    await setupFixture({ safetyMode: SafetyMode.AUTONOMY_OFF });

    const result = await registry.execute(
      'system.agent.run.start',
      {
        goal: 'Blocked start',
        mode: 'AUTO',
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: humanUserId,
        actorLabel: 'ops-user',
        isAutonomous: true,
      },
    );

    expect(result.status).toBe('BLOCKED');
    if (result.status === 'BLOCKED') {
      expect(result.reason).toContain('AUTONOMY_OFF');

      const execution = await prisma.toolExecution.findUnique({
        where: { id: result.executionId },
      });
      expect(execution?.status).toBe('BLOCKED');

      const outbox = await prisma.eventOutbox.findFirst({
        where: {
          orgId,
          eventType: 'tool.blocked',
          payload: {
            path: ['executionId'],
            equals: result.executionId,
          },
        },
      });
      expect(outbox).toBeTruthy();
    }
  });

  it('suggest-skill fails when target node is unreachable', async () => {
    await setupFixture();

    const run = await prisma.agentRun.create({
      data: {
        orgId,
        startedByUserId: humanUserId,
        goal: 'Reachability check',
        status: AgentRunStatus.RUNNING,
        currentSkillId: 'ingest_context',
        stateJson: {
          goal: 'Reachability check',
          contextBuilt: false,
        },
      },
    });

    const result = await registry.execute(
      'system.agent.run.suggest_skill',
      {
        agentRunId: run.id,
        skillId: 'billing_actions',
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: humanUserId,
        actorLabel: 'ops-user',
        isAutonomous: false,
      },
    );

    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.error).toContain('unreachable');

      const execution = await prisma.toolExecution.findUnique({
        where: { id: result.executionId },
      });
      expect(execution?.status).toBe('FAILED');

      const outbox = await prisma.eventOutbox.findFirst({
        where: {
          orgId,
          eventType: 'tool.failed',
          payload: {
            path: ['executionId'],
            equals: result.executionId,
          },
        },
      });
      expect(outbox).toBeTruthy();
    }
  });

  it('suggest-skill fails when policy blocks tools in target node', async () => {
    await setupFixture({ policyDeny: ['crm.lead.score'] });

    const run = await prisma.agentRun.create({
      data: {
        orgId,
        startedByUserId: humanUserId,
        goal: 'Policy gate check',
        status: AgentRunStatus.RUNNING,
        currentSkillId: 'ingest_context',
        stateJson: {
          goal: 'Policy gate check',
          contextBuilt: true,
        },
      },
    });

    const result = await registry.execute(
      'system.agent.run.suggest_skill',
      {
        agentRunId: run.id,
        skillId: 'qualify_leads',
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: humanUserId,
        actorLabel: 'ops-user',
        isAutonomous: false,
      },
    );

    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.error).toContain('blocks tool');
    }
  });
});
