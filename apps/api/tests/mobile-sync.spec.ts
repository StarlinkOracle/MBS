import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import supertest from 'supertest';

let request: ReturnType<typeof supertest>;
let prisma: any;
let orgId = '';
const orgSlug = 'russell-comfort';
let actorUserId = '';
let actorEmail = '';
let restrictedUserId = '';
let restrictedUserEmail = '';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('mobile sync endpoints', () => {
  const previousMobileRateLimitMax = process.env.MOBILE_PIN_RATE_LIMIT_MAX;
  const previousMobileSyncPushRateLimitMax = process.env.MOBILE_SYNC_PUSH_RATE_LIMIT_MAX;
  const previousMobileSyncPushRateLimitWindowMs =
    process.env.MOBILE_SYNC_PUSH_RATE_LIMIT_WINDOW_MS;
  const previousMobileSyncPullRateLimitMax = process.env.MOBILE_SYNC_PULL_RATE_LIMIT_MAX;
  const previousMobileSyncPullRateLimitWindowMs =
    process.env.MOBILE_SYNC_PULL_RATE_LIMIT_WINDOW_MS;

  beforeAll(() => {
    process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret';
    process.env.MOBILE_PIN_RATE_LIMIT_MAX = '1000';
    process.env.MOBILE_SYNC_PUSH_RATE_LIMIT_MAX =
      process.env.MOBILE_SYNC_PUSH_RATE_LIMIT_MAX ?? '1000';
    process.env.MOBILE_SYNC_PUSH_RATE_LIMIT_WINDOW_MS =
      process.env.MOBILE_SYNC_PUSH_RATE_LIMIT_WINDOW_MS ?? '60000';
    process.env.MOBILE_SYNC_PULL_RATE_LIMIT_MAX =
      process.env.MOBILE_SYNC_PULL_RATE_LIMIT_MAX ?? '1000';
    process.env.MOBILE_SYNC_PULL_RATE_LIMIT_WINDOW_MS =
      process.env.MOBILE_SYNC_PULL_RATE_LIMIT_WINDOW_MS ?? '60000';
  });

  beforeAll(async () => {
    const [{ app }, db] = await Promise.all([
      import('../src/index.js'),
      import('@rcs/db'),
    ]);
    request = supertest(app);
    prisma = db.prisma;

    const org = await prisma.organization.findUnique({
      where: { slug: orgSlug },
      select: { id: true },
    });
    if (!org) {
      throw new Error('Seed org russell-comfort is required');
    }
    orgId = org.id;

    const user = await prisma.user.create({
      data: {
        orgId,
        email: `mobile-sync-${Date.now()}@example.test`,
        name: 'Mobile Sync Tester',
        actorType: 'HUMAN',
        isActive: true,
      },
    });
    actorUserId = user.id;
    actorEmail = user.email;

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

    const setPin = await request
      .post(`/api/admin/users/${actorUserId}/pin/set`)
      .set('x-org-slug', orgSlug)
      .set('x-actor-user-id', actorUserId)
      .send({
        newPin: '1234',
        reason: 'Test setup',
      });
    if (setPin.status !== 200) {
      throw new Error(`Failed to set mobile test PIN: ${JSON.stringify(setPin.body)}`);
    }

    const restrictedUser = await prisma.user.create({
      data: {
        orgId,
        email: `mobile-sync-restricted-${Date.now()}@example.test`,
        name: 'Mobile Sync Restricted Tester',
        actorType: 'HUMAN',
        isActive: true,
      },
    });
    restrictedUserId = restrictedUser.id;
    restrictedUserEmail = restrictedUser.email;

    const setRestrictedPin = await request
      .post(`/api/admin/users/${restrictedUserId}/pin/set`)
      .set('x-org-slug', orgSlug)
      .set('x-actor-user-id', actorUserId)
      .send({
        newPin: '1234',
        reason: 'Restricted test setup',
      });
    if (setRestrictedPin.status !== 200) {
      throw new Error(`Failed to set restricted mobile test PIN: ${JSON.stringify(setRestrictedPin.body)}`);
    }
  });

  afterAll(async () => {
    if (previousMobileRateLimitMax == null) {
      delete process.env.MOBILE_PIN_RATE_LIMIT_MAX;
    } else {
      process.env.MOBILE_PIN_RATE_LIMIT_MAX = previousMobileRateLimitMax;
    }
    if (previousMobileSyncPushRateLimitMax == null) {
      delete process.env.MOBILE_SYNC_PUSH_RATE_LIMIT_MAX;
    } else {
      process.env.MOBILE_SYNC_PUSH_RATE_LIMIT_MAX = previousMobileSyncPushRateLimitMax;
    }
    if (previousMobileSyncPushRateLimitWindowMs == null) {
      delete process.env.MOBILE_SYNC_PUSH_RATE_LIMIT_WINDOW_MS;
    } else {
      process.env.MOBILE_SYNC_PUSH_RATE_LIMIT_WINDOW_MS = previousMobileSyncPushRateLimitWindowMs;
    }
    if (previousMobileSyncPullRateLimitMax == null) {
      delete process.env.MOBILE_SYNC_PULL_RATE_LIMIT_MAX;
    } else {
      process.env.MOBILE_SYNC_PULL_RATE_LIMIT_MAX = previousMobileSyncPullRateLimitMax;
    }
    if (previousMobileSyncPullRateLimitWindowMs == null) {
      delete process.env.MOBILE_SYNC_PULL_RATE_LIMIT_WINDOW_MS;
    } else {
      process.env.MOBILE_SYNC_PULL_RATE_LIMIT_WINDOW_MS = previousMobileSyncPullRateLimitWindowMs;
    }
    if (restrictedUserId) {
      await prisma.user.delete({
        where: { id: restrictedUserId },
      });
    }
    if (actorUserId) {
      await prisma.user.delete({
        where: { id: actorUserId },
      });
    }
  });

  async function loginMobile(deviceId: string, identifier: string = actorEmail): Promise<string> {
    const login = await request
      .post('/api/auth/mobile/pin/login')
      .send({
        orgSlug,
        identifier,
        pin: '1234',
        deviceId,
      });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    expect(typeof login.body.accessToken).toBe('string');
    return login.body.accessToken as string;
  }

  it('rejects push when token deviceId does not match request deviceId', async () => {
    const tokenDeviceId = `ios-token-${randomUUID().slice(0, 8)}`;
    const requestDeviceId = `ios-request-${randomUUID().slice(0, 8)}`;
    const accessToken = await loginMobile(tokenDeviceId);

    const response = await request
      .post('/api/mobile/sync/push')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        deviceId: requestDeviceId,
        actions: [
          {
            clientActionId: randomUUID(),
            toolName: 'system.killswitch.status',
            payload: {},
            reason: 'device mismatch test',
          },
        ],
      });

    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body?.error?.code).toBe('MOBILE_SYNC_DEVICE_MISMATCH');
  });

  it('returns structured auth-required error when push is missing bearer token', async () => {
    const response = await request
      .post('/api/mobile/sync/push')
      .send({
        deviceId: `ios-request-${randomUUID().slice(0, 8)}`,
        actions: [],
      });

    expect(response.status, JSON.stringify(response.body)).toBe(401);
    expect(response.body?.error?.code).toBe('MOBILE_AUTH_REQUIRED');
    expect(response.body?.error?.recoverable).toBe(true);
  });

  it('returns forbidden on push when user lacks mobile:sync permission', async () => {
    const deviceId = `ios-restricted-${randomUUID().slice(0, 8)}`;
    const accessToken = await loginMobile(deviceId, restrictedUserEmail);

    const response = await request
      .post('/api/mobile/sync/push')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        deviceId,
        actions: [],
      });

    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body?.error?.code).toBe('MOBILE_SYNC_FORBIDDEN');
    expect(response.body?.error?.recoverable).toBe(false);
  });

  it('rejects pull when token deviceId does not match request deviceId', async () => {
    const tokenDeviceId = `ios-token-${randomUUID().slice(0, 8)}`;
    const requestDeviceId = `ios-request-${randomUUID().slice(0, 8)}`;
    const accessToken = await loginMobile(tokenDeviceId);

    const response = await request
      .post('/api/mobile/sync/pull')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        deviceId: requestDeviceId,
        cursors: {},
      });

    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body?.error?.code).toBe('MOBILE_SYNC_DEVICE_MISMATCH');
  });

  it('returns structured auth-invalid-token error when pull has malformed bearer token', async () => {
    const response = await request
      .post('/api/mobile/sync/pull')
      .set('authorization', 'Bearer malformed-token')
      .send({
        deviceId: `ios-request-${randomUUID().slice(0, 8)}`,
        cursors: {},
      });

    expect(response.status, JSON.stringify(response.body)).toBe(401);
    expect(response.body?.error?.code).toBe('MOBILE_AUTH_INVALID_TOKEN');
    expect(response.body?.error?.recoverable).toBe(true);
  });

  it('returns session-invalid when mobile client session record is removed', async () => {
    const deviceId = `ios-revoked-${randomUUID().slice(0, 8)}`;
    const accessToken = await loginMobile(deviceId);

    await prisma.mobileClient.deleteMany({
      where: {
        orgId,
        userId: actorUserId,
        deviceId,
      },
    });

    const response = await request
      .post('/api/mobile/sync/pull')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        deviceId,
        cursors: {},
      });

    expect(response.status, JSON.stringify(response.body)).toBe(401);
    expect(response.body?.error?.code).toBe('MOBILE_AUTH_SESSION_INVALID');
    expect(response.body?.error?.recoverable).toBe(false);
  });

  it('rate limits push requests per user/device/source IP', async () => {
    const previousLimit = process.env.MOBILE_SYNC_PUSH_RATE_LIMIT_MAX;
    const previousWindow = process.env.MOBILE_SYNC_PUSH_RATE_LIMIT_WINDOW_MS;
    process.env.MOBILE_SYNC_PUSH_RATE_LIMIT_MAX = '1';
    process.env.MOBILE_SYNC_PUSH_RATE_LIMIT_WINDOW_MS = '60000';
    const deviceId = `ios-push-rl-${randomUUID().slice(0, 8)}`;
    const accessToken = await loginMobile(deviceId);

    try {
      const first = await request
        .post('/api/mobile/sync/push')
        .set('authorization', `Bearer ${accessToken}`)
        .set('x-forwarded-for', '10.11.0.1')
        .send({
          deviceId,
          actions: [],
        });
      expect(first.status, JSON.stringify(first.body)).toBe(200);

      const second = await request
        .post('/api/mobile/sync/push')
        .set('authorization', `Bearer ${accessToken}`)
        .set('x-forwarded-for', '10.11.0.1')
        .send({
          deviceId,
          actions: [],
        });
      expect(second.status, JSON.stringify(second.body)).toBe(429);
      expect(second.body?.error?.code).toBe('MOBILE_SYNC_PUSH_RATE_LIMITED');
      expect(second.body?.error?.recoverable).toBe(true);
      expect(second.body?.error?.retryAfterSeconds).toBe(60);
      expect(second.header['retry-after']).toBe('60');
    } finally {
      if (previousLimit == null) {
        delete process.env.MOBILE_SYNC_PUSH_RATE_LIMIT_MAX;
      } else {
        process.env.MOBILE_SYNC_PUSH_RATE_LIMIT_MAX = previousLimit;
      }
      if (previousWindow == null) {
        delete process.env.MOBILE_SYNC_PUSH_RATE_LIMIT_WINDOW_MS;
      } else {
        process.env.MOBILE_SYNC_PUSH_RATE_LIMIT_WINDOW_MS = previousWindow;
      }
    }
  });

  it('rate limits pull requests per user/device/source IP', async () => {
    const previousLimit = process.env.MOBILE_SYNC_PULL_RATE_LIMIT_MAX;
    const previousWindow = process.env.MOBILE_SYNC_PULL_RATE_LIMIT_WINDOW_MS;
    process.env.MOBILE_SYNC_PULL_RATE_LIMIT_MAX = '1';
    process.env.MOBILE_SYNC_PULL_RATE_LIMIT_WINDOW_MS = '60000';
    const deviceId = `ios-pull-rl-${randomUUID().slice(0, 8)}`;
    const accessToken = await loginMobile(deviceId);

    try {
      const first = await request
        .post('/api/mobile/sync/pull')
        .set('authorization', `Bearer ${accessToken}`)
        .set('x-forwarded-for', '10.11.0.2')
        .send({
          deviceId,
          cursors: {},
        });
      expect(first.status, JSON.stringify(first.body)).toBe(200);

      const second = await request
        .post('/api/mobile/sync/pull')
        .set('authorization', `Bearer ${accessToken}`)
        .set('x-forwarded-for', '10.11.0.2')
        .send({
          deviceId,
          cursors: {},
        });
      expect(second.status, JSON.stringify(second.body)).toBe(429);
      expect(second.body?.error?.code).toBe('MOBILE_SYNC_PULL_RATE_LIMITED');
      expect(second.body?.error?.recoverable).toBe(true);
      expect(second.body?.error?.retryAfterSeconds).toBe(60);
      expect(second.header['retry-after']).toBe('60');
    } finally {
      if (previousLimit == null) {
        delete process.env.MOBILE_SYNC_PULL_RATE_LIMIT_MAX;
      } else {
        process.env.MOBILE_SYNC_PULL_RATE_LIMIT_MAX = previousLimit;
      }
      if (previousWindow == null) {
        delete process.env.MOBILE_SYNC_PULL_RATE_LIMIT_WINDOW_MS;
      } else {
        process.env.MOBILE_SYNC_PULL_RATE_LIMIT_WINDOW_MS = previousWindow;
      }
    }
  });

  it('returns structured auth-invalid-token error when pull token uses unsupported algorithm', async () => {
    const deviceId = `ios-request-${randomUUID().slice(0, 8)}`;
    const forgedToken = jwt.sign(
      {
        type: 'mobile_access',
        sub: actorUserId,
        orgId,
        orgSlug,
        deviceId,
      },
      process.env.JWT_SECRET ?? 'test-jwt-secret',
      {
        algorithm: 'HS384',
        expiresIn: '5m',
      },
    );

    const response = await request
      .post('/api/mobile/sync/pull')
      .set('authorization', `Bearer ${forgedToken}`)
      .send({
        deviceId,
        cursors: {},
      });

    expect(response.status, JSON.stringify(response.body)).toBe(401);
    expect(response.body?.error?.code).toBe('MOBILE_AUTH_INVALID_TOKEN');
  });

  it('returns structured auth-invalid-token error when token orgSlug claim mismatches user organization', async () => {
    const deviceId = `ios-request-${randomUUID().slice(0, 8)}`;
    const forgedToken = jwt.sign(
      {
        type: 'mobile_access',
        sub: actorUserId,
        orgId,
        orgSlug: 'wrong-org-slug',
        deviceId,
      },
      process.env.JWT_SECRET ?? 'test-jwt-secret',
      {
        algorithm: 'HS256',
        expiresIn: '5m',
      },
    );

    const response = await request
      .post('/api/mobile/sync/push')
      .set('authorization', `Bearer ${forgedToken}`)
      .send({
        deviceId,
        actions: [],
      });

    expect(response.status, JSON.stringify(response.body)).toBe(401);
    expect(response.body?.error?.code).toBe('MOBILE_AUTH_INVALID_TOKEN');
  });

  it('returns pin-state-changed error when access token was issued before admin PIN change', async () => {
    const deviceId = `ios-pin-version-${randomUUID().slice(0, 8)}`;
    const baselineSet = await request
      .post(`/api/admin/users/${actorUserId}/pin/set`)
      .set('x-org-slug', orgSlug)
      .set('x-actor-user-id', actorUserId)
      .send({
        newPin: '1234',
        reason: 'Access-token pin state baseline',
      });
    expect(baselineSet.status, JSON.stringify(baselineSet.body)).toBe(200);

    const accessToken = await loginMobile(deviceId);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const rotatePin = await request
      .post(`/api/admin/users/${actorUserId}/pin/set`)
      .set('x-org-slug', orgSlug)
      .set('x-actor-user-id', actorUserId)
      .send({
        newPin: '5678',
        reason: 'Invalidate active access token',
      });
    expect(rotatePin.status, JSON.stringify(rotatePin.body)).toBe(200);

    const response = await request
      .post('/api/mobile/sync/pull')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        deviceId,
        cursors: {},
      });

    expect(response.status, JSON.stringify(response.body)).toBe(401);
    expect(response.body?.error?.code).toBe('MOBILE_AUTH_PIN_STATE_CHANGED');
    expect(response.body?.error?.recoverable).toBe(true);

    const restorePin = await request
      .post(`/api/admin/users/${actorUserId}/pin/set`)
      .set('x-org-slug', orgSlug)
      .set('x-actor-user-id', actorUserId)
      .send({
        newPin: '1234',
        reason: 'Restore baseline PIN after pin-state test',
      });
    expect(restorePin.status, JSON.stringify(restorePin.body)).toBe(200);
  });

  it('returns structured payload validation error when push deviceId format is invalid', async () => {
    const accessToken = await loginMobile(`ios-test-${randomUUID().slice(0, 8)}`);

    const response = await request
      .post('/api/mobile/sync/push')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        deviceId: 'bad device id with spaces',
        actions: [],
      });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body?.error?.code).toBe('MOBILE_SYNC_INVALID_PAYLOAD');
    const details = response.body?.error?.details ?? [];
    expect(
      details.some(
        (row: { path?: string; message?: string }) =>
          row.path === 'deviceId' && typeof row.message === 'string',
      ),
    ).toBe(true);
  });

  it('returns forbidden on pull when user lacks mobile:sync permission', async () => {
    const deviceId = `ios-restricted-${randomUUID().slice(0, 8)}`;
    const accessToken = await loginMobile(deviceId, restrictedUserEmail);

    const response = await request
      .post('/api/mobile/sync/pull')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        deviceId,
        cursors: {},
      });

    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body?.error?.code).toBe('MOBILE_SYNC_FORBIDDEN');
    expect(response.body?.error?.recoverable).toBe(false);
  });

  it('push is idempotent by clientActionId and returns stored result on replay', async () => {
    const deviceId = `ios-test-${randomUUID().slice(0, 8)}`;
    const clientActionId = randomUUID();
    const accessToken = await loginMobile(deviceId);

    const first = await request
      .post('/api/mobile/sync/push')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        deviceId,
        actions: [
          {
            clientActionId,
            toolName: 'time.clockIn',
            payload: {},
            reason: 'Mobile idempotency test',
          },
        ],
      });

    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.results?.[0]?.status).toBe('APPLIED');

    const second = await request
      .post('/api/mobile/sync/push')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        deviceId,
        actions: [
          {
            clientActionId,
            toolName: 'time.clockIn',
            payload: {},
            reason: 'Mobile idempotency test replay',
          },
        ],
      });

    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.results?.[0]?.status).toBe('APPLIED');

    const [actionCount, executionCount] = await Promise.all([
      prisma.clientAction.count({
        where: {
          orgId,
          userId: actorUserId,
          deviceId,
          clientActionId,
        },
      }),
      prisma.toolExecution.count({
        where: {
          orgId,
          actorUserId,
          clientActionId,
        },
      }),
    ]);

    expect(actionCount).toBe(1);
    expect(executionCount).toBe(1);
  });

  it('rejects reused clientActionId when tool or payload differs', async () => {
    const deviceId = `ios-test-${randomUUID().slice(0, 8)}`;
    const clientActionId = randomUUID();
    const accessToken = await loginMobile(deviceId);

    const first = await request
      .post('/api/mobile/sync/push')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        deviceId,
        actions: [
          {
            clientActionId,
            toolName: 'time.clockIn',
            payload: {},
            reason: 'Idempotency conflict setup',
          },
        ],
      });

    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.results?.[0]?.status).toBe('APPLIED');

    const second = await request
      .post('/api/mobile/sync/push')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        deviceId,
        actions: [
          {
            clientActionId,
            toolName: 'time.breakStart',
            payload: {},
            reason: 'Idempotency conflict replay',
          },
        ],
      });

    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.results?.[0]?.status).toBe('FAILED');
    expect(second.body.results?.[0]?.errorCode).toBe(
      'MOBILE_SYNC_IDEMPOTENCY_CONFLICT',
    );
    expect(second.body.results?.[0]?.recoverable).toBe(false);
  });

  it('accepts replay when payload is semantically identical but key order differs', async () => {
    const deviceId = `ios-test-${randomUUID().slice(0, 8)}`;
    const accessToken = await loginMobile(deviceId);
    const clientActionId = randomUUID();

    // Normalize prior test state so this test can deterministically open a shift.
    await request
      .post('/api/mobile/sync/push')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        deviceId,
        actions: [
          {
            clientActionId: randomUUID(),
            toolName: 'time.clockOut',
            payload: {},
            reason: 'Normalize open shift before key-order replay test',
          },
        ],
      });

    const first = await request
      .post('/api/mobile/sync/push')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        deviceId,
        actions: [
          {
            clientActionId,
            toolName: 'time.clockIn',
            payload: {
              startedAtLocal: '2026-02-24T10:00:00-07:00',
              notes: 'alpha-beta',
            },
            reason: 'Start job timer',
          },
        ],
      });

    expect(first.status).toBe(200);
    expect(first.body.results?.[0]?.status).toBe('APPLIED');

    const replay = await request
      .post('/api/mobile/sync/push')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        deviceId,
        actions: [
          {
            clientActionId,
            toolName: 'time.clockIn',
            payload: {
              notes: 'alpha-beta',
              startedAtLocal: '2026-02-24T10:00:00-07:00',
            },
            reason: 'Start job timer replay',
          },
        ],
      });

    expect(replay.status).toBe(200);
    expect(replay.body.results?.[0]?.status).toBe('APPLIED');
    expect(replay.body.results?.[0]?.errorCode).toBeUndefined();
  });

  it('pull advances cursors and returns deltas after new actions', async () => {
    const deviceId = `ios-test-${randomUUID().slice(0, 8)}`;
    const accessToken = await loginMobile(deviceId);

    const initialPull = await request
      .post('/api/mobile/sync/pull')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        deviceId,
        cursors: {},
      });

    expect(initialPull.status, JSON.stringify(initialPull.body)).toBe(200);
    const auditCursor = initialPull.body?.newCursors?.auditCursor as string;
    const outboxCursor = initialPull.body?.newCursors?.outboxCursor as string;
    expect(typeof auditCursor).toBe('string');
    expect(typeof outboxCursor).toBe('string');

    const push = await request
      .post('/api/mobile/sync/push')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        deviceId,
        actions: [
          {
            clientActionId: randomUUID(),
            toolName: 'time.breakStart',
            payload: {},
            reason: 'Mobile cursor test',
          },
        ],
      });
    expect(push.status, JSON.stringify(push.body)).toBe(200);

    const nextPull = await request
      .post('/api/mobile/sync/pull')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        deviceId,
        cursors: {
          auditCursor,
          outboxCursor,
        },
      });

    expect(nextPull.status, JSON.stringify(nextPull.body)).toBe(200);
    const nextAuditCursor = nextPull.body?.newCursors?.auditCursor as string;
    const nextOutboxCursor = nextPull.body?.newCursors?.outboxCursor as string;
    expect(new Date(nextAuditCursor).getTime()).toBeGreaterThanOrEqual(
      new Date(auditCursor).getTime(),
    );
    expect(new Date(nextOutboxCursor).getTime()).toBeGreaterThanOrEqual(
      new Date(outboxCursor).getTime(),
    );

    const auditEvents = nextPull.body?.events?.audit ?? [];
    const outboxEvents = nextPull.body?.events?.outbox ?? [];
    expect(auditEvents.length + outboxEvents.length).toBeGreaterThan(0);
  });

  it('rejects duplicate clientActionId values within a single push batch', async () => {
    const deviceId = `ios-test-${randomUUID().slice(0, 8)}`;
    const accessToken = await loginMobile(deviceId);
    const duplicateId = randomUUID();

    const response = await request
      .post('/api/mobile/sync/push')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        deviceId,
        actions: [
          {
            clientActionId: duplicateId,
            toolName: 'time.clockIn',
            payload: {},
            reason: 'dup test 1',
          },
          {
            clientActionId: duplicateId,
            toolName: 'time.breakStart',
            payload: {},
            reason: 'dup test 2',
          },
        ],
      });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body?.error?.code).toBe('MOBILE_SYNC_DUPLICATE_ACTION_IDS');
    expect(response.body?.error?.details?.duplicateActionIds).toContain(duplicateId);
  });

  it('rejects oversized individual action payloads with structured 413 errors', async () => {
    const deviceId = `ios-test-${randomUUID().slice(0, 8)}`;
    const accessToken = await loginMobile(deviceId);
    const previousActionLimit = process.env.MOBILE_SYNC_ACTION_MAX_PAYLOAD_BYTES;
    process.env.MOBILE_SYNC_ACTION_MAX_PAYLOAD_BYTES = '32';
    try {
      const response = await request
        .post('/api/mobile/sync/push')
        .set('authorization', `Bearer ${accessToken}`)
        .send({
          deviceId,
          actions: [
            {
              clientActionId: randomUUID(),
              toolName: 'time.clockIn',
              payload: {
                note: 'x'.repeat(256),
              },
              reason: 'payload size limit test',
            },
          ],
        });

      expect(response.status, JSON.stringify(response.body)).toBe(413);
      expect(response.body?.error?.code).toBe('MOBILE_SYNC_PAYLOAD_TOO_LARGE');
      const oversized = response.body?.error?.details?.oversizedActions ?? [];
      expect(Array.isArray(oversized)).toBe(true);
      expect(oversized.length).toBe(1);
      expect(typeof oversized[0]?.payloadBytes).toBe('number');
      expect(oversized[0]?.payloadBytes).toBeGreaterThan(32);
    } finally {
      process.env.MOBILE_SYNC_ACTION_MAX_PAYLOAD_BYTES = previousActionLimit;
    }
  });

  it('rejects oversized combined batch payload size with structured 413 errors', async () => {
    const deviceId = `ios-test-${randomUUID().slice(0, 8)}`;
    const accessToken = await loginMobile(deviceId);
    const previousActionLimit = process.env.MOBILE_SYNC_ACTION_MAX_PAYLOAD_BYTES;
    const previousBatchLimit = process.env.MOBILE_SYNC_BATCH_MAX_PAYLOAD_BYTES;
    process.env.MOBILE_SYNC_ACTION_MAX_PAYLOAD_BYTES = '2048';
    process.env.MOBILE_SYNC_BATCH_MAX_PAYLOAD_BYTES = '128';
    try {
      const response = await request
        .post('/api/mobile/sync/push')
        .set('authorization', `Bearer ${accessToken}`)
        .send({
          deviceId,
          actions: [
            {
              clientActionId: randomUUID(),
              toolName: 'time.clockIn',
              payload: { note: 'a'.repeat(96) },
            },
            {
              clientActionId: randomUUID(),
              toolName: 'time.breakStart',
              payload: { note: 'b'.repeat(96) },
            },
          ],
        });

      expect(response.status, JSON.stringify(response.body)).toBe(413);
      expect(response.body?.error?.code).toBe('MOBILE_SYNC_BATCH_PAYLOAD_TOO_LARGE');
      expect(response.body?.error?.details?.maxBatchPayloadBytes).toBe(128);
      expect(response.body?.error?.details?.totalPayloadBytes).toBeGreaterThan(128);
    } finally {
      process.env.MOBILE_SYNC_ACTION_MAX_PAYLOAD_BYTES = previousActionLimit;
      process.env.MOBILE_SYNC_BATCH_MAX_PAYLOAD_BYTES = previousBatchLimit;
    }
  });

  it('returns structured payload validation errors for oversized push batches', async () => {
    const deviceId = `ios-test-${randomUUID().slice(0, 8)}`;
    const accessToken = await loginMobile(deviceId);
    const actions = Array.from({ length: 201 }).map((_, index) => ({
      clientActionId: randomUUID(),
      toolName: index % 2 === 0 ? 'time.clockIn' : 'time.clockOut',
      payload: {},
      reason: `oversize-${index}`,
    }));

    const response = await request
      .post('/api/mobile/sync/push')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        deviceId,
        actions,
      });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body?.error?.code).toBe('MOBILE_SYNC_INVALID_PAYLOAD');
    const details = response.body?.error?.details ?? [];
    expect(Array.isArray(details)).toBe(true);
    expect(
      details.some(
        (row: { path?: string; message?: string }) =>
          row.path === 'actions' && typeof row.message === 'string',
      ),
    ).toBe(true);
  });

  it('returns structured payload shape error when an action payload exceeds depth limits', async () => {
    const deviceId = `ios-test-${randomUUID().slice(0, 8)}`;
    const accessToken = await loginMobile(deviceId);
    const previousDepthLimit = process.env.MOBILE_SYNC_ACTION_MAX_PAYLOAD_DEPTH;
    process.env.MOBILE_SYNC_ACTION_MAX_PAYLOAD_DEPTH = '4';

    try {
      const response = await request
        .post('/api/mobile/sync/push')
        .set('authorization', `Bearer ${accessToken}`)
        .send({
          deviceId,
          actions: [
            {
              clientActionId: randomUUID(),
              toolName: 'time.clockIn',
              payload: {
                nested: { a: { b: { c: { d: { e: true } } } } },
              },
            },
          ],
        });

      expect(response.status, JSON.stringify(response.body)).toBe(400);
      expect(response.body?.error?.code).toBe('MOBILE_SYNC_PAYLOAD_SHAPE_INVALID');
      expect(response.body?.error?.details?.maxActionPayloadDepth).toBe(4);
      expect(Array.isArray(response.body?.error?.details?.invalidActionShapes)).toBe(true);
      expect(response.body?.error?.details?.invalidActionShapes?.[0]?.reason).toBe('MAX_DEPTH_EXCEEDED');
    } finally {
      process.env.MOBILE_SYNC_ACTION_MAX_PAYLOAD_DEPTH = previousDepthLimit;
    }
  });

  it('returns structured payload validation errors for invalid toolName format', async () => {
    const deviceId = `ios-test-${randomUUID().slice(0, 8)}`;
    const accessToken = await loginMobile(deviceId);

    const response = await request
      .post('/api/mobile/sync/push')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        deviceId,
        actions: [
          {
            clientActionId: randomUUID(),
            toolName: '../time.clockIn',
            payload: {},
          },
        ],
      });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body?.error?.code).toBe('MOBILE_SYNC_INVALID_PAYLOAD');
    const details = response.body?.error?.details ?? [];
    expect(Array.isArray(details)).toBe(true);
    expect(
      details.some(
        (row: { path?: string; message?: string }) =>
          row.path === 'actions.0.toolName' && typeof row.message === 'string',
      ),
    ).toBe(true);
  });

  it('enforces runtime max actions per push limit with structured 413 response', async () => {
    const deviceId = `ios-test-${randomUUID().slice(0, 8)}`;
    const accessToken = await loginMobile(deviceId);
    const previousMaxActions = process.env.MOBILE_SYNC_MAX_ACTIONS_PER_PUSH;
    process.env.MOBILE_SYNC_MAX_ACTIONS_PER_PUSH = '2';
    try {
      const response = await request
        .post('/api/mobile/sync/push')
        .set('authorization', `Bearer ${accessToken}`)
        .send({
          deviceId,
          actions: [
            {
              clientActionId: randomUUID(),
              toolName: 'time.clockIn',
              payload: {},
            },
            {
              clientActionId: randomUUID(),
              toolName: 'time.breakStart',
              payload: {},
            },
            {
              clientActionId: randomUUID(),
              toolName: 'time.breakEnd',
              payload: {},
            },
          ],
        });

      expect(response.status, JSON.stringify(response.body)).toBe(413);
      expect(response.body?.error?.code).toBe('MOBILE_SYNC_TOO_MANY_ACTIONS');
      expect(response.body?.error?.details?.maxActionsPerPush).toBe(2);
      expect(response.body?.error?.details?.receivedActions).toBe(3);
    } finally {
      process.env.MOBILE_SYNC_MAX_ACTIONS_PER_PUSH = previousMaxActions;
    }
  });

  it('returns structured payload validation errors for malformed pull requests', async () => {
    const deviceId = `ios-test-${randomUUID().slice(0, 8)}`;
    const accessToken = await loginMobile(deviceId);

    const response = await request
      .post('/api/mobile/sync/pull')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        deviceId: '',
        cursors: {
          auditCursor: 123,
        },
      });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body?.error?.code).toBe('MOBILE_SYNC_INVALID_PAYLOAD');
    const details = response.body?.error?.details ?? [];
    expect(Array.isArray(details)).toBe(true);
    expect(
      details.some(
        (row: { path?: string; message?: string }) =>
          row.path === 'deviceId' && typeof row.message === 'string',
      ),
    ).toBe(true);
  });

  it('rejects oversized pull cursors with deterministic 413 error', async () => {
    const deviceId = `ios-test-${randomUUID().slice(0, 8)}`;
    const accessToken = await loginMobile(deviceId);
    const previousCursorLimit = process.env.MOBILE_SYNC_CURSOR_MAX_BYTES;
    process.env.MOBILE_SYNC_CURSOR_MAX_BYTES = '16';
    try {
      const response = await request
        .post('/api/mobile/sync/pull')
        .set('authorization', `Bearer ${accessToken}`)
        .send({
          deviceId,
          cursors: {
            auditCursor: `2026-02-24T12:00:00.000Z${'x'.repeat(128)}`,
            outboxCursor: '2026-02-24T12:00:00.000Z',
          },
        });

      expect(response.status, JSON.stringify(response.body)).toBe(413);
      expect(response.body?.error?.code).toBe('MOBILE_SYNC_CURSOR_TOO_LARGE');
      expect(response.body?.error?.details?.maxCursorBytes).toBe(16);
      expect(response.body?.error?.details?.oversizedCursorFields?.[0]?.field).toBe(
        'auditCursor',
      );
    } finally {
      if (previousCursorLimit == null) {
        delete process.env.MOBILE_SYNC_CURSOR_MAX_BYTES;
      } else {
        process.env.MOBILE_SYNC_CURSOR_MAX_BYTES = previousCursorLimit;
      }
    }
  });

  it('ignores incoming future cursors beyond allowed skew and falls back safely', async () => {
    const deviceId = `ios-test-${randomUUID().slice(0, 8)}`;
    const accessToken = await loginMobile(deviceId);
    const priorMaxSkew = process.env.MOBILE_SYNC_MAX_CURSOR_FUTURE_SKEW_SECONDS;
    const nowMs = Date.now();
    const farFutureIso = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString();

    process.env.MOBILE_SYNC_MAX_CURSOR_FUTURE_SKEW_SECONDS = '60';

    try {
      const response = await request
        .post('/api/mobile/sync/pull')
        .set('authorization', `Bearer ${accessToken}`)
        .send({
          deviceId,
          cursors: {
            auditCursor: farFutureIso,
            outboxCursor: farFutureIso,
          },
        });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const nextAuditCursor = new Date(response.body?.newCursors?.auditCursor ?? '').getTime();
      const nextOutboxCursor = new Date(response.body?.newCursors?.outboxCursor ?? '').getTime();
      const maxExpected = nowMs + 2 * 60 * 1000;
      expect(nextAuditCursor).toBeLessThanOrEqual(maxExpected);
      expect(nextOutboxCursor).toBeLessThanOrEqual(maxExpected);
    } finally {
      if (priorMaxSkew == null) {
        delete process.env.MOBILE_SYNC_MAX_CURSOR_FUTURE_SKEW_SECONDS;
      } else {
        process.env.MOBILE_SYNC_MAX_CURSOR_FUTURE_SKEW_SECONDS = priorMaxSkew;
      }
    }
  });

  it('recovers stale pending actions from existing tool execution without duplicate re-execution', async () => {
    const deviceId = `ios-test-${randomUUID().slice(0, 8)}`;
    const clientActionId = randomUUID();
    const accessToken = await loginMobile(deviceId);

    const first = await request
      .post('/api/mobile/sync/push')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        deviceId,
        actions: [
          {
            clientActionId,
            toolName: 'system.killswitch.status',
            payload: {},
            reason: 'stale pending recovery setup',
          },
        ],
      });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.results?.[0]?.status).toBe('APPLIED');

    await prisma.clientAction.update({
      where: {
        orgId_userId_deviceId_clientActionId: {
          orgId,
          userId: actorUserId,
          deviceId,
          clientActionId,
        },
      },
      data: {
        status: 'PENDING',
        resultJson: null,
        error: null,
        appliedAt: null,
      },
    });

    const replay = await request
      .post('/api/mobile/sync/push')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        deviceId,
        actions: [
          {
            clientActionId,
            toolName: 'system.killswitch.status',
            payload: {},
            reason: 'stale pending recovery replay',
          },
        ],
      });

    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.results?.[0]?.status).toBe('APPLIED');

    const executionCount = await prisma.toolExecution.count({
      where: {
        orgId,
        actorUserId,
        clientActionId,
      },
    });
    expect(executionCount).toBe(1);
  });

  it('returns in-progress failure when a fresh pending claim exists with no execution yet', async () => {
    const deviceId = `ios-test-${randomUUID().slice(0, 8)}`;
    const clientActionId = randomUUID();
    const accessToken = await loginMobile(deviceId);

    await prisma.clientAction.create({
      data: {
        orgId,
        userId: actorUserId,
        deviceId,
        clientActionId,
        toolName: 'system.killswitch.status',
        payloadJson: {},
        status: 'PENDING',
        error: `__IN_PROGRESS__:${new Date().toISOString()}:${randomUUID()}`,
      },
    });

    const replay = await request
      .post('/api/mobile/sync/push')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        deviceId,
        actions: [
          {
            clientActionId,
            toolName: 'system.killswitch.status',
            payload: {},
            reason: 'in-progress claim test',
          },
        ],
      });

    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.results?.[0]?.status).toBe('FAILED');
    expect(replay.body.results?.[0]?.errorCode).toBe('MOBILE_SYNC_ACTION_IN_PROGRESS');
    expect(replay.body.results?.[0]?.recoverable).toBe(true);

    const executionCount = await prisma.toolExecution.count({
      where: {
        orgId,
        actorUserId,
        clientActionId,
      },
    });
    expect(executionCount).toBe(0);
  });

  it('reclaims stale pending claims and executes action exactly once', async () => {
    const deviceId = `ios-test-${randomUUID().slice(0, 8)}`;
    const clientActionId = randomUUID();
    const accessToken = await loginMobile(deviceId);

    await prisma.clientAction.create({
      data: {
        orgId,
        userId: actorUserId,
        deviceId,
        clientActionId,
        toolName: 'system.killswitch.status',
        payloadJson: {},
        status: 'PENDING',
        error: '__IN_PROGRESS__:2000-01-01T00:00:00.000Z:stale-claim',
      },
    });

    const replay = await request
      .post('/api/mobile/sync/push')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        deviceId,
        actions: [
          {
            clientActionId,
            toolName: 'system.killswitch.status',
            payload: {},
            reason: 'stale claim reclaim test',
          },
        ],
      });

    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.results?.[0]?.status).toBe('APPLIED');
    expect(replay.body.results?.[0]?.output?.status).toBe('EXECUTED');

    const [stored, executionCount] = await Promise.all([
      prisma.clientAction.findUnique({
        where: {
          orgId_userId_deviceId_clientActionId: {
            orgId,
            userId: actorUserId,
            deviceId,
            clientActionId,
          },
        },
      }),
      prisma.toolExecution.count({
        where: {
          orgId,
          actorUserId,
          clientActionId,
        },
      }),
    ]);
    expect(stored?.status).toBe('APPLIED');
    expect(executionCount).toBe(1);
  });

  it('returns deterministic previously-failed code when legacy failed action has no structured result metadata', async () => {
    const deviceId = `ios-test-${randomUUID().slice(0, 8)}`;
    const clientActionId = randomUUID();
    const accessToken = await loginMobile(deviceId);

    await prisma.clientAction.create({
      data: {
        orgId,
        userId: actorUserId,
        deviceId,
        clientActionId,
        toolName: 'system.killswitch.status',
        payloadJson: {},
        status: 'FAILED',
        resultJson: {},
        error: 'legacy failure without code',
      },
    });

    const replay = await request
      .post('/api/mobile/sync/push')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        deviceId,
        actions: [
          {
            clientActionId,
            toolName: 'system.killswitch.status',
            payload: {},
            reason: 'legacy failed replay test',
          },
        ],
      });

    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.results?.[0]?.status).toBe('FAILED');
    expect(replay.body.results?.[0]?.errorCode).toBe(
      'MOBILE_SYNC_ACTION_PREVIOUSLY_FAILED',
    );
    expect(replay.body.results?.[0]?.recoverable).toBe(false);
  });

  it('retries recoverable failed actions and applies result on replay', async () => {
    const deviceId = `ios-test-${randomUUID().slice(0, 8)}`;
    const clientActionId = randomUUID();
    const accessToken = await loginMobile(deviceId);

    await prisma.clientAction.create({
      data: {
        orgId,
        userId: actorUserId,
        deviceId,
        clientActionId,
        toolName: 'time.clockIn',
        payloadJson: {},
        status: 'FAILED',
        resultJson: {
          status: 'FAILED',
          error: 'Operation timed out after 50ms',
          errorCode: 'MOBILE_SYNC_ACTION_TIMEOUT',
          recoverable: true,
          timeoutMs: 50,
        },
        error: 'Operation timed out after 50ms',
        appliedAt: new Date(),
      },
    });

    const replay = await request
      .post('/api/mobile/sync/push')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        deviceId,
        actions: [
          {
            clientActionId,
            toolName: 'time.clockIn',
            payload: {},
            reason: 'recoverable replay',
          },
        ],
      });

    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.results?.[0]?.status).toBe('APPLIED');
    expect(replay.body.results?.[0]?.output?.status).toBe('EXECUTED');

    const stored = await prisma.clientAction.findUnique({
      where: {
        orgId_userId_deviceId_clientActionId: {
          orgId,
          userId: actorUserId,
          deviceId,
          clientActionId,
        },
      },
    });
    expect(stored?.status).toBe('APPLIED');

    const executionCount = await prisma.toolExecution.count({
      where: {
        orgId,
        actorUserId,
        clientActionId,
      },
    });
    expect(executionCount).toBe(1);

    const clockOutActionId = randomUUID();
    const clockOut = await request
      .post('/api/mobile/sync/push')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        deviceId,
        actions: [
          {
            clientActionId: clockOutActionId,
            toolName: 'time.clockOut',
            payload: {},
            reason: 'test cleanup',
          },
        ],
      });
    expect(clockOut.status, JSON.stringify(clockOut.body)).toBe(200);
  });

  it('handles per-action execution exceptions without aborting the full push batch', async () => {
    const deviceId = `ios-test-${randomUUID().slice(0, 8)}`;
    const accessToken = await loginMobile(deviceId);
    const failingActionId = randomUUID();
    const succeedingActionId = randomUUID();

    const response = await request
      .post('/api/mobile/sync/push')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        deviceId,
        actions: [
          {
            clientActionId: failingActionId,
            toolName: 'mobile.unknown.tool',
            payload: {},
            reason: 'intentional failure',
          },
          {
            clientActionId: succeedingActionId,
            toolName: 'system.killswitch.status',
            payload: {},
            reason: 'must still execute',
          },
        ],
      });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.results).toHaveLength(2);
    expect(response.body.results?.[0]?.clientActionId).toBe(failingActionId);
    expect(response.body.results?.[0]?.status).toBe('FAILED');
    expect(response.body.results?.[0]?.errorCode).toBe('TOOL_NOT_FOUND');
    expect(response.body.results?.[0]?.recoverable).toBe(false);
    expect(response.body.results?.[1]?.clientActionId).toBe(succeedingActionId);
    expect(response.body.results?.[1]?.status).toBe('APPLIED');
  });

  it('pull cursor tracks same-timestamp boundary ids without missing or repeating events', async () => {
    const deviceId = `ios-test-${randomUUID().slice(0, 8)}`;
    const accessToken = await loginMobile(deviceId);
    const sharedTs = new Date('2099-01-01T00:00:00.000Z');

    const [firstAudit, secondAudit] = await Promise.all([
      prisma.auditLog.create({
        data: {
          orgId,
          actorType: 'SYSTEM',
          action: 'mobile.cursor.boundary.first',
          entityType: 'Test',
          entityId: randomUUID(),
          createdAt: sharedTs,
        },
      }),
      prisma.auditLog.create({
        data: {
          orgId,
          actorType: 'SYSTEM',
          action: 'mobile.cursor.boundary.second',
          entityType: 'Test',
          entityId: randomUUID(),
          createdAt: sharedTs,
        },
      }),
    ]);

    await prisma.mobileSyncCursor.upsert({
      where: {
        orgId_userId_deviceId_cursorType: {
          orgId,
          userId: actorUserId,
          deviceId,
          cursorType: 'AUDITLOG',
        },
      },
      update: {
        cursorValue: JSON.stringify({
          ts: sharedTs.toISOString(),
          ids: [firstAudit.id],
        }),
      },
      create: {
        orgId,
        userId: actorUserId,
        deviceId,
        cursorType: 'AUDITLOG',
        cursorValue: JSON.stringify({
          ts: sharedTs.toISOString(),
          ids: [firstAudit.id],
        }),
      },
    });

    await prisma.mobileSyncCursor.upsert({
      where: {
        orgId_userId_deviceId_cursorType: {
          orgId,
          userId: actorUserId,
          deviceId,
          cursorType: 'OUTBOX',
        },
      },
      update: {
        cursorValue: sharedTs.toISOString(),
      },
      create: {
        orgId,
        userId: actorUserId,
        deviceId,
        cursorType: 'OUTBOX',
        cursorValue: sharedTs.toISOString(),
      },
    });

    const firstPull = await request
      .post('/api/mobile/sync/pull')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        deviceId,
        cursors: {},
      });

    expect(firstPull.status, JSON.stringify(firstPull.body)).toBe(200);
    const firstAuditIds = (firstPull.body?.events?.audit ?? []).map(
      (row: { id: string }) => row.id,
    );
    expect(firstAuditIds).toContain(secondAudit.id);
    expect(firstAuditIds).not.toContain(firstAudit.id);

    const secondPull = await request
      .post('/api/mobile/sync/pull')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        deviceId,
        cursors: firstPull.body?.newCursors ?? {},
      });

    expect(secondPull.status, JSON.stringify(secondPull.body)).toBe(200);
    const secondAuditIds = (secondPull.body?.events?.audit ?? []).map(
      (row: { id: string }) => row.id,
    );
    expect(secondAuditIds).not.toContain(firstAudit.id);
    expect(secondAuditIds).not.toContain(secondAudit.id);
  });

  it('pull uses stored server cursor precedence over stale incoming cursor values', async () => {
    const deviceId = `ios-test-${randomUUID().slice(0, 8)}`;
    const accessToken = await loginMobile(deviceId);
    const cursorTs = new Date('2099-02-01T00:00:00.000Z');
    const staleTs = new Date('2099-01-01T00:00:00.000Z');

    const audit = await prisma.auditLog.create({
      data: {
        orgId,
        actorType: 'SYSTEM',
        action: 'mobile.cursor.stored.precedence',
        entityType: 'Test',
        entityId: randomUUID(),
        createdAt: cursorTs,
      },
    });

    await prisma.mobileSyncCursor.upsert({
      where: {
        orgId_userId_deviceId_cursorType: {
          orgId,
          userId: actorUserId,
          deviceId,
          cursorType: 'AUDITLOG',
        },
      },
      update: {
        cursorValue: JSON.stringify({
          ts: cursorTs.toISOString(),
          ids: [audit.id],
        }),
      },
      create: {
        orgId,
        userId: actorUserId,
        deviceId,
        cursorType: 'AUDITLOG',
        cursorValue: JSON.stringify({
          ts: cursorTs.toISOString(),
          ids: [audit.id],
        }),
      },
    });

    await prisma.mobileSyncCursor.upsert({
      where: {
        orgId_userId_deviceId_cursorType: {
          orgId,
          userId: actorUserId,
          deviceId,
          cursorType: 'OUTBOX',
        },
      },
      update: {
        cursorValue: cursorTs.toISOString(),
      },
      create: {
        orgId,
        userId: actorUserId,
        deviceId,
        cursorType: 'OUTBOX',
        cursorValue: cursorTs.toISOString(),
      },
    });

    const response = await request
      .post('/api/mobile/sync/pull')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        deviceId,
        cursors: {
          auditCursor: staleTs.toISOString(),
          outboxCursor: staleTs.toISOString(),
        },
      });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const auditIds = (response.body?.events?.audit ?? []).map(
      (row: { id: string }) => row.id,
    );
    expect(auditIds).not.toContain(audit.id);
  });

  it('pull enforces configured event limits and reports hasMore flags', async () => {
    const deviceId = `ios-test-${randomUUID().slice(0, 8)}`;
    const accessToken = await loginMobile(deviceId);
    const previousAuditLimit = process.env.MOBILE_SYNC_PULL_MAX_AUDIT_EVENTS;
    const previousOutboxLimit = process.env.MOBILE_SYNC_PULL_MAX_OUTBOX_EVENTS;
    process.env.MOBILE_SYNC_PULL_MAX_AUDIT_EVENTS = '1';
    process.env.MOBILE_SYNC_PULL_MAX_OUTBOX_EVENTS = '1';
    try {
      const now = new Date();
      await prisma.auditLog.createMany({
        data: [
          {
            orgId,
            actorType: 'HUMAN',
            actorUserId,
            action: 'mobile.pull.limit.test.1',
            entityType: 'TEST',
            entityId: randomUUID(),
            metadata: {},
            createdAt: new Date(now.getTime() + 1_000),
          },
          {
            orgId,
            actorType: 'HUMAN',
            actorUserId,
            action: 'mobile.pull.limit.test.2',
            entityType: 'TEST',
            entityId: randomUUID(),
            metadata: {},
            createdAt: new Date(now.getTime() + 2_000),
          },
        ],
      });
      await prisma.eventOutbox.createMany({
        data: [
          {
            orgId,
            eventType: 'mobile.pull.limit.test.1',
            payload: {},
            status: 'PENDING',
            createdAt: new Date(now.getTime() + 1_000),
            availableAt: new Date(now.getTime() + 1_000),
          },
          {
            orgId,
            eventType: 'mobile.pull.limit.test.2',
            payload: {},
            status: 'PENDING',
            createdAt: new Date(now.getTime() + 2_000),
            availableAt: new Date(now.getTime() + 2_000),
          },
        ],
      });

      const response = await request
        .post('/api/mobile/sync/pull')
        .set('authorization', `Bearer ${accessToken}`)
        .send({
          deviceId,
          cursors: {
            auditCursor: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
            outboxCursor: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
          },
        });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect((response.body?.events?.audit ?? []).length).toBe(1);
      expect((response.body?.events?.outbox ?? []).length).toBe(1);
      expect(response.body?.pageInfo?.auditHasMore).toBe(true);
      expect(response.body?.pageInfo?.outboxHasMore).toBe(true);
      expect(response.body?.pageInfo?.limits?.maxAuditEvents).toBe(1);
      expect(response.body?.pageInfo?.limits?.maxOutboxEvents).toBe(1);
    } finally {
      process.env.MOBILE_SYNC_PULL_MAX_AUDIT_EVENTS = previousAuditLimit;
      process.env.MOBILE_SYNC_PULL_MAX_OUTBOX_EVENTS = previousOutboxLimit;
    }
  });

  it('pull enforces today schedule appointment caps and reports truncation', async () => {
    const deviceId = `ios-test-${randomUUID().slice(0, 8)}`;
    const accessToken = await loginMobile(deviceId);
    const previousTodayLimit = process.env.MOBILE_SYNC_PULL_MAX_TODAY_APPOINTMENTS;
    process.env.MOBILE_SYNC_PULL_MAX_TODAY_APPOINTMENTS = '1';
    try {
      const date = new Date();
      const dateOnly = new Date(
        Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
      );
      await prisma.appointment.createMany({
        data: [
          {
            orgId,
            type: 'SERVICE_ESTIMATE',
            date: dateOnly,
            timeBlockCode: 'BLOCK_0800_1000',
            status: 'BOOKED',
            assignedTechId: actorUserId,
          },
          {
            orgId,
            type: 'SERVICE_ESTIMATE',
            date: dateOnly,
            timeBlockCode: 'BLOCK_1000_1200',
            status: 'BOOKED',
            assignedTechId: actorUserId,
          },
        ],
      });

      const response = await request
        .post('/api/mobile/sync/pull')
        .set('authorization', `Bearer ${accessToken}`)
        .send({
          deviceId,
          cursors: {},
        });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const todaySchedule = response.body?.readModels?.todaySchedule;
      expect((todaySchedule?.appointments ?? []).length).toBe(1);
      expect(todaySchedule?.appointmentsTruncated).toBe(true);
      expect(response.body?.pageInfo?.limits?.maxTodayAppointments).toBe(1);
    } finally {
      process.env.MOBILE_SYNC_PULL_MAX_TODAY_APPOINTMENTS = previousTodayLimit;
    }
  });
});
