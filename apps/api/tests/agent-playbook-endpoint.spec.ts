import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import supertest from 'supertest';

import {
  resetPlaybookExecutionInflightForTests,
  tryAcquirePlaybookExecutionSlot,
} from '../src/playbook-execution-guard.js';

let request: ReturnType<typeof supertest>;
let prisma: any;
let orgId = '';
let actorUserId = '';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('agent playbook execute endpoint guardrails', () => {
  beforeAll(async () => {
    const [{ app }, db] = await Promise.all([
      import('../src/index.js'),
      import('@rcs/db'),
    ]);
    request = supertest(app);
    prisma = db.prisma;

    const org = await prisma.organization.findUnique({
      where: { slug: 'russell-comfort' },
      select: { id: true },
    });
    if (!org) {
      throw new Error('Seed org russell-comfort is required');
    }
    orgId = org.id;

    const user = await prisma.user.create({
      data: {
        orgId,
        email: `agent-playbook-guard-${Date.now()}-${randomUUID().slice(0, 6)}@example.test`,
        name: 'Agent Playbook Guard Tester',
        actorType: 'HUMAN',
        isActive: true,
      },
      select: { id: true },
    });
    actorUserId = user.id;

    const adminRole = await prisma.role.findFirst({
      where: {
        orgId,
        name: 'admin',
      },
      select: { id: true },
    });
    if (!adminRole) {
      throw new Error('Seed role admin missing');
    }

    await prisma.userRole.create({
      data: {
        userId: actorUserId,
        roleId: adminRole.id,
      },
    });
  });

  afterAll(async () => {
    if (actorUserId) {
      await prisma.user.delete({
        where: { id: actorUserId },
      });
    }
    resetPlaybookExecutionInflightForTests();
  });

  it('rejects invalid packId patterns before execution', async () => {
    const response = await request
      .post('/api/agent/playbooks/execute')
      .set('x-org-slug', 'russell-comfort')
      .set('x-actor-user-id', actorUserId)
      .set('x-correlation-id', `corr-${randomUUID()}`)
      .send({
        packId: '../mbs_agent_v1_1',
        playbookStableId: 'contract_redline_review_v1_1',
        inputs: {},
      });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body?.error).toBe('Invalid payload');
    expect(response.body?.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'packId',
        }),
      ]),
    );
  });

  it('rejects execution when x-correlation-id is missing', async () => {
    const response = await request
      .post('/api/agent/playbooks/execute')
      .set('x-org-slug', 'russell-comfort')
      .set('x-actor-user-id', actorUserId)
      .send({
        playbookStableId: 'contract_redline_review_v1_1',
        inputs: {},
      });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body).toMatchObject({
      status: 'FAILED',
      error: {
        code: 'PLAYBOOK_CORRELATION_REQUIRED',
      },
    });
  });

  it('rejects execution when x-correlation-id format is invalid', async () => {
    const badCorrelation = 'bad value with spaces';
    const response = await request
      .post('/api/agent/playbooks/execute')
      .set('x-org-slug', 'russell-comfort')
      .set('x-actor-user-id', actorUserId)
      .set('x-correlation-id', badCorrelation)
      .send({
        playbookStableId: 'contract_redline_review_v1_1',
        inputs: {},
      });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body).toMatchObject({
      status: 'FAILED',
      error: {
        code: 'PLAYBOOK_CORRELATION_INVALID',
      },
    });
    expect(response.headers['x-correlation-id']).toMatch(/^[a-f0-9-]{36}$/);
    expect(response.headers['x-correlation-id']).not.toBe(badCorrelation);
  });

  it('returns deterministic PLAYBOOK_INPUT_TOO_LARGE when inputs exceed configured limit', async () => {
    const previousMax = process.env.AGENT_PLAYBOOK_MAX_INPUT_BYTES;
    process.env.AGENT_PLAYBOOK_MAX_INPUT_BYTES = '64';
    try {
      const response = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', actorUserId)
        .set('x-correlation-id', `corr-${randomUUID()}`)
        .send({
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {
            contractText: 'x'.repeat(512),
          },
        });

      expect(response.status, JSON.stringify(response.body)).toBe(413);
      expect(response.body).toMatchObject({
        status: 'FAILED',
        error: {
          code: 'PLAYBOOK_INPUT_TOO_LARGE',
        },
      });
    } finally {
      if (previousMax == null) {
        delete process.env.AGENT_PLAYBOOK_MAX_INPUT_BYTES;
      } else {
        process.env.AGENT_PLAYBOOK_MAX_INPUT_BYTES = previousMax;
      }
    }
  });

  it('returns deterministic PLAYBOOK_INPUT_SHAPE_INVALID when input depth exceeds configured limit', async () => {
    const previousMaxDepth = process.env.AGENT_PLAYBOOK_MAX_INPUT_DEPTH;
    process.env.AGENT_PLAYBOOK_MAX_INPUT_DEPTH = '2';
    try {
      const response = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', actorUserId)
        .set('x-correlation-id', `corr-${randomUUID()}`)
        .send({
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {
            level1: {
              level2: {
                level3: {
                  value: 'too-deep',
                },
              },
            },
          },
        });

      expect(response.status, JSON.stringify(response.body)).toBe(400);
      expect(response.body).toMatchObject({
        status: 'FAILED',
        error: {
          code: 'PLAYBOOK_INPUT_SHAPE_INVALID',
          details: {
            reason: 'MAX_DEPTH_EXCEEDED',
            maxDepth: 2,
          },
        },
      });
    } finally {
      if (previousMaxDepth == null) {
        delete process.env.AGENT_PLAYBOOK_MAX_INPUT_DEPTH;
      } else {
        process.env.AGENT_PLAYBOOK_MAX_INPUT_DEPTH = previousMaxDepth;
      }
    }
  });

  it('returns deterministic PLAYBOOK_INPUT_SHAPE_INVALID when input key count exceeds configured limit', async () => {
    const previousMaxKeys = process.env.AGENT_PLAYBOOK_MAX_INPUT_KEYS;
    process.env.AGENT_PLAYBOOK_MAX_INPUT_KEYS = '3';
    try {
      const response = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', actorUserId)
        .set('x-correlation-id', `corr-${randomUUID()}`)
        .send({
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {
            a: 1,
            b: 2,
            c: 3,
            d: 4,
          },
        });

      expect(response.status, JSON.stringify(response.body)).toBe(400);
      expect(response.body).toMatchObject({
        status: 'FAILED',
        error: {
          code: 'PLAYBOOK_INPUT_SHAPE_INVALID',
          details: {
            reason: 'MAX_KEYS_EXCEEDED',
            maxKeys: 3,
          },
        },
      });
    } finally {
      if (previousMaxKeys == null) {
        delete process.env.AGENT_PLAYBOOK_MAX_INPUT_KEYS;
      } else {
        process.env.AGENT_PLAYBOOK_MAX_INPUT_KEYS = previousMaxKeys;
      }
    }
  });

  it('returns deterministic pack-not-found error for unknown pack ids', async () => {
    const response = await request
      .post('/api/agent/playbooks/execute')
      .set('x-org-slug', 'russell-comfort')
      .set('x-actor-user-id', actorUserId)
      .set('x-correlation-id', `corr-${randomUUID()}`)
      .send({
        packId: 'mbs_agent_v9_9',
        playbookStableId: 'contract_redline_review_v1_1',
        inputs: {},
      });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body).toMatchObject({
      status: 'FAILED',
      error: {
        code: 'PLAYBOOK_PACK_NOT_FOUND',
      },
    });
  });

  it('returns deterministic PLAYBOOK_INFLIGHT_LIMIT_REACHED when execution slots are saturated', async () => {
    const previousMaxInflightGlobal = process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_GLOBAL;
    const previousMaxInflightPerOrg = process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ORG;
    process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_GLOBAL = '1';
    process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ORG = '1';
    const occupied = tryAcquirePlaybookExecutionSlot({
      orgId,
      maxGlobal: 1,
      maxPerOrg: 1,
    });
    expect(occupied).not.toBeNull();

    try {
      const response = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', actorUserId)
        .set('x-correlation-id', `corr-${randomUUID()}`)
        .send({
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {},
        });

      expect(response.status, JSON.stringify(response.body)).toBe(503);
      expect(response.body).toMatchObject({
        status: 'FAILED',
        error: {
          code: 'PLAYBOOK_INFLIGHT_LIMIT_REACHED',
        },
      });
      expect(response.headers['retry-after']).toBe('1');
    } finally {
      occupied?.release();
      resetPlaybookExecutionInflightForTests();
      if (previousMaxInflightGlobal == null) {
        delete process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_GLOBAL;
      } else {
        process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_GLOBAL = previousMaxInflightGlobal;
      }
      if (previousMaxInflightPerOrg == null) {
        delete process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ORG;
      } else {
        process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ORG = previousMaxInflightPerOrg;
      }
    }
  });

  it('returns deterministic PLAYBOOK_INFLIGHT_LIMIT_REACHED when actor-level inflight cap is saturated', async () => {
    const previousMaxInflightGlobal = process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_GLOBAL;
    const previousMaxInflightPerOrg = process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ORG;
    const previousMaxInflightPerActor = process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ACTOR;
    process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_GLOBAL = '10';
    process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ORG = '10';
    process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ACTOR = '1';
    const occupied = tryAcquirePlaybookExecutionSlot({
      orgId,
      actorUserId,
      maxGlobal: 10,
      maxPerOrg: 10,
      maxPerActor: 1,
    });
    expect(occupied).not.toBeNull();

    try {
      const response = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', actorUserId)
        .set('x-correlation-id', `corr-${randomUUID()}`)
        .send({
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {},
        });

      expect(response.status, JSON.stringify(response.body)).toBe(503);
      expect(response.body).toMatchObject({
        status: 'FAILED',
        error: {
          code: 'PLAYBOOK_INFLIGHT_LIMIT_REACHED',
          details: {
            maxInflightPerActor: 1,
            inflightForActor: 1,
          },
        },
      });
      expect(response.headers['retry-after']).toBe('1');
    } finally {
      occupied?.release();
      resetPlaybookExecutionInflightForTests();
      if (previousMaxInflightGlobal == null) {
        delete process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_GLOBAL;
      } else {
        process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_GLOBAL = previousMaxInflightGlobal;
      }
      if (previousMaxInflightPerOrg == null) {
        delete process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ORG;
      } else {
        process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ORG = previousMaxInflightPerOrg;
      }
      if (previousMaxInflightPerActor == null) {
        delete process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ACTOR;
      } else {
        process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ACTOR = previousMaxInflightPerActor;
      }
    }
  });

  it('returns deterministic PLAYBOOK_DUPLICATE_INFLIGHT for same correlation/playbook while in-flight', async () => {
    const correlationId = `corr-${randomUUID()}`;
    const requestKey = [
      orgId,
      actorUserId,
      'mbs_agent_v1_1',
      'contract_redline_review_v1_1',
      correlationId,
    ].join(':');
    const occupied = tryAcquirePlaybookExecutionSlot({
      orgId,
      actorUserId,
      requestKey,
      maxGlobal: 10,
      maxPerOrg: 10,
      maxPerActor: 10,
    });
    expect(occupied).not.toBeNull();

    try {
      const response = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', actorUserId)
        .set('x-correlation-id', correlationId)
        .send({
          packId: 'mbs_agent_v1_1',
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {},
        });

      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body).toMatchObject({
        status: 'FAILED',
        error: {
          code: 'PLAYBOOK_DUPLICATE_INFLIGHT',
          recoverable: true,
          retryAfterSeconds: 1,
          details: {
            playbookStableId: 'contract_redline_review_v1_1',
            correlationId,
          },
        },
      });
      expect(response.headers['retry-after']).toBe('1');
    } finally {
      occupied?.release();
      resetPlaybookExecutionInflightForTests();
    }
  });

  it('returns deterministic PLAYBOOK_NOT_FOUND for unknown playbook id', async () => {
    const response = await request
      .post('/api/agent/playbooks/execute')
      .set('x-org-slug', 'russell-comfort')
      .set('x-actor-user-id', actorUserId)
      .set('x-correlation-id', `corr-${randomUUID()}`)
      .send({
        packId: 'mbs_agent_v1_1',
        playbookStableId: 'unknown_playbook_v9',
        inputs: {},
      });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body).toMatchObject({
      status: 'FAILED',
      error: {
        code: 'PLAYBOOK_NOT_FOUND',
      },
    });
  });

  it('enforces configured max-step ceiling and fails deterministically when exceeded', async () => {
    const previousMaxSteps = process.env.AGENT_PLAYBOOK_MAX_STEPS;
    process.env.AGENT_PLAYBOOK_MAX_STEPS = '1';
    try {
      const response = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', actorUserId)
        .set('x-correlation-id', `corr-${randomUUID()}`)
        .send({
          packId: 'mbs_agent_v1_1',
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {},
        });

      expect(response.status, JSON.stringify(response.body)).toBe(400);
      expect(response.body).toMatchObject({
        status: 'FAILED',
        error: {
          code: 'PLAYBOOK_MAX_STEPS_EXCEEDED',
        },
      });
    } finally {
      if (previousMaxSteps == null) {
        delete process.env.AGENT_PLAYBOOK_MAX_STEPS;
      } else {
        process.env.AGENT_PLAYBOOK_MAX_STEPS = previousMaxSteps;
      }
    }
  });

  it('returns deterministic PLAYBOOK_STEP_PAYLOAD_TOO_LARGE as 413', async () => {
    const previousMaxStepPayloadBytes = process.env.AGENT_PLAYBOOK_MAX_STEP_PAYLOAD_BYTES;
    process.env.AGENT_PLAYBOOK_MAX_STEP_PAYLOAD_BYTES = '128';
    try {
      const response = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', actorUserId)
        .set('x-correlation-id', `corr-${randomUUID()}`)
        .send({
          packId: 'mbs_agent_v1_1',
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {
            contractId: 'ctr_payload_limit',
            largeBlob: 'x'.repeat(4096),
          },
        });

      expect(response.status, JSON.stringify(response.body)).toBe(413);
      expect(response.body).toMatchObject({
        status: 'FAILED',
        error: {
          code: 'PLAYBOOK_STEP_PAYLOAD_TOO_LARGE',
        },
      });
    } finally {
      if (previousMaxStepPayloadBytes == null) {
        delete process.env.AGENT_PLAYBOOK_MAX_STEP_PAYLOAD_BYTES;
      } else {
        process.env.AGENT_PLAYBOOK_MAX_STEP_PAYLOAD_BYTES = previousMaxStepPayloadBytes;
      }
    }
  });

  it('returns deterministic PLAYBOOK_STEP_PAYLOAD_SHAPE_INVALID as 400', async () => {
    const previousMaxStepPayloadDepth = process.env.AGENT_PLAYBOOK_MAX_STEP_PAYLOAD_DEPTH;
    process.env.AGENT_PLAYBOOK_MAX_STEP_PAYLOAD_DEPTH = '4';
    try {
      const response = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', actorUserId)
        .set('x-correlation-id', `corr-${randomUUID()}`)
        .send({
          packId: 'mbs_agent_v1_1',
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {
            contractId: 'ctr_payload_shape',
            nested: { a: { b: { c: { d: { e: true } } } } },
          },
        });

      expect(response.status, JSON.stringify(response.body)).toBe(400);
      expect(response.body).toMatchObject({
        status: 'FAILED',
        error: {
          code: 'PLAYBOOK_STEP_PAYLOAD_SHAPE_INVALID',
          details: {
            reason: 'MAX_DEPTH_EXCEEDED',
          },
        },
      });
    } finally {
      if (previousMaxStepPayloadDepth == null) {
        delete process.env.AGENT_PLAYBOOK_MAX_STEP_PAYLOAD_DEPTH;
      } else {
        process.env.AGENT_PLAYBOOK_MAX_STEP_PAYLOAD_DEPTH = previousMaxStepPayloadDepth;
      }
    }
  });

  it('sanitizes invalid non-positive step limits to safe defaults', async () => {
    const previousMaxSteps = process.env.AGENT_PLAYBOOK_MAX_STEPS;
    process.env.AGENT_PLAYBOOK_MAX_STEPS = '-5';
    try {
      const response = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', actorUserId)
        .set('x-correlation-id', `corr-${randomUUID()}`)
        .send({
          packId: 'mbs_agent_v1_1',
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {},
        });

      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body?.status).toBe('BLOCKED');
      expect(response.body?.error?.code).toBe('PLAYBOOK_STEP_BLOCKED');
      expect(response.body?.error?.code).not.toBe('PLAYBOOK_MAX_STEPS_EXCEEDED');
      expect(Array.isArray(response.body?.executedSteps)).toBe(true);
      expect((response.body?.executedSteps ?? []).length).toBeGreaterThan(0);
    } finally {
      if (previousMaxSteps == null) {
        delete process.env.AGENT_PLAYBOOK_MAX_STEPS;
      } else {
        process.env.AGENT_PLAYBOOK_MAX_STEPS = previousMaxSteps;
      }
    }
  });

  it('returns deterministic PLAYBOOK_REQUEST_TIMEOUT when request-level timeout budget is exceeded', async () => {
    const previousRequestTimeout = process.env.AGENT_PLAYBOOK_REQUEST_TIMEOUT_MS;
    const previousMaxInflightGlobal = process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_GLOBAL;
    const previousMaxInflightPerOrg = process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ORG;
    const previousRateLimitMax = process.env.AGENT_PLAYBOOK_RATE_LIMIT_MAX;
    const previousRateLimitWindow = process.env.AGENT_PLAYBOOK_RATE_LIMIT_WINDOW_MS;
    process.env.AGENT_PLAYBOOK_REQUEST_TIMEOUT_MS = '1';
    process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_GLOBAL = '1';
    process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ORG = '1';
    process.env.AGENT_PLAYBOOK_RATE_LIMIT_MAX = '100';
    process.env.AGENT_PLAYBOOK_RATE_LIMIT_WINDOW_MS = '60000';
    resetPlaybookExecutionInflightForTests();
    try {
      const response = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', actorUserId)
        .set('x-correlation-id', `corr-${randomUUID()}`)
        .set('x-forwarded-for', '10.55.0.21')
        .send({
          packId: 'mbs_agent_v1_1',
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {},
        });

      expect(response.status, JSON.stringify(response.body)).toBe(504);
      expect(response.body).toMatchObject({
        status: 'FAILED',
        error: {
          code: 'PLAYBOOK_REQUEST_TIMEOUT',
          recoverable: true,
          timeoutMs: 1,
        },
      });

      const second = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', actorUserId)
        .set('x-correlation-id', `corr-${randomUUID()}`)
        .set('x-forwarded-for', '10.55.0.22')
        .send({
          packId: 'mbs_agent_v1_1',
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {},
        });
      expect(second.status, JSON.stringify(second.body)).toBe(504);
      expect(second.body?.error?.code).toBe('PLAYBOOK_REQUEST_TIMEOUT');
    } finally {
      resetPlaybookExecutionInflightForTests();
      if (previousRequestTimeout == null) {
        delete process.env.AGENT_PLAYBOOK_REQUEST_TIMEOUT_MS;
      } else {
        process.env.AGENT_PLAYBOOK_REQUEST_TIMEOUT_MS = previousRequestTimeout;
      }
      if (previousMaxInflightGlobal == null) {
        delete process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_GLOBAL;
      } else {
        process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_GLOBAL = previousMaxInflightGlobal;
      }
      if (previousMaxInflightPerOrg == null) {
        delete process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ORG;
      } else {
        process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ORG = previousMaxInflightPerOrg;
      }
      if (previousRateLimitMax == null) {
        delete process.env.AGENT_PLAYBOOK_RATE_LIMIT_MAX;
      } else {
        process.env.AGENT_PLAYBOOK_RATE_LIMIT_MAX = previousRateLimitMax;
      }
      if (previousRateLimitWindow == null) {
        delete process.env.AGENT_PLAYBOOK_RATE_LIMIT_WINDOW_MS;
      } else {
        process.env.AGENT_PLAYBOOK_RATE_LIMIT_WINDOW_MS = previousRateLimitWindow;
      }
    }
  });

  it('returns deterministic PLAYBOOK_STEP_TIMEOUT as timeout-class API failure', async () => {
    const previousStepTimeout = process.env.AGENT_PLAYBOOK_MAX_STEP_EXECUTION_MS;
    const previousRequestTimeout = process.env.AGENT_PLAYBOOK_REQUEST_TIMEOUT_MS;
    process.env.AGENT_PLAYBOOK_MAX_STEP_EXECUTION_MS = '1';
    process.env.AGENT_PLAYBOOK_REQUEST_TIMEOUT_MS = '10000';
    try {
      const response = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', actorUserId)
        .set('x-correlation-id', `corr-${randomUUID()}`)
        .send({
          packId: 'mbs_agent_v1_1',
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {},
        });

      expect(response.status, JSON.stringify(response.body)).toBe(504);
      expect(response.body).toMatchObject({
        status: 'FAILED',
        error: {
          code: 'PLAYBOOK_STEP_TIMEOUT',
          recoverable: true,
        },
      });
    } finally {
      if (previousStepTimeout == null) {
        delete process.env.AGENT_PLAYBOOK_MAX_STEP_EXECUTION_MS;
      } else {
        process.env.AGENT_PLAYBOOK_MAX_STEP_EXECUTION_MS = previousStepTimeout;
      }
      if (previousRequestTimeout == null) {
        delete process.env.AGENT_PLAYBOOK_REQUEST_TIMEOUT_MS;
      } else {
        process.env.AGENT_PLAYBOOK_REQUEST_TIMEOUT_MS = previousRequestTimeout;
      }
    }
  });

  it('rate limits repeated playbook executions per actor and source IP', async () => {
    const previousLimit = process.env.AGENT_PLAYBOOK_RATE_LIMIT_MAX;
    const previousWindow = process.env.AGENT_PLAYBOOK_RATE_LIMIT_WINDOW_MS;
    process.env.AGENT_PLAYBOOK_RATE_LIMIT_MAX = '1';
    process.env.AGENT_PLAYBOOK_RATE_LIMIT_WINDOW_MS = '60000';

    try {
      const first = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', actorUserId)
        .set('x-correlation-id', `corr-${randomUUID()}`)
        .set('x-forwarded-for', '10.55.0.11')
        .send({
          packId: 'mbs_agent_v1_1',
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {},
        });
      expect(first.status, JSON.stringify(first.body)).not.toBe(429);

      const second = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', actorUserId)
        .set('x-correlation-id', `corr-${randomUUID()}`)
        .set('x-forwarded-for', '10.55.0.11')
        .send({
          packId: 'mbs_agent_v1_1',
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {},
        });
      expect(second.status, JSON.stringify(second.body)).toBe(429);
      expect(second.body).toMatchObject({
        status: 'FAILED',
        error: {
          code: 'PLAYBOOK_RATE_LIMITED',
          recoverable: true,
          retryAfterSeconds: 60,
        },
      });
      expect(second.header['retry-after']).toBe('60');
    } finally {
      if (previousLimit == null) {
        delete process.env.AGENT_PLAYBOOK_RATE_LIMIT_MAX;
      } else {
        process.env.AGENT_PLAYBOOK_RATE_LIMIT_MAX = previousLimit;
      }
      if (previousWindow == null) {
        delete process.env.AGENT_PLAYBOOK_RATE_LIMIT_WINDOW_MS;
      } else {
        process.env.AGENT_PLAYBOOK_RATE_LIMIT_WINDOW_MS = previousWindow;
      }
    }
  });

  it('fails closed when configured governance issue keys are active', async () => {
    const previousFailClosedEnabled = process.env.AGENT_PLAYBOOK_FAIL_CLOSED_ENABLED;
    const previousFailClosedIssueKeys = process.env.AGENT_PLAYBOOK_FAIL_CLOSED_ISSUE_KEYS;
    const previousFailClosedOnCritical = process.env.AGENT_PLAYBOOK_FAIL_CLOSED_ON_CRITICAL;
    const previousFailClosedTimeoutMs = process.env.AGENT_PLAYBOOK_FAIL_CLOSED_TIMEOUT_MS;
    const previousJwtSecret = process.env.JWT_SECRET;

    process.env.AGENT_PLAYBOOK_FAIL_CLOSED_ENABLED = 'true';
    process.env.AGENT_PLAYBOOK_FAIL_CLOSED_ISSUE_KEYS = 'auth_jwt_secret_insecure';
    process.env.AGENT_PLAYBOOK_FAIL_CLOSED_ON_CRITICAL = 'false';
    process.env.AGENT_PLAYBOOK_FAIL_CLOSED_TIMEOUT_MS = '5000';
    process.env.JWT_SECRET = 'change-me';

    try {
      const response = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', actorUserId)
        .set('x-correlation-id', `corr-${randomUUID()}`)
        .send({
          packId: 'mbs_agent_v1_1',
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {},
        });

      expect(response.status, JSON.stringify(response.body)).toBe(503);
      expect(response.body).toMatchObject({
        status: 'FAILED',
        error: {
          code: 'PLAYBOOK_FAIL_CLOSED',
          details: {
            blockedIssueKeys: ['auth_jwt_secret_insecure'],
          },
        },
      });
    } finally {
      if (previousFailClosedEnabled == null) {
        delete process.env.AGENT_PLAYBOOK_FAIL_CLOSED_ENABLED;
      } else {
        process.env.AGENT_PLAYBOOK_FAIL_CLOSED_ENABLED = previousFailClosedEnabled;
      }
      if (previousFailClosedIssueKeys == null) {
        delete process.env.AGENT_PLAYBOOK_FAIL_CLOSED_ISSUE_KEYS;
      } else {
        process.env.AGENT_PLAYBOOK_FAIL_CLOSED_ISSUE_KEYS = previousFailClosedIssueKeys;
      }
      if (previousFailClosedOnCritical == null) {
        delete process.env.AGENT_PLAYBOOK_FAIL_CLOSED_ON_CRITICAL;
      } else {
        process.env.AGENT_PLAYBOOK_FAIL_CLOSED_ON_CRITICAL = previousFailClosedOnCritical;
      }
      if (previousFailClosedTimeoutMs == null) {
        delete process.env.AGENT_PLAYBOOK_FAIL_CLOSED_TIMEOUT_MS;
      } else {
        process.env.AGENT_PLAYBOOK_FAIL_CLOSED_TIMEOUT_MS = previousFailClosedTimeoutMs;
      }
      if (previousJwtSecret == null) {
        delete process.env.JWT_SECRET;
      } else {
        process.env.JWT_SECRET = previousJwtSecret;
      }
    }
  });
});
