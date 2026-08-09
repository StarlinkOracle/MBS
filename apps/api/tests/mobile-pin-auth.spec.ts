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
let orgSlug = 'russell-comfort';
let adminUserId = '';
let techUserId = '';
let techEmail = '';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('mobile pin auth', () => {
  beforeAll(() => {
    process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret';
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

    const createdEmail = `mobile-tech-${Date.now()}@example.test`;
    const techUser = await prisma.user.create({
      data: {
        orgId,
        email: createdEmail,
        name: 'Mobile Pin Tech',
        actorType: 'HUMAN',
        phone: '+17205559999',
        employeeCode: `RCS-TEC-${randomUUID().slice(0, 6).toUpperCase()}`,
        isActive: true,
      },
    });
    techUserId = techUser.id;
    techEmail = createdEmail;

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

  it('admin can set PIN and tech can login with mobile token response', async () => {
    const setPin = await request
      .post(`/api/admin/users/${techUserId}/pin/set`)
      .set('x-org-slug', orgSlug)
      .set('x-actor-user-id', adminUserId)
      .send({
        newPin: '1234',
        reason: 'Pilot provisioning',
      });

    expect(setPin.status, JSON.stringify(setPin.body)).toBe(200);
    expect(setPin.body.status).toBe('EXECUTED');

    const login = await request
      .post('/api/auth/mobile/pin/login')
      .send({
        orgSlug,
        identifier: techEmail,
        pin: '1234',
        deviceId: `ios-${randomUUID().slice(0, 8)}`,
      });

    expect(login.status, JSON.stringify(login.body)).toBe(200);
    expect(typeof login.body.accessToken).toBe('string');
    expect(Array.isArray(login.body.roles)).toBe(true);
  });

  it('refreshes mobile session token when refresh token and deviceId are valid', async () => {
    const deviceId = `ios-refresh-${randomUUID().slice(0, 8)}`;
    const setPin = await request
      .post(`/api/admin/users/${techUserId}/pin/set`)
      .set('x-org-slug', orgSlug)
      .set('x-actor-user-id', adminUserId)
      .send({
        newPin: '1234',
        reason: 'Refresh flow test setup',
      });
    expect(setPin.status, JSON.stringify(setPin.body)).toBe(200);

    const login = await request
      .post('/api/auth/mobile/pin/login')
      .send({
        orgSlug,
        identifier: techEmail,
        pin: '1234',
        deviceId,
      });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    expect(typeof login.body.refreshToken).toBe('string');

    const refresh = await request
      .post('/api/auth/mobile/refresh')
      .send({
        refreshToken: login.body.refreshToken,
        deviceId,
      });

    expect(refresh.status, JSON.stringify(refresh.body)).toBe(200);
    expect(typeof refresh.body.accessToken).toBe('string');
    expect(typeof refresh.body.refreshToken).toBe('string');
    expect(refresh.body.device?.id).toBe(deviceId);
  });

  it('rejects refresh when mobile client session record has been removed', async () => {
    const deviceId = `ios-refresh-revoked-${randomUUID().slice(0, 8)}`;
    const setPin = await request
      .post(`/api/admin/users/${techUserId}/pin/set`)
      .set('x-org-slug', orgSlug)
      .set('x-actor-user-id', adminUserId)
      .send({
        newPin: '1234',
        reason: 'Refresh revoked-session test setup',
      });
    expect(setPin.status, JSON.stringify(setPin.body)).toBe(200);

    const login = await request
      .post('/api/auth/mobile/pin/login')
      .send({
        orgSlug,
        identifier: techEmail,
        pin: '1234',
        deviceId,
      });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    expect(typeof login.body.refreshToken).toBe('string');

    await prisma.mobileClient.deleteMany({
      where: {
        orgId,
        userId: techUserId,
        deviceId,
      },
    });

    const refresh = await request
      .post('/api/auth/mobile/refresh')
      .send({
        refreshToken: login.body.refreshToken,
        deviceId,
      });

    expect(refresh.status, JSON.stringify(refresh.body)).toBe(401);
    expect(refresh.body?.code).toBe('AUTH_REFRESH_SESSION_INVALID');
    expect(refresh.body?.recoverable).toBe(false);
  });

  it('rejects refresh when request deviceId does not match token deviceId', async () => {
    const deviceId = `ios-refresh-${randomUUID().slice(0, 8)}`;
    const otherDeviceId = `ios-other-${randomUUID().slice(0, 8)}`;
    const setPin = await request
      .post(`/api/admin/users/${techUserId}/pin/set`)
      .set('x-org-slug', orgSlug)
      .set('x-actor-user-id', adminUserId)
      .send({
        newPin: '1234',
        reason: 'Refresh mismatch test setup',
      });
    expect(setPin.status, JSON.stringify(setPin.body)).toBe(200);
    const login = await request
      .post('/api/auth/mobile/pin/login')
      .send({
        orgSlug,
        identifier: techEmail,
        pin: '1234',
        deviceId,
      });
    expect(login.status, JSON.stringify(login.body)).toBe(200);

    const refresh = await request
      .post('/api/auth/mobile/refresh')
      .send({
        refreshToken: login.body.refreshToken,
        deviceId: otherDeviceId,
      });

    expect(refresh.status, JSON.stringify(refresh.body)).toBe(403);
    expect(refresh.body?.code).toBe('AUTH_REFRESH_DEVICE_MISMATCH');
  });

  it('rejects refresh for unsupported token algorithm', async () => {
    const deviceId = `ios-refresh-${randomUUID().slice(0, 8)}`;
    const forgedRefresh = jwt.sign(
      {
        type: 'mobile_refresh',
        sub: techUserId,
        orgId,
        orgSlug,
        deviceId,
        pinVersion: 0,
      },
      process.env.JWT_SECRET ?? 'test-jwt-secret',
      {
        algorithm: 'HS384',
        expiresIn: '5m',
      },
    );

    const refresh = await request
      .post('/api/auth/mobile/refresh')
      .send({
        refreshToken: forgedRefresh,
        deviceId,
      });

    expect(refresh.status, JSON.stringify(refresh.body)).toBe(401);
    expect(refresh.body?.code).toBe('AUTH_REFRESH_INVALID_TOKEN');
  });

  it('invalidates old refresh token after admin sets a new PIN', async () => {
    const deviceId = `ios-refresh-pinset-${randomUUID().slice(0, 8)}`;
    const initialSet = await request
      .post(`/api/admin/users/${techUserId}/pin/set`)
      .set('x-org-slug', orgSlug)
      .set('x-actor-user-id', adminUserId)
      .send({
        newPin: '1234',
        reason: 'Refresh invalidation setup',
      });
    expect(initialSet.status, JSON.stringify(initialSet.body)).toBe(200);

    const login = await request
      .post('/api/auth/mobile/pin/login')
      .send({
        orgSlug,
        identifier: techEmail,
        pin: '1234',
        deviceId,
      });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    expect(typeof login.body.refreshToken).toBe('string');

    const rotatePin = await request
      .post(`/api/admin/users/${techUserId}/pin/set`)
      .set('x-org-slug', orgSlug)
      .set('x-actor-user-id', adminUserId)
      .send({
        newPin: '5678',
        reason: 'Invalidate previous refresh tokens',
      });
    expect(rotatePin.status, JSON.stringify(rotatePin.body)).toBe(200);

    const refresh = await request
      .post('/api/auth/mobile/refresh')
      .send({
        refreshToken: login.body.refreshToken,
        deviceId,
      });

    expect(refresh.status, JSON.stringify(refresh.body)).toBe(401);
    expect(refresh.body?.code).toBe('AUTH_REFRESH_PIN_STATE_CHANGED');
    expect(refresh.body?.recoverable).toBe(true);
  });

  it('invalidates old refresh token after admin PIN reset', async () => {
    const deviceId = `ios-refresh-pinreset-${randomUUID().slice(0, 8)}`;
    const initialSet = await request
      .post(`/api/admin/users/${techUserId}/pin/set`)
      .set('x-org-slug', orgSlug)
      .set('x-actor-user-id', adminUserId)
      .send({
        newPin: '6789',
        reason: 'Refresh invalidation reset setup',
      });
    expect(initialSet.status, JSON.stringify(initialSet.body)).toBe(200);

    const login = await request
      .post('/api/auth/mobile/pin/login')
      .send({
        orgSlug,
        identifier: techEmail,
        pin: '6789',
        deviceId,
      });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    expect(typeof login.body.refreshToken).toBe('string');

    const reset = await request
      .post(`/api/admin/users/${techUserId}/pin/reset`)
      .set('x-org-slug', orgSlug)
      .set('x-actor-user-id', adminUserId)
      .send({
        temporaryPin: '4321',
        reason: 'Invalidate previous refresh tokens on reset',
      });
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);

    const refresh = await request
      .post('/api/auth/mobile/refresh')
      .send({
        refreshToken: login.body.refreshToken,
        deviceId,
      });

    expect(refresh.status, JSON.stringify(refresh.body)).toBe(401);
    expect(refresh.body?.code).toBe('AUTH_REFRESH_PIN_STATE_CHANGED');
    expect(refresh.body?.recoverable).toBe(true);
  });

  it('returns deterministic rate-limited error when refresh attempts exceed configured limit', async () => {
    const previousWindow = process.env.MOBILE_REFRESH_RATE_LIMIT_WINDOW_MS;
    const previousMax = process.env.MOBILE_REFRESH_RATE_LIMIT_MAX;
    process.env.MOBILE_REFRESH_RATE_LIMIT_WINDOW_MS = '300000';
    process.env.MOBILE_REFRESH_RATE_LIMIT_MAX = '1';
    try {
      const deviceId = `ios-refresh-limit-${randomUUID().slice(0, 8)}`;
      const setPin = await request
        .post(`/api/admin/users/${techUserId}/pin/set`)
        .set('x-org-slug', orgSlug)
        .set('x-actor-user-id', adminUserId)
        .send({
          newPin: '1234',
          reason: 'Rate limit test setup',
        });
      expect(setPin.status, JSON.stringify(setPin.body)).toBe(200);

      const login = await request
        .post('/api/auth/mobile/pin/login')
        .send({
          orgSlug,
          identifier: techEmail,
          pin: '1234',
          deviceId,
        });
      expect(login.status, JSON.stringify(login.body)).toBe(200);
      expect(typeof login.body.refreshToken).toBe('string');

      const firstRefresh = await request
        .post('/api/auth/mobile/refresh')
        .send({
          refreshToken: login.body.refreshToken,
          deviceId,
        });
      expect(firstRefresh.status, JSON.stringify(firstRefresh.body)).toBe(200);

      const secondRefresh = await request
        .post('/api/auth/mobile/refresh')
        .send({
          refreshToken: login.body.refreshToken,
          deviceId,
        });
      expect(secondRefresh.status, JSON.stringify(secondRefresh.body)).toBe(429);
      expect(secondRefresh.body?.code).toBe('AUTH_REFRESH_RATE_LIMITED');
      expect(secondRefresh.body?.recoverable).toBe(true);
    } finally {
      if (previousWindow == null) {
        delete process.env.MOBILE_REFRESH_RATE_LIMIT_WINDOW_MS;
      } else {
        process.env.MOBILE_REFRESH_RATE_LIMIT_WINDOW_MS = previousWindow;
      }
      if (previousMax == null) {
        delete process.env.MOBILE_REFRESH_RATE_LIMIT_MAX;
      } else {
        process.env.MOBILE_REFRESH_RATE_LIMIT_MAX = previousMax;
      }
    }
  });

  it('returns deterministic invalid-payload error for malformed deviceId format', async () => {
    const response = await request
      .post('/api/auth/mobile/pin/login')
      .send({
        orgSlug,
        identifier: techEmail,
        pin: '1234',
        deviceId: 'bad device id with spaces',
      });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body?.code).toBe('AUTH_PIN_INVALID_PAYLOAD');
    const details = response.body?.details ?? [];
    expect(
      details.some(
        (row: { path?: string; message?: string }) =>
          row.path === 'deviceId' && typeof row.message === 'string',
      ),
    ).toBe(true);
  });

  it('returns deterministic invalid-payload error for malformed orgSlug format', async () => {
    const response = await request
      .post('/api/auth/mobile/pin/login')
      .send({
        orgSlug: 'RUSSELL COMFORT',
        identifier: techEmail,
        pin: '1234',
        deviceId: `ios-${randomUUID().slice(0, 8)}`,
      });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body?.code).toBe('AUTH_PIN_INVALID_PAYLOAD');
    const details = response.body?.details ?? [];
    expect(
      details.some(
        (row: { path?: string; message?: string }) =>
          row.path === 'orgSlug' && typeof row.message === 'string',
      ),
    ).toBe(true);
  });

  it('returns deterministic invalid-payload error for malformed admin pin set payload', async () => {
    const response = await request
      .post(`/api/admin/users/${techUserId}/pin/set`)
      .set('x-org-slug', orgSlug)
      .set('x-actor-user-id', adminUserId)
      .send({
        newPin: '12ab',
        reason: 'invalid test',
      });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body?.code).toBe('AUTH_PIN_SET_INVALID_PAYLOAD');
    const details = response.body?.details ?? [];
    expect(
      details.some(
        (row: { path?: string; message?: string }) =>
          row.path === 'newPin' && typeof row.message === 'string',
      ),
    ).toBe(true);
  });

  it('invalid pin attempts lock account after threshold', async () => {
    const setPin = await request
      .post(`/api/admin/users/${techUserId}/pin/set`)
      .set('x-org-slug', orgSlug)
      .set('x-actor-user-id', adminUserId)
      .send({
        newPin: '2468',
        reason: 'Reset for lockout test',
      });

    expect(setPin.status, JSON.stringify(setPin.body)).toBe(200);

    for (let i = 0; i < 5; i += 1) {
      const attempt = await request
        .post('/api/auth/mobile/pin/login')
        .send({
          orgSlug,
          identifier: techEmail,
          pin: '9999',
          deviceId: `ios-lock-${i}`,
        });

      expect(attempt.status).toBe(401);
      if (i < 4) {
        expect(attempt.body.code).toBe('AUTH_PIN_INVALID');
      }
    }

    const lockedAttempt = await request
      .post('/api/auth/mobile/pin/login')
      .send({
        orgSlug,
        identifier: techEmail,
        pin: '2468',
        deviceId: 'ios-lock-check',
      });

    expect(lockedAttempt.status).toBe(401);
    expect(lockedAttempt.body.code).toBe('AUTH_PIN_LOCKED');
  });

  it('admin reset requires user reset flag and set clears it', async () => {
    const reset = await request
      .post(`/api/admin/users/${techUserId}/pin/reset`)
      .set('x-org-slug', orgSlug)
      .set('x-actor-user-id', adminUserId)
      .send({
        reason: 'Pilot reset flow',
      });

    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    expect(reset.body.status).toBe('EXECUTED');

    const output = reset.body.output ?? {};
    expect(typeof output.temporaryPin).toBe('string');

    const login = await request
      .post('/api/auth/mobile/pin/login')
      .send({
        orgSlug,
        identifier: techEmail,
        pin: output.temporaryPin,
        deviceId: `ios-reset-${randomUUID().slice(0, 8)}`,
      });

    expect(login.status, JSON.stringify(login.body)).toBe(200);
    expect(login.body.user?.mobilePinResetRequired).toBe(true);

    const set = await request
      .post(`/api/admin/users/${techUserId}/pin/set`)
      .set('x-org-slug', orgSlug)
      .set('x-actor-user-id', adminUserId)
      .send({
        newPin: '1357',
        reason: 'Complete reset cycle',
      });

    expect(set.status, JSON.stringify(set.body)).toBe(200);

    const after = await request
      .post('/api/auth/mobile/pin/login')
      .send({
        orgSlug,
        identifier: techEmail,
        pin: '1357',
        deviceId: `ios-reset-final-${randomUUID().slice(0, 8)}`,
      });

    expect(after.status, JSON.stringify(after.body)).toBe(200);
    expect(after.body.user?.mobilePinResetRequired).toBe(false);
  });

  it('returns deterministic invalid-payload error for malformed admin pin reset payload', async () => {
    const response = await request
      .post(`/api/admin/users/${techUserId}/pin/reset`)
      .set('x-org-slug', orgSlug)
      .set('x-actor-user-id', adminUserId)
      .send({
        temporaryPin: 'abcd',
        reason: 'invalid payload test',
      });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body?.code).toBe('AUTH_PIN_RESET_INVALID_PAYLOAD');
    const details = response.body?.details ?? [];
    expect(
      details.some(
        (row: { path?: string; message?: string }) =>
          row.path === 'temporaryPin' && typeof row.message === 'string',
      ),
    ).toBe(true);
  });
});
