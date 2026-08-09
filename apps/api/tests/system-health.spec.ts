import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import supertest from 'supertest';
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  writeFile,
  mkdir,
  rm,
  utimes,
} from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

import {
  resetPlaybookExecutionInflightForTests,
  tryAcquirePlaybookExecutionSlot,
} from '../src/playbook-execution-guard.js';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('system health endpoints', () => {
  let request: ReturnType<typeof supertest>;
  let prisma: any;
  let orgId = '';
  let adminUserId = '';
  let techUserId = '';

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

    const admin = await prisma.user.findFirst({
      where: {
        orgId,
        email: 'admin@russellcomfort.com',
        isActive: true,
      },
      select: { id: true },
    });
    if (!admin) {
      throw new Error('Seed admin user is required');
    }
    adminUserId = admin.id;

    const techRole = await prisma.role.findFirst({
      where: {
        orgId,
        name: 'tech',
      },
      select: { id: true },
    });
    if (!techRole) {
      throw new Error('Seed tech role missing');
    }

    const techUser = await prisma.user.create({
      data: {
        orgId,
        email: `health-tech-${Date.now()}@example.test`,
        name: 'Health Tech',
        actorType: 'HUMAN',
        isActive: true,
      },
      select: { id: true },
    });
    techUserId = techUser.id;

    await prisma.userRole.create({
      data: {
        userId: techUserId,
        roleId: techRole.id,
      },
    });
  });

  afterAll(async () => {
    if (techUserId) {
      await prisma.user.delete({ where: { id: techUserId } });
    }
  });

  it('returns combined live and snapshot health payload', async () => {
    const response = await request
      .get('/api/system/health')
      .set('x-org-slug', 'russell-comfort')
      .set('x-actor-user-id', adminUserId);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(typeof response.body.status).toBe('string');
    expect(typeof response.body.metrics?.pendingOutbox).toBe('number');
    expect(typeof response.body.metrics?.failedOutbox).toBe('number');
    expect(typeof response.body.metrics?.pendingApprovals).toBe('number');
    expect(typeof response.body.metrics?.backupChecksumState).toBe('string');
    expect(typeof response.body.metrics?.rateLimitedMobileLogin1h).toBe('number');
    expect(Object.prototype.hasOwnProperty.call(response.body.metrics ?? {}, 'loadSmokeStatus')).toBe(true);
    expect(Array.isArray(response.body.issues)).toBe(true);
    expect(Array.isArray(response.body.recommendedActions)).toBe(true);
    expect(typeof response.body.snapshotThresholds?.maxSnapshotAgeMinutes).toBe('number');
    expect(typeof response.body.live?.status).toBe('string');
  });

  it('returns readiness gate status and enforces strict mode', async () => {
    const previousJwtSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'change-me';

    try {
      const strict = await request
        .get('/api/system/readiness?mode=strict')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect(strict.status, JSON.stringify(strict.body)).toBe(503);
      expect(strict.body?.ready).toBe(false);
      expect(strict.body?.mode).toBe('strict');
      expect(Array.isArray(strict.body?.issueKeys)).toBe(true);
      expect(strict.body?.issueKeys).toContain('auth_jwt_secret_insecure');

      const criticalOnly = await request
        .get('/api/system/readiness?mode=critical')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect([200, 503]).toContain(criticalOnly.status);
      expect(typeof criticalOnly.body?.ready).toBe('boolean');
      expect(criticalOnly.body?.mode).toBe('critical');
    } finally {
      if (previousJwtSecret == null) {
        delete process.env.JWT_SECRET;
      } else {
        process.env.JWT_SECRET = previousJwtSecret;
      }
    }
  });

  it('returns structured timeout when health request exceeds configured timeout budget', async () => {
    const previousTimeout = process.env.SYSTEM_HEALTH_REQUEST_TIMEOUT_MS;
    process.env.SYSTEM_HEALTH_REQUEST_TIMEOUT_MS = '1';

    try {
      const response = await request
        .get('/api/system/health')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect(response.status, JSON.stringify(response.body)).toBe(504);
      expect(response.body?.error?.code).toBe('SYSTEM_HEALTH_TIMEOUT');
      expect(response.body?.error?.recoverable).toBe(true);
      expect(response.body?.error?.timeoutMs).toBe(1);
    } finally {
      if (previousTimeout == null) {
        delete process.env.SYSTEM_HEALTH_REQUEST_TIMEOUT_MS;
      } else {
        process.env.SYSTEM_HEALTH_REQUEST_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  it('flags insecure JWT secret configuration in health issues', async () => {
    const previousJwtSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'change-me';
    try {
      const response = await request
        .get('/api/system/health')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const issues = Array.isArray(response.body.issues) ? response.body.issues : [];
      const keys = issues
        .map((issue: any) => issue?.key)
        .filter((key: any) => typeof key === 'string');
      expect(keys).toContain('auth_jwt_secret_insecure');

      const recommendationKeys = Array.isArray(response.body.recommendedActions)
        ? response.body.recommendedActions
            .map((action: any) => action?.key)
            .filter((key: any) => typeof key === 'string')
        : [];
      expect(recommendationKeys).toContain('auth_jwt_secret_insecure');
    } finally {
      if (previousJwtSecret == null) {
        delete process.env.JWT_SECRET;
      } else {
        process.env.JWT_SECRET = previousJwtSecret;
      }
    }
  });

  it('tracks mobile login rate-limit pressure in health metrics and issues', async () => {
    const previousRateLimitMax = process.env.MOBILE_PIN_RATE_LIMIT_MAX;
    const previousRateLimitWindow = process.env.MOBILE_PIN_RATE_LIMIT_WINDOW_MS;
    const previousHealthThreshold = process.env.HEALTH_MAX_RATE_LIMITED_MOBILE_LOGIN_1H;

    process.env.MOBILE_PIN_RATE_LIMIT_MAX = '1';
    process.env.MOBILE_PIN_RATE_LIMIT_WINDOW_MS = '60000';
    process.env.HEALTH_MAX_RATE_LIMITED_MOBILE_LOGIN_1H = '1';

    const identifier = `health-rate-limit-${Date.now()}@example.test`;
    const payload = {
      orgSlug: 'missing-org',
      identifier,
      pin: '1234',
      deviceId: `device-${Date.now()}`,
      deviceName: 'health-test-device',
    };

    try {
      const first = await request
        .post('/api/auth/mobile/pin/login')
        .set('x-forwarded-for', '10.0.0.250')
        .send(payload);
      expect([401, 429]).toContain(first.status);

      const second = await request
        .post('/api/auth/mobile/pin/login')
        .set('x-forwarded-for', '10.0.0.250')
        .send(payload);
      expect(second.status).toBe(429);

      const third = await request
        .post('/api/auth/mobile/pin/login')
        .set('x-forwarded-for', '10.0.0.250')
        .send(payload);
      expect(third.status).toBe(429);

      const health = await request
        .get('/api/system/health')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect(health.status, JSON.stringify(health.body)).toBe(200);
      expect(Number(health.body.metrics?.rateLimitedMobileLogin1h ?? 0)).toBeGreaterThanOrEqual(2);

      const keys = Array.isArray(health.body.issues)
        ? health.body.issues
            .map((issue: any) => issue?.key)
            .filter((key: any) => typeof key === 'string')
        : [];
      expect(keys).toContain('mobile_login_rate_limited_high');

      const recommendationKeys = Array.isArray(health.body.recommendedActions)
        ? health.body.recommendedActions
            .map((action: any) => action?.key)
            .filter((key: any) => typeof key === 'string')
        : [];
      expect(recommendationKeys).toContain('mobile_login_rate_limited_high');
    } finally {
      if (previousRateLimitMax == null) {
        delete process.env.MOBILE_PIN_RATE_LIMIT_MAX;
      } else {
        process.env.MOBILE_PIN_RATE_LIMIT_MAX = previousRateLimitMax;
      }
      if (previousRateLimitWindow == null) {
        delete process.env.MOBILE_PIN_RATE_LIMIT_WINDOW_MS;
      } else {
        process.env.MOBILE_PIN_RATE_LIMIT_WINDOW_MS = previousRateLimitWindow;
      }
      if (previousHealthThreshold == null) {
        delete process.env.HEALTH_MAX_RATE_LIMITED_MOBILE_LOGIN_1H;
      } else {
        process.env.HEALTH_MAX_RATE_LIMITED_MOBILE_LOGIN_1H = previousHealthThreshold;
      }
    }
  });

  it('tracks mobile sync payload rejection pressure in health metrics and issues', async () => {
    const previousHealthThreshold = process.env.HEALTH_MAX_MOBILE_SYNC_PAYLOAD_REJECTED_1H;
    const previousPayloadLimit = process.env.MOBILE_SYNC_ACTION_MAX_PAYLOAD_BYTES;
    const previousPushRateLimitMax = process.env.MOBILE_SYNC_PUSH_RATE_LIMIT_MAX;
    const previousPushRateLimitWindow = process.env.MOBILE_SYNC_PUSH_RATE_LIMIT_WINDOW_MS;

    process.env.HEALTH_MAX_MOBILE_SYNC_PAYLOAD_REJECTED_1H = '1';
    process.env.MOBILE_SYNC_ACTION_MAX_PAYLOAD_BYTES = '128';
    process.env.MOBILE_SYNC_PUSH_RATE_LIMIT_MAX = '100';
    process.env.MOBILE_SYNC_PUSH_RATE_LIMIT_WINDOW_MS = '60000';

    const deviceId = `health-mobile-payload-${Date.now()}`;
    const pin = '1234';

    try {
      const setPin = await request
        .post(`/api/admin/users/${adminUserId}/pin/set`)
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId)
        .send({
          newPin: pin,
          reason: 'Health payload rejection test',
        });
      expect(setPin.status, JSON.stringify(setPin.body)).toBe(200);

      const login = await request
        .post('/api/auth/mobile/pin/login')
        .send({
          orgSlug: 'russell-comfort',
          identifier: 'admin@russellcomfort.com',
          pin,
          deviceId,
          deviceName: 'health-mobile-payload-test',
        });
      expect(login.status, JSON.stringify(login.body)).toBe(200);
      const accessToken = login.body?.accessToken as string;
      expect(typeof accessToken).toBe('string');
      expect(accessToken.length).toBeGreaterThan(10);

      const rejectedOne = await request
        .post('/api/mobile/sync/push')
        .set('authorization', `Bearer ${accessToken}`)
        .send({
          deviceId,
          actions: [
            {
              clientActionId: randomUUID(),
              toolName: 'time.clockIn',
              payload: { largeBlob: 'x'.repeat(2048) },
            },
          ],
        });
      expect(rejectedOne.status, JSON.stringify(rejectedOne.body)).toBe(413);
      expect(rejectedOne.body?.error?.code).toBe('MOBILE_SYNC_PAYLOAD_TOO_LARGE');

      const rejectedTwo = await request
        .post('/api/mobile/sync/push')
        .set('authorization', `Bearer ${accessToken}`)
        .send({
          deviceId,
          actions: [
            {
              clientActionId: randomUUID(),
              toolName: 'time.clockIn',
              payload: { largeBlob: 'y'.repeat(2048) },
            },
          ],
        });
      expect(rejectedTwo.status, JSON.stringify(rejectedTwo.body)).toBe(413);
      expect(rejectedTwo.body?.error?.code).toBe('MOBILE_SYNC_PAYLOAD_TOO_LARGE');

      const health = await request
        .get('/api/system/health')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect(health.status, JSON.stringify(health.body)).toBe(200);
      expect(Number(health.body.metrics?.mobileSyncPayloadRejected1h ?? 0)).toBeGreaterThanOrEqual(2);

      const keys = Array.isArray(health.body.issues)
        ? health.body.issues
          .map((issue: { key?: unknown }) => issue?.key)
          .filter((key: unknown): key is string => typeof key === 'string')
        : [];
      expect(keys).toContain('mobile_sync_payload_rejected_high');

      const recommendationKeys = Array.isArray(health.body.recommendedActions)
        ? health.body.recommendedActions
          .map((action: { key?: unknown }) => action?.key)
          .filter((key: unknown): key is string => typeof key === 'string')
        : [];
      expect(recommendationKeys).toContain('mobile_sync_payload_rejected_high');
    } finally {
      if (previousHealthThreshold == null) {
        delete process.env.HEALTH_MAX_MOBILE_SYNC_PAYLOAD_REJECTED_1H;
      } else {
        process.env.HEALTH_MAX_MOBILE_SYNC_PAYLOAD_REJECTED_1H = previousHealthThreshold;
      }
      if (previousPayloadLimit == null) {
        delete process.env.MOBILE_SYNC_ACTION_MAX_PAYLOAD_BYTES;
      } else {
        process.env.MOBILE_SYNC_ACTION_MAX_PAYLOAD_BYTES = previousPayloadLimit;
      }
      if (previousPushRateLimitMax == null) {
        delete process.env.MOBILE_SYNC_PUSH_RATE_LIMIT_MAX;
      } else {
        process.env.MOBILE_SYNC_PUSH_RATE_LIMIT_MAX = previousPushRateLimitMax;
      }
      if (previousPushRateLimitWindow == null) {
        delete process.env.MOBILE_SYNC_PUSH_RATE_LIMIT_WINDOW_MS;
      } else {
        process.env.MOBILE_SYNC_PUSH_RATE_LIMIT_WINDOW_MS = previousPushRateLimitWindow;
      }
    }
  });

  it('tracks agent playbook rate-limit pressure in health metrics and issues', async () => {
    const previousRateLimitMax = process.env.AGENT_PLAYBOOK_RATE_LIMIT_MAX;
    const previousRateLimitWindow = process.env.AGENT_PLAYBOOK_RATE_LIMIT_WINDOW_MS;
    const previousHealthThreshold = process.env.HEALTH_MAX_RATE_LIMITED_AGENT_PLAYBOOK_1H;

    process.env.AGENT_PLAYBOOK_RATE_LIMIT_MAX = '1';
    process.env.AGENT_PLAYBOOK_RATE_LIMIT_WINDOW_MS = '60000';
    process.env.HEALTH_MAX_RATE_LIMITED_AGENT_PLAYBOOK_1H = '1';

    try {
      const first = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId)
        .set('x-correlation-id', `corr-${Date.now()}-1`)
        .set('x-forwarded-for', '10.10.44.1')
        .send({
          packId: 'mbs_agent_v1_1',
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {},
        });
      expect([200, 202, 400, 409]).toContain(first.status);

      const second = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId)
        .set('x-correlation-id', `corr-${Date.now()}-2`)
        .set('x-forwarded-for', '10.10.44.1')
        .send({
          packId: 'mbs_agent_v1_1',
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {},
        });
      expect(second.status).toBe(429);

      const third = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId)
        .set('x-correlation-id', `corr-${Date.now()}-3`)
        .set('x-forwarded-for', '10.10.44.1')
        .send({
          packId: 'mbs_agent_v1_1',
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {},
        });
      expect(third.status).toBe(429);

      const health = await request
        .get('/api/system/health')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect(health.status, JSON.stringify(health.body)).toBe(200);
      expect(Number(health.body.metrics?.rateLimitedAgentPlaybook1h ?? 0)).toBeGreaterThanOrEqual(2);

      const keys = Array.isArray(health.body.issues)
        ? health.body.issues
            .map((issue: any) => issue?.key)
            .filter((key: any) => typeof key === 'string')
        : [];
      expect(keys).toContain('agent_playbook_rate_limited_high');

      const recommendationKeys = Array.isArray(health.body.recommendedActions)
        ? health.body.recommendedActions
            .map((action: any) => action?.key)
            .filter((key: any) => typeof key === 'string')
        : [];
      expect(recommendationKeys).toContain('agent_playbook_rate_limited_high');
    } finally {
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
      if (previousHealthThreshold == null) {
        delete process.env.HEALTH_MAX_RATE_LIMITED_AGENT_PLAYBOOK_1H;
      } else {
        process.env.HEALTH_MAX_RATE_LIMITED_AGENT_PLAYBOOK_1H = previousHealthThreshold;
      }
    }
  });

  it('tracks agent playbook inflight saturation pressure in health metrics and issues', async () => {
    const previousMaxInflightGlobal = process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_GLOBAL;
    const previousMaxInflightPerOrg = process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ORG;
    const previousHealthThreshold = process.env.HEALTH_MAX_PLAYBOOK_INFLIGHT_LIMIT_REACHED_1H;

    process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_GLOBAL = '1';
    process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ORG = '1';
    process.env.HEALTH_MAX_PLAYBOOK_INFLIGHT_LIMIT_REACHED_1H = '1';

    const occupiedSlot = tryAcquirePlaybookExecutionSlot({
      orgId,
      maxGlobal: 1,
      maxPerOrg: 1,
    });
    expect(occupiedSlot).not.toBeNull();

    try {
      const blocked = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId)
        .set('x-correlation-id', `corr-${Date.now()}-inflight`)
        .set('x-forwarded-for', '10.10.44.77')
        .send({
          packId: 'mbs_agent_v1_1',
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {},
        });
      expect(blocked.status, JSON.stringify(blocked.body)).toBe(503);
      expect(blocked.body?.error?.code).toBe('PLAYBOOK_INFLIGHT_LIMIT_REACHED');

      const blockedAgain = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId)
        .set('x-correlation-id', `corr-${Date.now()}-inflight-2`)
        .set('x-forwarded-for', '10.10.44.77')
        .send({
          packId: 'mbs_agent_v1_1',
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {},
        });
      expect(blockedAgain.status, JSON.stringify(blockedAgain.body)).toBe(503);
      expect(blockedAgain.body?.error?.code).toBe('PLAYBOOK_INFLIGHT_LIMIT_REACHED');

      const health = await request
        .get('/api/system/health')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect(health.status, JSON.stringify(health.body)).toBe(200);
      expect(Number(health.body.metrics?.playbookInflightLimitReached1h ?? 0)).toBeGreaterThanOrEqual(2);

      const keys = Array.isArray(health.body.issues)
        ? health.body.issues
            .map((issue: any) => issue?.key)
            .filter((key: any) => typeof key === 'string')
        : [];
      expect(keys).toContain('agent_playbook_inflight_limit_high');

      const recommendationKeys = Array.isArray(health.body.recommendedActions)
        ? health.body.recommendedActions
            .map((action: any) => action?.key)
            .filter((key: any) => typeof key === 'string')
        : [];
      expect(recommendationKeys).toContain('agent_playbook_inflight_limit_high');
    } finally {
      occupiedSlot?.release();
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
      if (previousHealthThreshold == null) {
        delete process.env.HEALTH_MAX_PLAYBOOK_INFLIGHT_LIMIT_REACHED_1H;
      } else {
        process.env.HEALTH_MAX_PLAYBOOK_INFLIGHT_LIMIT_REACHED_1H = previousHealthThreshold;
      }
    }
  });

  it('tracks actor-level playbook inflight saturation in health metrics and issues', async () => {
    const previousHealthThreshold = process.env.HEALTH_MAX_PLAYBOOK_INFLIGHT_LIMIT_REACHED_1H;
    const previousRateLimitMax = process.env.AGENT_PLAYBOOK_RATE_LIMIT_MAX;
    const previousRateLimitWindow = process.env.AGENT_PLAYBOOK_RATE_LIMIT_WINDOW_MS;
    const previousMaxInflightGlobal = process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_GLOBAL;
    const previousMaxInflightPerOrg = process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ORG;
    const previousMaxInflightPerActor = process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ACTOR;
    process.env.HEALTH_MAX_PLAYBOOK_INFLIGHT_LIMIT_REACHED_1H = '1';
    process.env.AGENT_PLAYBOOK_RATE_LIMIT_MAX = '100';
    process.env.AGENT_PLAYBOOK_RATE_LIMIT_WINDOW_MS = '60000';
    process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_GLOBAL = '10';
    process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ORG = '10';
    process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ACTOR = '1';

    const occupied = tryAcquirePlaybookExecutionSlot({
      orgId,
      actorUserId: adminUserId,
      maxGlobal: 10,
      maxPerOrg: 10,
      maxPerActor: 1,
    });
    expect(occupied).not.toBeNull();

    try {
      const blockedOne = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId)
        .set('x-correlation-id', `corr-${Date.now()}-actor-inflight-1`)
        .set('x-forwarded-for', '10.77.0.31')
        .send({
          packId: 'mbs_agent_v1_1',
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {},
        });
      expect(blockedOne.status, JSON.stringify(blockedOne.body)).toBe(503);
      expect(blockedOne.body?.error?.code).toBe('PLAYBOOK_INFLIGHT_LIMIT_REACHED');
      expect(Number(blockedOne.body?.error?.details?.inflightForActor ?? 0)).toBeGreaterThanOrEqual(1);

      const blockedTwo = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId)
        .set('x-correlation-id', `corr-${Date.now()}-actor-inflight-2`)
        .set('x-forwarded-for', '10.77.0.32')
        .send({
          packId: 'mbs_agent_v1_1',
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {},
        });
      expect(blockedTwo.status, JSON.stringify(blockedTwo.body)).toBe(503);
      expect(blockedTwo.body?.error?.code).toBe('PLAYBOOK_INFLIGHT_LIMIT_REACHED');

      const health = await request
        .get('/api/system/health')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect(health.status, JSON.stringify(health.body)).toBe(200);
      expect(Number(health.body.metrics?.playbookInflightLimitReached1h ?? 0)).toBeGreaterThanOrEqual(2);

      const keys = Array.isArray(health.body.issues)
        ? health.body.issues
          .map((issue: { key?: unknown }) => issue?.key)
          .filter((key: unknown): key is string => typeof key === 'string')
        : [];
      expect(keys).toContain('agent_playbook_inflight_limit_high');
    } finally {
      occupied?.release();
      resetPlaybookExecutionInflightForTests();
      if (previousHealthThreshold == null) {
        delete process.env.HEALTH_MAX_PLAYBOOK_INFLIGHT_LIMIT_REACHED_1H;
      } else {
        process.env.HEALTH_MAX_PLAYBOOK_INFLIGHT_LIMIT_REACHED_1H = previousHealthThreshold;
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

  it('tracks duplicate in-flight playbook pressure in health metrics and issues', async () => {
    const previousHealthThreshold = process.env.HEALTH_MAX_PLAYBOOK_DUPLICATE_INFLIGHT_1H;
    const previousRateLimitMax = process.env.AGENT_PLAYBOOK_RATE_LIMIT_MAX;
    const previousRateLimitWindow = process.env.AGENT_PLAYBOOK_RATE_LIMIT_WINDOW_MS;
    const previousMaxInflightGlobal = process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_GLOBAL;
    const previousMaxInflightPerOrg = process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ORG;
    const previousMaxInflightPerActor = process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ACTOR;

    process.env.HEALTH_MAX_PLAYBOOK_DUPLICATE_INFLIGHT_1H = '1';
    process.env.AGENT_PLAYBOOK_RATE_LIMIT_MAX = '100';
    process.env.AGENT_PLAYBOOK_RATE_LIMIT_WINDOW_MS = '60000';
    process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_GLOBAL = '20';
    process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ORG = '20';
    process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ACTOR = '20';

    const correlationId = `corr-${Date.now()}-dup-health`;
    const requestKey = `${orgId}:${adminUserId}:mbs_agent_v1_1:contract_redline_review_v1_1:${correlationId}`;
    const occupied = tryAcquirePlaybookExecutionSlot({
      orgId,
      actorUserId: adminUserId,
      requestKey,
      maxGlobal: 20,
      maxPerOrg: 20,
      maxPerActor: 20,
    });
    expect(occupied).not.toBeNull();

    try {
      const blockedOne = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId)
        .set('x-correlation-id', correlationId)
        .set('x-forwarded-for', '10.77.0.61')
        .send({
          packId: 'mbs_agent_v1_1',
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {},
        });
      expect(blockedOne.status, JSON.stringify(blockedOne.body)).toBe(409);
      expect(blockedOne.body?.error?.code).toBe('PLAYBOOK_DUPLICATE_INFLIGHT');

      const blockedTwo = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId)
        .set('x-correlation-id', correlationId)
        .set('x-forwarded-for', '10.77.0.62')
        .send({
          packId: 'mbs_agent_v1_1',
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {},
        });
      expect(blockedTwo.status, JSON.stringify(blockedTwo.body)).toBe(409);
      expect(blockedTwo.body?.error?.code).toBe('PLAYBOOK_DUPLICATE_INFLIGHT');

      const health = await request
        .get('/api/system/health')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect(health.status, JSON.stringify(health.body)).toBe(200);
      expect(Number(health.body.metrics?.playbookDuplicateInflight1h ?? 0)).toBeGreaterThanOrEqual(2);

      const keys = Array.isArray(health.body.issues)
        ? health.body.issues
          .map((issue: { key?: unknown }) => issue?.key)
          .filter((key: unknown): key is string => typeof key === 'string')
        : [];
      expect(keys).toContain('agent_playbook_duplicate_inflight_high');

      const recommendationKeys = Array.isArray(health.body.recommendedActions)
        ? health.body.recommendedActions
          .map((item: { key?: unknown }) => item?.key)
          .filter((key: unknown): key is string => typeof key === 'string')
        : [];
      expect(recommendationKeys).toContain('agent_playbook_duplicate_inflight_high');
    } finally {
      occupied?.release();
      resetPlaybookExecutionInflightForTests();
      if (previousHealthThreshold == null) {
        delete process.env.HEALTH_MAX_PLAYBOOK_DUPLICATE_INFLIGHT_1H;
      } else {
        process.env.HEALTH_MAX_PLAYBOOK_DUPLICATE_INFLIGHT_1H = previousHealthThreshold;
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

  it('tracks agent playbook request timeout pressure in health metrics and issues', async () => {
    const previousRequestTimeoutMs = process.env.AGENT_PLAYBOOK_REQUEST_TIMEOUT_MS;
    const previousHealthThreshold = process.env.HEALTH_MAX_PLAYBOOK_REQUEST_TIMEOUT_1H;
    const previousRateLimitMax = process.env.AGENT_PLAYBOOK_RATE_LIMIT_MAX;
    const previousRateLimitWindow = process.env.AGENT_PLAYBOOK_RATE_LIMIT_WINDOW_MS;
    const previousMaxInflightGlobal = process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_GLOBAL;
    const previousMaxInflightPerOrg = process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ORG;

    process.env.AGENT_PLAYBOOK_REQUEST_TIMEOUT_MS = '1';
    process.env.HEALTH_MAX_PLAYBOOK_REQUEST_TIMEOUT_1H = '1';
    process.env.AGENT_PLAYBOOK_RATE_LIMIT_MAX = '100';
    process.env.AGENT_PLAYBOOK_RATE_LIMIT_WINDOW_MS = '60000';
    process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_GLOBAL = '20';
    process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ORG = '20';

    try {
      const timedOutOne = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId)
        .set('x-correlation-id', `corr-${Date.now()}-timeout-1`)
        .set('x-forwarded-for', '10.10.44.91')
        .send({
          packId: 'mbs_agent_v1_1',
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {},
        });
      expect(timedOutOne.status, JSON.stringify(timedOutOne.body)).toBe(504);
      expect(timedOutOne.body?.error?.code).toBe('PLAYBOOK_REQUEST_TIMEOUT');

      const timedOutTwo = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId)
        .set('x-correlation-id', `corr-${Date.now()}-timeout-2`)
        .set('x-forwarded-for', '10.10.44.92')
        .send({
          packId: 'mbs_agent_v1_1',
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {},
        });
      expect(timedOutTwo.status, JSON.stringify(timedOutTwo.body)).toBe(504);
      expect(timedOutTwo.body?.error?.code).toBe('PLAYBOOK_REQUEST_TIMEOUT');

      const health = await request
        .get('/api/system/health')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect(health.status, JSON.stringify(health.body)).toBe(200);
      expect(Number(health.body.metrics?.playbookRequestTimeout1h ?? 0)).toBeGreaterThanOrEqual(2);

      const keys = Array.isArray(health.body.issues)
        ? health.body.issues
            .map((issue: any) => issue?.key)
            .filter((key: any) => typeof key === 'string')
        : [];
      expect(keys).toContain('agent_playbook_timeout_high');

      const recommendationKeys = Array.isArray(health.body.recommendedActions)
        ? health.body.recommendedActions
            .map((action: any) => action?.key)
            .filter((key: any) => typeof key === 'string')
        : [];
      expect(recommendationKeys).toContain('agent_playbook_timeout_high');
    } finally {
      if (previousRequestTimeoutMs == null) {
        delete process.env.AGENT_PLAYBOOK_REQUEST_TIMEOUT_MS;
      } else {
        process.env.AGENT_PLAYBOOK_REQUEST_TIMEOUT_MS = previousRequestTimeoutMs;
      }
      if (previousHealthThreshold == null) {
        delete process.env.HEALTH_MAX_PLAYBOOK_REQUEST_TIMEOUT_1H;
      } else {
        process.env.HEALTH_MAX_PLAYBOOK_REQUEST_TIMEOUT_1H = previousHealthThreshold;
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

  it('tracks agent playbook step-timeout pressure in health metrics and issues', async () => {
    const previousStepTimeoutMs = process.env.AGENT_PLAYBOOK_MAX_STEP_EXECUTION_MS;
    const previousRequestTimeoutMs = process.env.AGENT_PLAYBOOK_REQUEST_TIMEOUT_MS;
    const previousHealthThreshold = process.env.HEALTH_MAX_PLAYBOOK_REQUEST_TIMEOUT_1H;
    const previousRateLimitMax = process.env.AGENT_PLAYBOOK_RATE_LIMIT_MAX;
    const previousRateLimitWindowMs = process.env.AGENT_PLAYBOOK_RATE_LIMIT_WINDOW_MS;

    process.env.AGENT_PLAYBOOK_MAX_STEP_EXECUTION_MS = '1';
    process.env.AGENT_PLAYBOOK_REQUEST_TIMEOUT_MS = '10000';
    process.env.HEALTH_MAX_PLAYBOOK_REQUEST_TIMEOUT_1H = '1';
    process.env.AGENT_PLAYBOOK_RATE_LIMIT_MAX = '100';
    process.env.AGENT_PLAYBOOK_RATE_LIMIT_WINDOW_MS = '60000';

    try {
      const timedOutOne = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId)
        .set('x-correlation-id', `corr-${Date.now()}-step-timeout-1`)
        .set('x-forwarded-for', '10.77.0.17')
        .send({
          packId: 'mbs_agent_v1_1',
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {},
        });
      expect(timedOutOne.status, JSON.stringify(timedOutOne.body)).toBe(504);
      expect(timedOutOne.body?.error?.code).toBe('PLAYBOOK_STEP_TIMEOUT');

      const timedOutTwo = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId)
        .set('x-correlation-id', `corr-${Date.now()}-step-timeout-2`)
        .set('x-forwarded-for', '10.77.0.18')
        .send({
          packId: 'mbs_agent_v1_1',
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {},
        });
      expect(timedOutTwo.status, JSON.stringify(timedOutTwo.body)).toBe(504);
      expect(timedOutTwo.body?.error?.code).toBe('PLAYBOOK_STEP_TIMEOUT');

      const health = await request
        .get('/api/system/health')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect(health.status, JSON.stringify(health.body)).toBe(200);
      expect(Number(health.body.metrics?.playbookRequestTimeout1h ?? 0)).toBeGreaterThanOrEqual(2);

      const keys = Array.isArray(health.body.issues)
        ? health.body.issues
          .map((issue: { key?: unknown }) => issue?.key)
          .filter((key: unknown): key is string => typeof key === 'string')
        : [];
      expect(keys).toContain('agent_playbook_timeout_high');

      const recommendationKeys = Array.isArray(health.body.recommendedActions)
        ? health.body.recommendedActions
          .map((item: { key?: unknown }) => item?.key)
          .filter((key: unknown): key is string => typeof key === 'string')
        : [];
      expect(recommendationKeys).toContain('agent_playbook_timeout_high');
    } finally {
      if (previousStepTimeoutMs == null) {
        delete process.env.AGENT_PLAYBOOK_MAX_STEP_EXECUTION_MS;
      } else {
        process.env.AGENT_PLAYBOOK_MAX_STEP_EXECUTION_MS = previousStepTimeoutMs;
      }
      if (previousRequestTimeoutMs == null) {
        delete process.env.AGENT_PLAYBOOK_REQUEST_TIMEOUT_MS;
      } else {
        process.env.AGENT_PLAYBOOK_REQUEST_TIMEOUT_MS = previousRequestTimeoutMs;
      }
      if (previousHealthThreshold == null) {
        delete process.env.HEALTH_MAX_PLAYBOOK_REQUEST_TIMEOUT_1H;
      } else {
        process.env.HEALTH_MAX_PLAYBOOK_REQUEST_TIMEOUT_1H = previousHealthThreshold;
      }
      if (previousRateLimitMax == null) {
        delete process.env.AGENT_PLAYBOOK_RATE_LIMIT_MAX;
      } else {
        process.env.AGENT_PLAYBOOK_RATE_LIMIT_MAX = previousRateLimitMax;
      }
      if (previousRateLimitWindowMs == null) {
        delete process.env.AGENT_PLAYBOOK_RATE_LIMIT_WINDOW_MS;
      } else {
        process.env.AGENT_PLAYBOOK_RATE_LIMIT_WINDOW_MS = previousRateLimitWindowMs;
      }
    }
  });

  it('tracks agent playbook payload-rejection pressure in health metrics and issues', async () => {
    const previousMaxStepPayloadBytes = process.env.AGENT_PLAYBOOK_MAX_STEP_PAYLOAD_BYTES;
    const previousHealthThreshold = process.env.HEALTH_MAX_PLAYBOOK_PAYLOAD_REJECTED_1H;
    const previousRateLimitMax = process.env.AGENT_PLAYBOOK_RATE_LIMIT_MAX;
    const previousRateLimitWindow = process.env.AGENT_PLAYBOOK_RATE_LIMIT_WINDOW_MS;

    process.env.AGENT_PLAYBOOK_MAX_STEP_PAYLOAD_BYTES = '128';
    process.env.HEALTH_MAX_PLAYBOOK_PAYLOAD_REJECTED_1H = '1';
    process.env.AGENT_PLAYBOOK_RATE_LIMIT_MAX = '100';
    process.env.AGENT_PLAYBOOK_RATE_LIMIT_WINDOW_MS = '60000';

    try {
      const rejectedOne = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId)
        .set('x-correlation-id', `corr-${Date.now()}-payload-reject-1`)
        .set('x-forwarded-for', '10.77.0.51')
        .send({
          packId: 'mbs_agent_v1_1',
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {
            contractId: 'ctr_payload_reject_1',
            largeBlob: 'x'.repeat(4096),
          },
        });
      expect(rejectedOne.status, JSON.stringify(rejectedOne.body)).toBe(413);
      expect(rejectedOne.body?.error?.code).toBe('PLAYBOOK_STEP_PAYLOAD_TOO_LARGE');

      const rejectedTwo = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId)
        .set('x-correlation-id', `corr-${Date.now()}-payload-reject-2`)
        .set('x-forwarded-for', '10.77.0.52')
        .send({
          packId: 'mbs_agent_v1_1',
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {
            contractId: 'ctr_payload_reject_2',
            largeBlob: 'x'.repeat(4096),
          },
        });
      expect(rejectedTwo.status, JSON.stringify(rejectedTwo.body)).toBe(413);
      expect(rejectedTwo.body?.error?.code).toBe('PLAYBOOK_STEP_PAYLOAD_TOO_LARGE');

      const health = await request
        .get('/api/system/health')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect(health.status, JSON.stringify(health.body)).toBe(200);
      expect(Number(health.body.metrics?.playbookPayloadRejected1h ?? 0)).toBeGreaterThanOrEqual(2);

      const keys = Array.isArray(health.body.issues)
        ? health.body.issues
          .map((issue: { key?: unknown }) => issue?.key)
          .filter((key: unknown): key is string => typeof key === 'string')
        : [];
      expect(keys).toContain('agent_playbook_payload_rejected_high');

      const recommendationKeys = Array.isArray(health.body.recommendedActions)
        ? health.body.recommendedActions
          .map((item: { key?: unknown }) => item?.key)
          .filter((key: unknown): key is string => typeof key === 'string')
        : [];
      expect(recommendationKeys).toContain('agent_playbook_payload_rejected_high');
    } finally {
      if (previousMaxStepPayloadBytes == null) {
        delete process.env.AGENT_PLAYBOOK_MAX_STEP_PAYLOAD_BYTES;
      } else {
        process.env.AGENT_PLAYBOOK_MAX_STEP_PAYLOAD_BYTES = previousMaxStepPayloadBytes;
      }
      if (previousHealthThreshold == null) {
        delete process.env.HEALTH_MAX_PLAYBOOK_PAYLOAD_REJECTED_1H;
      } else {
        process.env.HEALTH_MAX_PLAYBOOK_PAYLOAD_REJECTED_1H = previousHealthThreshold;
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

  it('tracks playbook payload-shape rejection pressure in health metrics and issues', async () => {
    const previousMaxStepPayloadDepth = process.env.AGENT_PLAYBOOK_MAX_STEP_PAYLOAD_DEPTH;
    const previousHealthThreshold = process.env.HEALTH_MAX_PLAYBOOK_PAYLOAD_REJECTED_1H;
    const previousRateLimitMax = process.env.AGENT_PLAYBOOK_RATE_LIMIT_MAX;
    const previousRateLimitWindow = process.env.AGENT_PLAYBOOK_RATE_LIMIT_WINDOW_MS;

    process.env.AGENT_PLAYBOOK_MAX_STEP_PAYLOAD_DEPTH = '4';
    process.env.HEALTH_MAX_PLAYBOOK_PAYLOAD_REJECTED_1H = '1';
    process.env.AGENT_PLAYBOOK_RATE_LIMIT_MAX = '100';
    process.env.AGENT_PLAYBOOK_RATE_LIMIT_WINDOW_MS = '60000';

    try {
      const rejectedOne = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId)
        .set('x-correlation-id', `corr-${Date.now()}-payload-shape-1`)
        .set('x-forwarded-for', '10.77.0.53')
        .send({
          packId: 'mbs_agent_v1_1',
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {
            contractId: 'ctr_payload_shape_1',
            nested: { a: { b: { c: { d: { e: true } } } } },
          },
        });
      expect(rejectedOne.status, JSON.stringify(rejectedOne.body)).toBe(400);
      expect(rejectedOne.body?.error?.code).toBe('PLAYBOOK_STEP_PAYLOAD_SHAPE_INVALID');

      const rejectedTwo = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId)
        .set('x-correlation-id', `corr-${Date.now()}-payload-shape-2`)
        .set('x-forwarded-for', '10.77.0.54')
        .send({
          packId: 'mbs_agent_v1_1',
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {
            contractId: 'ctr_payload_shape_2',
            nested: { a: { b: { c: { d: { e: true } } } } },
          },
        });
      expect(rejectedTwo.status, JSON.stringify(rejectedTwo.body)).toBe(400);
      expect(rejectedTwo.body?.error?.code).toBe('PLAYBOOK_STEP_PAYLOAD_SHAPE_INVALID');

      const health = await request
        .get('/api/system/health')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect(health.status, JSON.stringify(health.body)).toBe(200);
      expect(Number(health.body.metrics?.playbookPayloadRejected1h ?? 0)).toBeGreaterThanOrEqual(2);

      const keys = Array.isArray(health.body.issues)
        ? health.body.issues
          .map((issue: { key?: unknown }) => issue?.key)
          .filter((key: unknown): key is string => typeof key === 'string')
        : [];
      expect(keys).toContain('agent_playbook_payload_rejected_high');

      const recommendationKeys = Array.isArray(health.body.recommendedActions)
        ? health.body.recommendedActions
          .map((item: { key?: unknown }) => item?.key)
          .filter((key: unknown): key is string => typeof key === 'string')
        : [];
      expect(recommendationKeys).toContain('agent_playbook_payload_rejected_high');
    } finally {
      if (previousMaxStepPayloadDepth == null) {
        delete process.env.AGENT_PLAYBOOK_MAX_STEP_PAYLOAD_DEPTH;
      } else {
        process.env.AGENT_PLAYBOOK_MAX_STEP_PAYLOAD_DEPTH = previousMaxStepPayloadDepth;
      }
      if (previousHealthThreshold == null) {
        delete process.env.HEALTH_MAX_PLAYBOOK_PAYLOAD_REJECTED_1H;
      } else {
        process.env.HEALTH_MAX_PLAYBOOK_PAYLOAD_REJECTED_1H = previousHealthThreshold;
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

  it('tracks agent playbook pack-load failure pressure in health metrics and issues', async () => {
    const previousHealthThreshold = process.env.HEALTH_MAX_PLAYBOOK_PACK_LOAD_FAILURES_1H;
    const previousRateLimitMax = process.env.AGENT_PLAYBOOK_RATE_LIMIT_MAX;
    const previousRateLimitWindow = process.env.AGENT_PLAYBOOK_RATE_LIMIT_WINDOW_MS;

    process.env.HEALTH_MAX_PLAYBOOK_PACK_LOAD_FAILURES_1H = '1';
    process.env.AGENT_PLAYBOOK_RATE_LIMIT_MAX = '100';
    process.env.AGENT_PLAYBOOK_RATE_LIMIT_WINDOW_MS = '60000';

    try {
      const first = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId)
        .set('x-correlation-id', `corr-${Date.now()}-pack-miss-1`)
        .set('x-forwarded-for', '10.10.44.101')
        .send({
          packId: 'mbs_agent_v9_9',
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {},
        });
      expect(first.status, JSON.stringify(first.body)).toBe(400);
      expect(first.body?.error?.code).toBe('PLAYBOOK_PACK_NOT_FOUND');

      const second = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId)
        .set('x-correlation-id', `corr-${Date.now()}-pack-miss-2`)
        .set('x-forwarded-for', '10.10.44.102')
        .send({
          packId: 'mbs_agent_v9_9',
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {},
        });
      expect(second.status, JSON.stringify(second.body)).toBe(400);
      expect(second.body?.error?.code).toBe('PLAYBOOK_PACK_NOT_FOUND');

      const health = await request
        .get('/api/system/health')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect(health.status, JSON.stringify(health.body)).toBe(200);
      expect(Number(health.body.metrics?.playbookPackLoadFailures1h ?? 0)).toBeGreaterThanOrEqual(2);

      const keys = Array.isArray(health.body.issues)
        ? health.body.issues
            .map((issue: any) => issue?.key)
            .filter((key: any) => typeof key === 'string')
        : [];
      expect(keys).toContain('agent_playbook_pack_load_failed_high');

      const recommendationKeys = Array.isArray(health.body.recommendedActions)
        ? health.body.recommendedActions
            .map((action: any) => action?.key)
            .filter((key: any) => typeof key === 'string')
        : [];
      expect(recommendationKeys).toContain('agent_playbook_pack_load_failed_high');
    } finally {
      if (previousHealthThreshold == null) {
        delete process.env.HEALTH_MAX_PLAYBOOK_PACK_LOAD_FAILURES_1H;
      } else {
        process.env.HEALTH_MAX_PLAYBOOK_PACK_LOAD_FAILURES_1H = previousHealthThreshold;
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

  it('tracks playbook fail-closed pressure in health metrics and issues', async () => {
    const previousHealthThreshold = process.env.HEALTH_MAX_PLAYBOOK_FAIL_CLOSED_BLOCKED_1H;
    const previousRateLimitMax = process.env.AGENT_PLAYBOOK_RATE_LIMIT_MAX;
    const previousRateLimitWindow = process.env.AGENT_PLAYBOOK_RATE_LIMIT_WINDOW_MS;
    const previousFailClosedEnabled = process.env.AGENT_PLAYBOOK_FAIL_CLOSED_ENABLED;
    const previousFailClosedIssueKeys = process.env.AGENT_PLAYBOOK_FAIL_CLOSED_ISSUE_KEYS;
    const previousFailClosedOnCritical = process.env.AGENT_PLAYBOOK_FAIL_CLOSED_ON_CRITICAL;
    const previousFailClosedTimeoutMs = process.env.AGENT_PLAYBOOK_FAIL_CLOSED_TIMEOUT_MS;
    const previousJwtSecret = process.env.JWT_SECRET;

    process.env.HEALTH_MAX_PLAYBOOK_FAIL_CLOSED_BLOCKED_1H = '1';
    process.env.AGENT_PLAYBOOK_RATE_LIMIT_MAX = '100';
    process.env.AGENT_PLAYBOOK_RATE_LIMIT_WINDOW_MS = '60000';
    process.env.AGENT_PLAYBOOK_FAIL_CLOSED_ENABLED = 'true';
    process.env.AGENT_PLAYBOOK_FAIL_CLOSED_ISSUE_KEYS = 'auth_jwt_secret_insecure';
    process.env.AGENT_PLAYBOOK_FAIL_CLOSED_ON_CRITICAL = 'false';
    process.env.AGENT_PLAYBOOK_FAIL_CLOSED_TIMEOUT_MS = '5000';
    process.env.JWT_SECRET = 'change-me';

    try {
      const first = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId)
        .set('x-correlation-id', `corr-${Date.now()}-failclosed-1`)
        .set('x-forwarded-for', '10.10.44.121')
        .send({
          packId: 'mbs_agent_v1_1',
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {},
        });
      expect(first.status, JSON.stringify(first.body)).toBe(503);
      expect(first.body?.error?.code).toBe('PLAYBOOK_FAIL_CLOSED');

      const second = await request
        .post('/api/agent/playbooks/execute')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId)
        .set('x-correlation-id', `corr-${Date.now()}-failclosed-2`)
        .set('x-forwarded-for', '10.10.44.122')
        .send({
          packId: 'mbs_agent_v1_1',
          playbookStableId: 'contract_redline_review_v1_1',
          inputs: {},
        });
      expect(second.status, JSON.stringify(second.body)).toBe(503);
      expect(second.body?.error?.code).toBe('PLAYBOOK_FAIL_CLOSED');

      const health = await request
        .get('/api/system/health')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect(health.status, JSON.stringify(health.body)).toBe(200);
      expect(Number(health.body.metrics?.playbookFailClosedBlocked1h ?? 0)).toBeGreaterThanOrEqual(2);

      const keys = Array.isArray(health.body.issues)
        ? health.body.issues
            .map((issue: any) => issue?.key)
            .filter((key: any) => typeof key === 'string')
        : [];
      expect(keys).toContain('agent_playbook_fail_closed_high');

      const recommendationKeys = Array.isArray(health.body.recommendedActions)
        ? health.body.recommendedActions
            .map((action: any) => action?.key)
            .filter((key: any) => typeof key === 'string')
        : [];
      expect(recommendationKeys).toContain('agent_playbook_fail_closed_high');
    } finally {
      if (previousHealthThreshold == null) {
        delete process.env.HEALTH_MAX_PLAYBOOK_FAIL_CLOSED_BLOCKED_1H;
      } else {
        process.env.HEALTH_MAX_PLAYBOOK_FAIL_CLOSED_BLOCKED_1H = previousHealthThreshold;
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

  it('flags missing ingest and call webhook secrets in health issues', async () => {
    const previousIngestTokens = process.env.MBS_INGEST_TOKENS;
    const previousWebhookSecret = process.env.CALL_WEBHOOK_SECRET;
    const previousIpHashSalt = process.env.MBS_IP_HASH_SALT;
    delete process.env.MBS_INGEST_TOKENS;
    delete process.env.CALL_WEBHOOK_SECRET;
    delete process.env.MBS_IP_HASH_SALT;

    try {
      const response = await request
        .get('/api/system/health')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const issues = Array.isArray(response.body.issues) ? response.body.issues : [];
      const keys = issues
        .map((issue: any) => issue?.key)
        .filter((key: any) => typeof key === 'string');
      expect(keys).toContain('ingest_tokens_missing');
      expect(keys).toContain('call_webhook_secret_missing');
      expect(keys).toContain('ingest_ip_hash_salt_missing');

      const recommendationKeys = Array.isArray(response.body.recommendedActions)
        ? response.body.recommendedActions
            .map((action: any) => action?.key)
            .filter((key: any) => typeof key === 'string')
        : [];
      expect(recommendationKeys).toContain('ingest_tokens_missing');
      expect(recommendationKeys).toContain('call_webhook_secret_missing');
      expect(recommendationKeys).toContain('ingest_ip_hash_salt_missing');
    } finally {
      if (previousIngestTokens == null) {
        delete process.env.MBS_INGEST_TOKENS;
      } else {
        process.env.MBS_INGEST_TOKENS = previousIngestTokens;
      }
      if (previousWebhookSecret == null) {
        delete process.env.CALL_WEBHOOK_SECRET;
      } else {
        process.env.CALL_WEBHOOK_SECRET = previousWebhookSecret;
      }
      if (previousIpHashSalt == null) {
        delete process.env.MBS_IP_HASH_SALT;
      } else {
        process.env.MBS_IP_HASH_SALT = previousIpHashSalt;
      }
    }
  });

  it('flags insecure ingest and call webhook secrets in health issues', async () => {
    const previousIngestTokens = process.env.MBS_INGEST_TOKENS;
    const previousWebhookSecret = process.env.CALL_WEBHOOK_SECRET;
    const previousIpHashSalt = process.env.MBS_IP_HASH_SALT;
    process.env.MBS_INGEST_TOKENS = 'test,another-strong-token-value-1234567890';
    process.env.CALL_WEBHOOK_SECRET = 'test';
    process.env.MBS_IP_HASH_SALT = 'mbs-intake-dev-salt';

    try {
      const response = await request
        .get('/api/system/health')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const issues = Array.isArray(response.body.issues) ? response.body.issues : [];
      const keys = issues
        .map((issue: any) => issue?.key)
        .filter((key: any) => typeof key === 'string');
      expect(keys).toContain('ingest_tokens_insecure');
      expect(keys).toContain('call_webhook_secret_insecure');
      expect(keys).toContain('ingest_ip_hash_salt_insecure');

      const recommendationKeys = Array.isArray(response.body.recommendedActions)
        ? response.body.recommendedActions
            .map((action: any) => action?.key)
            .filter((key: any) => typeof key === 'string')
        : [];
      expect(recommendationKeys).toContain('ingest_tokens_insecure');
      expect(recommendationKeys).toContain('call_webhook_secret_insecure');
      expect(recommendationKeys).toContain('ingest_ip_hash_salt_insecure');
    } finally {
      if (previousIngestTokens == null) {
        delete process.env.MBS_INGEST_TOKENS;
      } else {
        process.env.MBS_INGEST_TOKENS = previousIngestTokens;
      }
      if (previousWebhookSecret == null) {
        delete process.env.CALL_WEBHOOK_SECRET;
      } else {
        process.env.CALL_WEBHOOK_SECRET = previousWebhookSecret;
      }
      if (previousIpHashSalt == null) {
        delete process.env.MBS_IP_HASH_SALT;
      } else {
        process.env.MBS_IP_HASH_SALT = previousIpHashSalt;
      }
    }
  });

  it('flags stale snapshot when latest health snapshot is too old', async () => {
    const priorSnapshotPath = process.env.HEALTH_SNAPSHOT_LOG_PATH;
    const priorMaxAge = process.env.HEALTH_MAX_SNAPSHOT_AGE_MINUTES;
    const tempDir = path.join(os.tmpdir(), `mbs-health-snapshot-${Date.now()}`);
    const snapshotPath = path.join(tempDir, 'health-history.jsonl');

    await mkdir(tempDir, { recursive: true });
    const staleTimestamp = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    await writeFile(
      snapshotPath,
      `${JSON.stringify({
        timestamp: staleTimestamp,
        overall: 'OK',
        metrics: {
          pendingOutbox: 0,
          failedOutbox: 0,
          pendingApprovals: 0,
          failedExecutions1h: 0,
          backupAgeHours: 1,
        },
        issues: [],
      })}\n`,
      'utf8',
    );

    process.env.HEALTH_SNAPSHOT_LOG_PATH = snapshotPath;
    process.env.HEALTH_MAX_SNAPSHOT_AGE_MINUTES = '30';

    try {
      const response = await request
        .get('/api/system/health')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const issues = Array.isArray(response.body.issues) ? response.body.issues : [];
      const keys = issues
        .map((issue: any) => issue?.key)
        .filter((key: any) => typeof key === 'string');
      expect(keys).toContain('ops_snapshot_stale');

      const recommendationKeys = Array.isArray(response.body.recommendedActions)
        ? response.body.recommendedActions
            .map((action: any) => action?.key)
            .filter((key: any) => typeof key === 'string')
        : [];
      expect(recommendationKeys).toContain('ops_snapshot_stale');
    } finally {
      if (priorSnapshotPath == null) {
        delete process.env.HEALTH_SNAPSHOT_LOG_PATH;
      } else {
        process.env.HEALTH_SNAPSHOT_LOG_PATH = priorSnapshotPath;
      }
      if (priorMaxAge == null) {
        delete process.env.HEALTH_MAX_SNAPSHOT_AGE_MINUTES;
      } else {
        process.env.HEALTH_MAX_SNAPSHOT_AGE_MINUTES = priorMaxAge;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('flags stale restore drill marker when restore validation is too old', async () => {
    const priorBackupDir = process.env.BACKUP_DIR;
    const priorMarkerPath = process.env.HEALTH_RESTORE_DRILL_MARKER_PATH;
    const priorMaxRestoreAge = process.env.HEALTH_MAX_RESTORE_DRILL_AGE_HOURS;
    const tempDir = path.join(os.tmpdir(), `mbs-restore-marker-${Date.now()}`);
    const backupStampDir = path.join(tempDir, '20260223T000000Z');
    const markerPath = path.join(tempDir, 'restore-drill.marker');

    await mkdir(backupStampDir, { recursive: true });
    const staleEpoch = Math.floor((Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000);
    const staleIso = new Date(staleEpoch * 1000).toISOString();
    await writeFile(
      markerPath,
      `status=success\ncompletedAtEpoch=${staleEpoch}\ncompletedAtIso=${staleIso}\nbackupPath=${backupStampDir}\n`,
      'utf8',
    );

    process.env.BACKUP_DIR = tempDir;
    process.env.HEALTH_RESTORE_DRILL_MARKER_PATH = markerPath;
    process.env.HEALTH_MAX_RESTORE_DRILL_AGE_HOURS = '24';

    try {
      const response = await request
        .get('/api/system/health')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const issues = Array.isArray(response.body.issues) ? response.body.issues : [];
      const keys = issues
        .map((issue: any) => issue?.key)
        .filter((key: any) => typeof key === 'string');
      expect(keys).toContain('restore_drill_stale');
      expect(typeof response.body.metrics?.restoreDrillAgeHours).toBe('number');

      const recommendationKeys = Array.isArray(response.body.recommendedActions)
        ? response.body.recommendedActions
            .map((action: any) => action?.key)
            .filter((key: any) => typeof key === 'string')
        : [];
      expect(recommendationKeys).toContain('restore_drill_stale');
    } finally {
      if (priorBackupDir == null) {
        delete process.env.BACKUP_DIR;
      } else {
        process.env.BACKUP_DIR = priorBackupDir;
      }
      if (priorMarkerPath == null) {
        delete process.env.HEALTH_RESTORE_DRILL_MARKER_PATH;
      } else {
        process.env.HEALTH_RESTORE_DRILL_MARKER_PATH = priorMarkerPath;
      }
      if (priorMaxRestoreAge == null) {
        delete process.env.HEALTH_MAX_RESTORE_DRILL_AGE_HOURS;
      } else {
        process.env.HEALTH_MAX_RESTORE_DRILL_AGE_HOURS = priorMaxRestoreAge;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('flags stale restore drill lock and exposes lock metrics', async () => {
    const priorBackupDir = process.env.BACKUP_DIR;
    const priorMarkerPath = process.env.HEALTH_RESTORE_DRILL_MARKER_PATH;
    const priorLockPath = process.env.HEALTH_RESTORE_DRILL_LOCK_PATH;
    const priorLockAge = process.env.HEALTH_MAX_RESTORE_DRILL_LOCK_AGE_MINUTES;
    const tempDir = path.join(os.tmpdir(), `mbs-restore-lock-${Date.now()}`);
    const markerPath = path.join(tempDir, 'restore-drill.marker');
    const lockPath = path.join(tempDir, 'restore-drill.lock');

    await mkdir(lockPath, { recursive: true });
    const markerEpoch = Math.floor(Date.now() / 1000);
    const markerIso = new Date(markerEpoch * 1000).toISOString();
    await writeFile(
      markerPath,
      `status=success\ncompletedAtEpoch=${markerEpoch}\ncompletedAtIso=${markerIso}\nbackupPath=${tempDir}\n`,
      'utf8',
    );
    const staleLockEpoch = Math.floor((Date.now() - 8 * 60 * 60 * 1000) / 1000);
    await writeFile(
      path.join(lockPath, 'startedAtEpoch'),
      `${staleLockEpoch}\n`,
      'utf8',
    );

    process.env.BACKUP_DIR = tempDir;
    process.env.HEALTH_RESTORE_DRILL_MARKER_PATH = markerPath;
    process.env.HEALTH_RESTORE_DRILL_LOCK_PATH = lockPath;
    process.env.HEALTH_MAX_RESTORE_DRILL_LOCK_AGE_MINUTES = '60';

    try {
      const response = await request
        .get('/api/system/health')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const issues = Array.isArray(response.body.issues) ? response.body.issues : [];
      const keys = issues
        .map((issue: any) => issue?.key)
        .filter((key: any) => typeof key === 'string');
      expect(keys).toContain('restore_drill_lock_stale');

      expect(response.body.metrics?.restoreDrillLockStatus).toBe('STALE');
      expect(typeof response.body.metrics?.restoreDrillLockAgeMinutes).toBe('number');

      const recommendationKeys = Array.isArray(response.body.recommendedActions)
        ? response.body.recommendedActions
            .map((action: any) => action?.key)
            .filter((key: any) => typeof key === 'string')
        : [];
      expect(recommendationKeys).toContain('restore_drill_lock_stale');
    } finally {
      if (priorBackupDir == null) {
        delete process.env.BACKUP_DIR;
      } else {
        process.env.BACKUP_DIR = priorBackupDir;
      }
      if (priorMarkerPath == null) {
        delete process.env.HEALTH_RESTORE_DRILL_MARKER_PATH;
      } else {
        process.env.HEALTH_RESTORE_DRILL_MARKER_PATH = priorMarkerPath;
      }
      if (priorLockPath == null) {
        delete process.env.HEALTH_RESTORE_DRILL_LOCK_PATH;
      } else {
        process.env.HEALTH_RESTORE_DRILL_LOCK_PATH = priorLockPath;
      }
      if (priorLockAge == null) {
        delete process.env.HEALTH_MAX_RESTORE_DRILL_LOCK_AGE_MINUTES;
      } else {
        process.env.HEALTH_MAX_RESTORE_DRILL_LOCK_AGE_MINUTES = priorLockAge;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('flags stale remediation lock and exposes lock metrics', async () => {
    const priorRemediateLockPath = process.env.HEALTH_REMEDIATE_LOCK_PATH;
    const priorRemediateLockAge = process.env.HEALTH_MAX_REMEDIATE_LOCK_AGE_MINUTES;
    const tempDir = path.join(os.tmpdir(), `mbs-remediate-lock-${Date.now()}`);
    const lockPath = path.join(tempDir, 'remediate.lock');

    await mkdir(tempDir, { recursive: true });
    const staleLockEpoch = Math.floor((Date.now() - 3 * 60 * 60 * 1000) / 1000);
    await writeFile(
      lockPath,
      `pid=12345\ncreatedAtEpoch=${staleLockEpoch}\ncreatedAtIso=${new Date(
        staleLockEpoch * 1000,
      ).toISOString()}\n`,
      'utf8',
    );

    process.env.HEALTH_REMEDIATE_LOCK_PATH = lockPath;
    process.env.HEALTH_MAX_REMEDIATE_LOCK_AGE_MINUTES = '30';

    try {
      const response = await request
        .get('/api/system/health')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const issues = Array.isArray(response.body.issues) ? response.body.issues : [];
      const keys = issues
        .map((issue: any) => issue?.key)
        .filter((key: any) => typeof key === 'string');
      expect(keys).toContain('remediate_lock_stale');

      expect(response.body.metrics?.remediateLockStatus).toBe('STALE');
      expect(typeof response.body.metrics?.remediateLockAgeMinutes).toBe('number');

      const recommendationKeys = Array.isArray(response.body.recommendedActions)
        ? response.body.recommendedActions
            .map((action: any) => action?.key)
            .filter((key: any) => typeof key === 'string')
        : [];
      expect(recommendationKeys).toContain('remediate_lock_stale');
    } finally {
      if (priorRemediateLockPath == null) {
        delete process.env.HEALTH_REMEDIATE_LOCK_PATH;
      } else {
        process.env.HEALTH_REMEDIATE_LOCK_PATH = priorRemediateLockPath;
      }
      if (priorRemediateLockAge == null) {
        delete process.env.HEALTH_MAX_REMEDIATE_LOCK_AGE_MINUTES;
      } else {
        process.env.HEALTH_MAX_REMEDIATE_LOCK_AGE_MINUTES = priorRemediateLockAge;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('flags failed restore drill marker status', async () => {
    const priorBackupDir = process.env.BACKUP_DIR;
    const priorMarkerPath = process.env.HEALTH_RESTORE_DRILL_MARKER_PATH;
    const tempDir = path.join(os.tmpdir(), `mbs-restore-failed-marker-${Date.now()}`);
    const backupStampDir = path.join(tempDir, '20260223T000000Z');
    const markerPath = path.join(tempDir, 'restore-drill.marker');

    await mkdir(backupStampDir, { recursive: true });
    const markerEpoch = Math.floor(Date.now() / 1000);
    const markerIso = new Date(markerEpoch * 1000).toISOString();
    await writeFile(
      markerPath,
      [
        'status=failed',
        `completedAtEpoch=${markerEpoch}`,
        `completedAtIso=${markerIso}`,
        `backupPath=${backupStampDir}`,
        'errorCode=2',
        'errorStep=restore_postgres_dump',
      ].join('\n') + '\n',
      'utf8',
    );

    process.env.BACKUP_DIR = tempDir;
    process.env.HEALTH_RESTORE_DRILL_MARKER_PATH = markerPath;

    try {
      const response = await request
        .get('/api/system/health')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const issues = Array.isArray(response.body.issues) ? response.body.issues : [];
      const keys = issues
        .map((issue: any) => issue?.key)
        .filter((key: any) => typeof key === 'string');
      expect(keys).toContain('restore_drill_failed');
      expect(response.body.metrics?.restoreDrillStatus).toBe('failed');

      const recommendationKeys = Array.isArray(response.body.recommendedActions)
        ? response.body.recommendedActions
            .map((action: any) => action?.key)
            .filter((key: any) => typeof key === 'string')
        : [];
      expect(recommendationKeys).toContain('restore_drill_failed');
    } finally {
      if (priorBackupDir == null) {
        delete process.env.BACKUP_DIR;
      } else {
        process.env.BACKUP_DIR = priorBackupDir;
      }
      if (priorMarkerPath == null) {
        delete process.env.HEALTH_RESTORE_DRILL_MARKER_PATH;
      } else {
        process.env.HEALTH_RESTORE_DRILL_MARKER_PATH = priorMarkerPath;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('flags failed load smoke marker status', async () => {
    const priorLoadSmokeMarkerPath = process.env.HEALTH_LOAD_SMOKE_MARKER_PATH;
    const tempDir = path.join(os.tmpdir(), `mbs-load-smoke-failed-marker-${Date.now()}`);
    const markerPath = path.join(tempDir, 'load-smoke.marker');

    await mkdir(tempDir, { recursive: true });
    const markerEpoch = Math.floor(Date.now() / 1000);
    const markerIso = new Date(markerEpoch * 1000).toISOString();
    await writeFile(
      markerPath,
      [
        'status=failed',
        `completedAtEpoch=${markerEpoch}`,
        `completedAtIso=${markerIso}`,
        'successPct=94.25',
        'p95Seconds=1.132',
      ].join('\n') + '\n',
      'utf8',
    );

    process.env.HEALTH_LOAD_SMOKE_MARKER_PATH = markerPath;

    try {
      const response = await request
        .get('/api/system/health')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const issues = Array.isArray(response.body.issues) ? response.body.issues : [];
      const keys = issues
        .map((issue: any) => issue?.key)
        .filter((key: any) => typeof key === 'string');
      expect(keys).toContain('load_smoke_failed');
      expect(response.body.metrics?.loadSmokeStatus).toBe('failed');

      const recommendationKeys = Array.isArray(response.body.recommendedActions)
        ? response.body.recommendedActions
            .map((action: any) => action?.key)
            .filter((key: any) => typeof key === 'string')
        : [];
      expect(recommendationKeys).toContain('load_smoke_failed');
    } finally {
      if (priorLoadSmokeMarkerPath == null) {
        delete process.env.HEALTH_LOAD_SMOKE_MARKER_PATH;
      } else {
        process.env.HEALTH_LOAD_SMOKE_MARKER_PATH = priorLoadSmokeMarkerPath;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('flags load smoke trend failures when recent history breaches failure threshold', async () => {
    const priorLoadSmokeMarkerPath = process.env.HEALTH_LOAD_SMOKE_MARKER_PATH;
    const priorLoadSmokeHistoryPath = process.env.HEALTH_LOAD_SMOKE_HISTORY_PATH;
    const priorTrendWindow = process.env.HEALTH_LOAD_SMOKE_TREND_WINDOW;
    const priorMaxFails = process.env.HEALTH_LOAD_SMOKE_MAX_FAILS_WINDOW;
    const tempDir = path.join(os.tmpdir(), `mbs-load-smoke-trend-${Date.now()}`);
    const markerPath = path.join(tempDir, 'load-smoke.marker');
    const historyPath = path.join(tempDir, 'load-smoke-history.jsonl');

    await mkdir(tempDir, { recursive: true });
    const markerEpoch = Math.floor(Date.now() / 1000);
    const markerIso = new Date(markerEpoch * 1000).toISOString();
    await writeFile(
      markerPath,
      [
        'status=success',
        `completedAtEpoch=${markerEpoch}`,
        `completedAtIso=${markerIso}`,
        'resultStatus=PASS',
        'exitCode=0',
        'successPct=100',
        'p95Seconds=0.320',
        'targetUrl=http://localhost:3001/health',
      ].join('\n') + '\n',
      'utf8',
    );
    await writeFile(
      historyPath,
      [
        '{"status":"FAIL","successPct":0}',
        '{"status":"FAIL","successPct":0}',
        '{"status":"PASS","successPct":100}',
      ].join('\n') + '\n',
      'utf8',
    );

    process.env.HEALTH_LOAD_SMOKE_MARKER_PATH = markerPath;
    process.env.HEALTH_LOAD_SMOKE_HISTORY_PATH = historyPath;
    process.env.HEALTH_LOAD_SMOKE_TREND_WINDOW = '3';
    process.env.HEALTH_LOAD_SMOKE_MAX_FAILS_WINDOW = '1';

    try {
      const response = await request
        .get('/api/system/health')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const issues = Array.isArray(response.body.issues) ? response.body.issues : [];
      const keys = issues
        .map((issue: any) => issue?.key)
        .filter((key: any) => typeof key === 'string');
      expect(keys).toContain('load_smoke_trend_failed');
      expect(response.body.metrics?.loadSmokeTrendFailCount).toBe(2);
      expect(response.body.metrics?.loadSmokeTrendWindow).toBe(3);

      const recommendationKeys = Array.isArray(response.body.recommendedActions)
        ? response.body.recommendedActions
            .map((action: any) => action?.key)
            .filter((key: any) => typeof key === 'string')
        : [];
      expect(recommendationKeys).toContain('load_smoke_trend_failed');
    } finally {
      if (priorLoadSmokeMarkerPath == null) {
        delete process.env.HEALTH_LOAD_SMOKE_MARKER_PATH;
      } else {
        process.env.HEALTH_LOAD_SMOKE_MARKER_PATH = priorLoadSmokeMarkerPath;
      }
      if (priorLoadSmokeHistoryPath == null) {
        delete process.env.HEALTH_LOAD_SMOKE_HISTORY_PATH;
      } else {
        process.env.HEALTH_LOAD_SMOKE_HISTORY_PATH = priorLoadSmokeHistoryPath;
      }
      if (priorTrendWindow == null) {
        delete process.env.HEALTH_LOAD_SMOKE_TREND_WINDOW;
      } else {
        process.env.HEALTH_LOAD_SMOKE_TREND_WINDOW = priorTrendWindow;
      }
      if (priorMaxFails == null) {
        delete process.env.HEALTH_LOAD_SMOKE_MAX_FAILS_WINDOW;
      } else {
        process.env.HEALTH_LOAD_SMOKE_MAX_FAILS_WINDOW = priorMaxFails;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns recent incident snapshots list endpoint', async () => {
    const response = await request
      .get('/api/system/health/incidents?limit=3')
      .set('x-org-slug', 'russell-comfort')
      .set('x-actor-user-id', adminUserId);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(Array.isArray(response.body.incidents)).toBe(true);
    expect(typeof response.body.count).toBe('number');
  });

  it('collapses duplicate incidents by fingerprint within collapse window', async () => {
    const priorIncidentDir = process.env.HEALTH_INCIDENT_DIR;
    const priorWindow = process.env.HEALTH_INCIDENT_COLLAPSE_WINDOW_MINUTES;
    const tempDir = path.join(os.tmpdir(), `mbs-health-incidents-${Date.now()}`);
    const incidentDir = path.join(tempDir, 'incidents');
    await mkdir(incidentDir, { recursive: true });

    const now = Date.now();
    const incidentAPath = path.join(incidentDir, 'incident_a.json');
    const incidentBPath = path.join(incidentDir, 'incident_b.json');
    const incidentCPath = path.join(incidentDir, 'incident_c.json');
    await writeFile(
      incidentAPath,
      JSON.stringify(
        {
          timestamp: new Date(now).toISOString(),
          severity: 'WARN',
          fingerprint: 'fingerprint-same',
          healthExit: 1,
          health: { overall: 'WARN', issues: [{ key: 'outbox_pending_high' }] },
        },
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(
      incidentBPath,
      JSON.stringify(
        {
          timestamp: new Date(now - 4 * 60 * 1000).toISOString(),
          severity: 'WARN',
          fingerprint: 'fingerprint-same',
          healthExit: 1,
          health: { overall: 'WARN', issues: [{ key: 'outbox_pending_high' }] },
        },
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(
      incidentCPath,
      JSON.stringify(
        {
          timestamp: new Date(now - 3 * 60 * 1000).toISOString(),
          severity: 'WARN',
          fingerprint: 'fingerprint-other',
          healthExit: 1,
          health: { overall: 'WARN', issues: [{ key: 'pending_approvals_high' }] },
        },
        null,
        2,
      ),
      'utf8',
    );

    await utimes(incidentAPath, new Date(now), new Date(now));
    await utimes(incidentBPath, new Date(now - 4 * 60 * 1000), new Date(now - 4 * 60 * 1000));
    await utimes(incidentCPath, new Date(now - 3 * 60 * 1000), new Date(now - 3 * 60 * 1000));

    process.env.HEALTH_INCIDENT_DIR = incidentDir;
    process.env.HEALTH_INCIDENT_COLLAPSE_WINDOW_MINUTES = '10';

    try {
      const collapsed = await request
        .get('/api/system/health/incidents?limit=10&collapse=true')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect(collapsed.status, JSON.stringify(collapsed.body)).toBe(200);
      expect(collapsed.body.collapse).toBe(true);
      expect(collapsed.body.rawCount).toBe(3);
      expect(collapsed.body.count).toBe(2);
      const same = (collapsed.body.incidents as Array<any>).find(
        (incident) => incident.fingerprint === 'fingerprint-same',
      );
      expect(same?.duplicateCount).toBe(2);

      const uncollapsed = await request
        .get('/api/system/health/incidents?limit=10&collapse=false')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect(uncollapsed.status, JSON.stringify(uncollapsed.body)).toBe(200);
      expect(uncollapsed.body.collapse).toBe(false);
      expect(uncollapsed.body.count).toBe(3);
      expect(uncollapsed.body.rawCount).toBe(3);
    } finally {
      if (priorIncidentDir == null) {
        delete process.env.HEALTH_INCIDENT_DIR;
      } else {
        process.env.HEALTH_INCIDENT_DIR = priorIncidentDir;
      }
      if (priorWindow == null) {
        delete process.env.HEALTH_INCIDENT_COLLAPSE_WINDOW_MINUTES;
      } else {
        process.env.HEALTH_INCIDENT_COLLAPSE_WINDOW_MINUTES = priorWindow;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns recent health history snapshots', async () => {
    const response = await request
      .get('/api/system/health/history?limit=12')
      .set('x-org-slug', 'russell-comfort')
      .set('x-actor-user-id', adminUserId);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(Array.isArray(response.body.snapshots)).toBe(true);
    expect(typeof response.body.count).toBe('number');
    expect(typeof response.body.path).toBe('string');
  });

  it('returns smoke endpoint diagnostics for incident drill checks', async () => {
    const response = await request
      .get('/api/system/health/smoke')
      .set('x-org-slug', 'russell-comfort')
      .set('x-actor-user-id', adminUserId);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(typeof response.body.liveStatus).toBe('string');
    expect(typeof response.body.checks?.liveHealthComputed).toBe('boolean');
    expect(typeof response.body.checks?.backupVisibilityConfigured).toBe('boolean');
    expect(typeof response.body.checks?.restoreDrillFresh).toBe('boolean');
    expect(typeof response.body.checks?.ingestTokensConfigured).toBe('boolean');
    expect(typeof response.body.checks?.callWebhookSecretConfigured).toBe('boolean');
    expect(typeof response.body.checks?.ingestIpHashSaltConfigured).toBe('boolean');
    expect(typeof response.body.checks?.loadSmokeFresh).toBe('boolean');
  });

  it('blocks access for users without system:ops:read permission', async () => {
    const response = await request
      .get('/api/system/health')
      .set('x-org-slug', 'russell-comfort')
      .set('x-actor-user-id', techUserId);

    expect(response.status).toBe(403);
  });

  it('treats explicitly configured unreadable BACKUP_DIR as critical', async () => {
    const priorBackupDir = process.env.BACKUP_DIR;
    process.env.BACKUP_DIR = `/tmp/mbs-health-missing-${Date.now()}`;

    try {
      const response = await request
        .get('/api/system/health')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.status).toBe('CRITICAL');
      const issues = Array.isArray(response.body.issues) ? response.body.issues : [];
      const keys = issues.map((issue: any) => issue?.key).filter((key: any) => typeof key === 'string');
      expect(keys).toContain('backup_dir_missing');
      const recommendations = Array.isArray(response.body.recommendedActions) ? response.body.recommendedActions : [];
      const recommendationKeys = recommendations
        .map((action: any) => action?.key)
        .filter((key: any) => typeof key === 'string');
      expect(recommendationKeys).toContain('backup_dir_missing');
    } finally {
      if (priorBackupDir == null) {
        delete process.env.BACKUP_DIR;
      } else {
        process.env.BACKUP_DIR = priorBackupDir;
      }
    }
  });

  it('flags incomplete latest backup snapshot when required files are missing', async () => {
    const priorBackupDir = process.env.BACKUP_DIR;
    const tempDir = path.join(os.tmpdir(), `mbs-health-backup-incomplete-${Date.now()}`);
    const latestDir = path.join(tempDir, '20260223T000000Z');

    await mkdir(latestDir, { recursive: true });
    await writeFile(path.join(latestDir, 'postgres.sql.gz'), 'stub', 'utf8');

    process.env.BACKUP_DIR = tempDir;

    try {
      const response = await request
        .get('/api/system/health')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const issues = Array.isArray(response.body.issues) ? response.body.issues : [];
      const keys = issues
        .map((issue: any) => issue?.key)
        .filter((key: any) => typeof key === 'string');
      expect(keys).toContain('backup_incomplete');
      expect(response.body.metrics?.backupIntegrityState).toBe('INCOMPLETE');
      expect(response.body.metrics?.backupIntegrityMissingCount).toBeGreaterThan(0);

      const recommendations = Array.isArray(response.body.recommendedActions)
        ? response.body.recommendedActions
        : [];
      const recommendationKeys = recommendations
        .map((action: any) => action?.key)
        .filter((key: any) => typeof key === 'string');
      expect(recommendationKeys).toContain('backup_incomplete');
    } finally {
      if (priorBackupDir == null) {
        delete process.env.BACKUP_DIR;
      } else {
        process.env.BACKUP_DIR = priorBackupDir;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('flags invalid backup manifest when manifest keys are missing', async () => {
    const priorBackupDir = process.env.BACKUP_DIR;
    const tempDir = path.join(os.tmpdir(), `mbs-health-backup-manifest-${Date.now()}`);
    const latestDir = path.join(tempDir, '20260223T010000Z');

    await mkdir(latestDir, { recursive: true });
    await writeFile(path.join(latestDir, 'postgres.sql.gz'), 'stub', 'utf8');
    await writeFile(path.join(latestDir, 'minio-data.tgz'), 'stub', 'utf8');
    await writeFile(
      path.join(latestDir, 'manifest.txt'),
      'timestamp=20260223T010000Z\npostgres_file=postgres.sql.gz\nminio_file=minio-data.tgz\n',
      'utf8',
    );

    process.env.BACKUP_DIR = tempDir;

    try {
      const response = await request
        .get('/api/system/health')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const issues = Array.isArray(response.body.issues) ? response.body.issues : [];
      const keys = issues
        .map((issue: any) => issue?.key)
        .filter((key: any) => typeof key === 'string');
      expect(keys).toContain('backup_manifest_invalid');
      expect(response.body.metrics?.backupManifestState).toBe('INVALID');

      const recommendations = Array.isArray(response.body.recommendedActions)
        ? response.body.recommendedActions
        : [];
      const recommendationKeys = recommendations
        .map((action: any) => action?.key)
        .filter((key: any) => typeof key === 'string');
      expect(recommendationKeys).toContain('backup_manifest_invalid');
    } finally {
      if (priorBackupDir == null) {
        delete process.env.BACKUP_DIR;
      } else {
        process.env.BACKUP_DIR = priorBackupDir;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('flags checksum mismatch when manifest hashes do not match payload files', async () => {
    const priorBackupDir = process.env.BACKUP_DIR;
    const tempDir = path.join(os.tmpdir(), `mbs-health-backup-checksum-${Date.now()}`);
    const latestDir = path.join(tempDir, '20260223T020000Z');

    await mkdir(latestDir, { recursive: true });
    await writeFile(path.join(latestDir, 'postgres.sql.gz'), 'postgres-content', 'utf8');
    await writeFile(path.join(latestDir, 'minio-data.tgz'), 'minio-content', 'utf8');
    await writeFile(
      path.join(latestDir, 'manifest.txt'),
      [
        'timestamp=20260223T020000Z',
        'postgres_file=postgres.sql.gz',
        'postgres_sha256=0000000000000000000000000000000000000000000000000000000000000000',
        'minio_file=minio-data.tgz',
        'minio_sha256=1111111111111111111111111111111111111111111111111111111111111111',
      ].join('\n'),
      'utf8',
    );

    process.env.BACKUP_DIR = tempDir;

    try {
      const response = await request
        .get('/api/system/health')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const issues = Array.isArray(response.body.issues) ? response.body.issues : [];
      const keys = issues
        .map((issue: any) => issue?.key)
        .filter((key: any) => typeof key === 'string');
      expect(keys).toContain('backup_checksum_mismatch');
      expect(response.body.metrics?.backupChecksumState).toBe('MISMATCH');

      const recommendations = Array.isArray(response.body.recommendedActions)
        ? response.body.recommendedActions
        : [];
      const recommendationKeys = recommendations
        .map((action: any) => action?.key)
        .filter((key: any) => typeof key === 'string');
      expect(recommendationKeys).toContain('backup_checksum_mismatch');
    } finally {
      if (priorBackupDir == null) {
        delete process.env.BACKUP_DIR;
      } else {
        process.env.BACKUP_DIR = priorBackupDir;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('re-evaluates checksum health immediately when backup payload files change', async () => {
    const priorBackupDir = process.env.BACKUP_DIR;
    const priorCacheTtl = process.env.HEALTH_BACKUP_CHECKSUM_CACHE_MINUTES;
    const tempDir = path.join(os.tmpdir(), `mbs-health-backup-cache-refresh-${Date.now()}`);
    const latestDir = path.join(tempDir, '20260223T025500Z');
    const postgresFile = path.join(latestDir, 'postgres.sql.gz');
    const minioFile = path.join(latestDir, 'minio-data.tgz');

    const validPostgres = gzipSync(Buffer.from('postgres-backup-ok', 'utf8'));
    const validMinioTar = gzipSync(Buffer.alloc(1024, 0));
    const postgresSha = createHash('sha256').update(validPostgres).digest('hex');
    const minioSha = createHash('sha256').update(validMinioTar).digest('hex');

    await mkdir(latestDir, { recursive: true });
    await writeFile(postgresFile, validPostgres);
    await writeFile(minioFile, validMinioTar);
    await writeFile(
      path.join(latestDir, 'manifest.txt'),
      [
        'timestamp=20260223T025500Z',
        'postgres_file=postgres.sql.gz',
        `postgres_sha256=${postgresSha}`,
        'minio_file=minio-data.tgz',
        `minio_sha256=${minioSha}`,
      ].join('\n'),
      'utf8',
    );

    process.env.BACKUP_DIR = tempDir;
    process.env.HEALTH_BACKUP_CHECKSUM_CACHE_MINUTES = '60';

    try {
      const before = await request
        .get('/api/system/health')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect(before.status, JSON.stringify(before.body)).toBe(200);
      const beforeKeys = Array.isArray(before.body.issues)
        ? before.body.issues
            .map((issue: any) => issue?.key)
            .filter((key: any) => typeof key === 'string')
        : [];
      expect(beforeKeys).not.toContain('backup_checksum_mismatch');

      await writeFile(postgresFile, gzipSync(Buffer.from('postgres-backup-mutated', 'utf8')));

      const after = await request
        .get('/api/system/health')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect(after.status, JSON.stringify(after.body)).toBe(200);
      const afterKeys = Array.isArray(after.body.issues)
        ? after.body.issues
            .map((issue: any) => issue?.key)
            .filter((key: any) => typeof key === 'string')
        : [];
      expect(afterKeys).toContain('backup_checksum_mismatch');
      expect(after.body.metrics?.backupChecksumState).toBe('MISMATCH');
    } finally {
      if (priorBackupDir == null) {
        delete process.env.BACKUP_DIR;
      } else {
        process.env.BACKUP_DIR = priorBackupDir;
      }
      if (priorCacheTtl == null) {
        delete process.env.HEALTH_BACKUP_CHECKSUM_CACHE_MINUTES;
      } else {
        process.env.HEALTH_BACKUP_CHECKSUM_CACHE_MINUTES = priorCacheTtl;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('flags archive corruption when manifest checksums match but payload archive is invalid', async () => {
    const priorBackupDir = process.env.BACKUP_DIR;
    const tempDir = path.join(os.tmpdir(), `mbs-health-backup-archive-${Date.now()}`);
    const latestDir = path.join(tempDir, '20260223T030000Z');

    const invalidGzipPayload = Buffer.from('not-a-real-gzip-archive', 'utf8');
    const invalidTarPayload = Buffer.from('not-a-real-tar-gzip-archive', 'utf8');
    const invalidGzipSha = createHash('sha256').update(invalidGzipPayload).digest('hex');
    const invalidTarSha = createHash('sha256').update(invalidTarPayload).digest('hex');

    await mkdir(latestDir, { recursive: true });
    await writeFile(path.join(latestDir, 'postgres.sql.gz'), invalidGzipPayload);
    await writeFile(path.join(latestDir, 'minio-data.tgz'), invalidTarPayload);
    await writeFile(
      path.join(latestDir, 'manifest.txt'),
      [
        'timestamp=20260223T030000Z',
        'postgres_file=postgres.sql.gz',
        `postgres_sha256=${invalidGzipSha}`,
        'minio_file=minio-data.tgz',
        `minio_sha256=${invalidTarSha}`,
      ].join('\n'),
      'utf8',
    );

    process.env.BACKUP_DIR = tempDir;

    try {
      const response = await request
        .get('/api/system/health')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const issues = Array.isArray(response.body.issues) ? response.body.issues : [];
      const keys = issues
        .map((issue: any) => issue?.key)
        .filter((key: any) => typeof key === 'string');
      expect(keys).toContain('backup_archive_corrupt');
      expect(response.body.metrics?.backupArchiveState).toBe('CORRUPT');

      const recommendations = Array.isArray(response.body.recommendedActions)
        ? response.body.recommendedActions
        : [];
      const recommendationKeys = recommendations
        .map((action: any) => action?.key)
        .filter((key: any) => typeof key === 'string');
      expect(recommendationKeys).toContain('backup_archive_corrupt');
    } finally {
      if (priorBackupDir == null) {
        delete process.env.BACKUP_DIR;
      } else {
        process.env.BACKUP_DIR = priorBackupDir;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('flags stale media upload sessions when expired initiated/failed sessions pile up', async () => {
    const priorThreshold = process.env.HEALTH_MAX_STALE_MEDIA_UPLOAD_SESSIONS;
    process.env.HEALTH_MAX_STALE_MEDIA_UPLOAD_SESSIONS = '1';

    const marker = `health-stale-media-${Date.now()}`;
    const now = Date.now();

    await prisma.mediaUploadSession.createMany({
      data: [
        {
          orgId,
          sessionKey: `${marker}-initiated`,
          status: 'INITIATED',
          ownerType: 'QUOTE',
          ownerId: `quote-${marker}`,
          tag: 'OTHER',
          fileName: 'initiated.jpg',
          mimeType: 'image/jpeg',
          createdByUserId: adminUserId,
          expiresAt: new Date(now - 60 * 60 * 1000),
        },
        {
          orgId,
          sessionKey: `${marker}-failed`,
          status: 'FAILED',
          ownerType: 'QUOTE',
          ownerId: `quote-${marker}`,
          tag: 'OTHER',
          fileName: 'failed.jpg',
          mimeType: 'image/jpeg',
          createdByUserId: adminUserId,
          expiresAt: new Date(now - 30 * 60 * 1000),
        },
        {
          orgId,
          sessionKey: `${marker}-active`,
          status: 'INITIATED',
          ownerType: 'QUOTE',
          ownerId: `quote-${marker}`,
          tag: 'OTHER',
          fileName: 'active.jpg',
          mimeType: 'image/jpeg',
          createdByUserId: adminUserId,
          expiresAt: new Date(now + 30 * 60 * 1000),
        },
      ],
    });

    try {
      const response = await request
        .get('/api/system/health')
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', adminUserId);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(Number(response.body.metrics?.staleMediaUploadSessions ?? 0)).toBeGreaterThanOrEqual(2);

      const issues = Array.isArray(response.body.issues) ? response.body.issues : [];
      const keys = issues
        .map((issue: any) => issue?.key)
        .filter((key: any) => typeof key === 'string');
      expect(keys).toContain('media_upload_sessions_stale_high');

      const recommendations = Array.isArray(response.body.recommendedActions)
        ? response.body.recommendedActions
        : [];
      const recommendationKeys = recommendations
        .map((action: any) => action?.key)
        .filter((key: any) => typeof key === 'string');
      expect(recommendationKeys).toContain('media_upload_sessions_stale_high');
    } finally {
      await prisma.mediaUploadSession.deleteMany({
        where: {
          orgId,
          sessionKey: {
            startsWith: marker,
          },
        },
      });

      if (priorThreshold == null) {
        delete process.env.HEALTH_MAX_STALE_MEDIA_UPLOAD_SESSIONS;
      } else {
        process.env.HEALTH_MAX_STALE_MEDIA_UPLOAD_SESSIONS = priorThreshold;
      }
    }
  });
});
