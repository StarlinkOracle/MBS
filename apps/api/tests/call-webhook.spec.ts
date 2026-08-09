import {
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import supertest from 'supertest';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('call webhook endpoint hardening', () => {
  let request: ReturnType<typeof supertest>;
  let prisma: any;

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
      throw new Error('Seed org russell-comfort is required for webhook tests');
    }
  });

  it('returns 503 when call webhook secret is not configured', async () => {
    const previousSecret = process.env.CALL_WEBHOOK_SECRET;
    delete process.env.CALL_WEBHOOK_SECRET;

    try {
      const response = await request
        .post('/api/webhooks/calls')
        .set('x-org-slug', 'russell-comfort')
        .set('x-webhook-secret', 'any-secret')
        .send({});

      expect(response.status, JSON.stringify(response.body)).toBe(503);
      expect(response.body?.error).toBe('Webhook secret is not configured');
    } finally {
      if (previousSecret == null) {
        delete process.env.CALL_WEBHOOK_SECRET;
      } else {
        process.env.CALL_WEBHOOK_SECRET = previousSecret;
      }
    }
  });

  it('returns 401 for invalid webhook secret when configured', async () => {
    const previousSecret = process.env.CALL_WEBHOOK_SECRET;
    process.env.CALL_WEBHOOK_SECRET = 'call-webhook-test-secret';

    try {
      const response = await request
        .post('/api/webhooks/calls')
        .set('x-org-slug', 'russell-comfort')
        .set('x-webhook-secret', 'wrong-secret')
        .send({});

      expect(response.status, JSON.stringify(response.body)).toBe(401);
      expect(response.body?.error).toBe('Unauthorized webhook secret');
    } finally {
      if (previousSecret == null) {
        delete process.env.CALL_WEBHOOK_SECRET;
      } else {
        process.env.CALL_WEBHOOK_SECRET = previousSecret;
      }
    }
  });

  it('rate limits repeated webhook calls from same source ip', async () => {
    const previousSecret = process.env.CALL_WEBHOOK_SECRET;
    const previousRateLimitMax = process.env.CALL_WEBHOOK_RATE_LIMIT_MAX;
    const previousRateLimitWindow = process.env.CALL_WEBHOOK_RATE_LIMIT_WINDOW_MS;
    process.env.CALL_WEBHOOK_SECRET = 'call-webhook-test-secret';
    process.env.CALL_WEBHOOK_RATE_LIMIT_MAX = '1';
    process.env.CALL_WEBHOOK_RATE_LIMIT_WINDOW_MS = '60000';

    try {
      const first = await request
        .post('/api/webhooks/calls')
        .set('x-org-slug', 'russell-comfort')
        .set('x-forwarded-for', '10.21.0.1')
        .set('x-webhook-secret', 'wrong-secret')
        .send({});
      expect(first.status, JSON.stringify(first.body)).toBe(401);

      const second = await request
        .post('/api/webhooks/calls')
        .set('x-org-slug', 'russell-comfort')
        .set('x-forwarded-for', '10.21.0.1')
        .set('x-webhook-secret', 'wrong-secret')
        .send({});
      expect(second.status, JSON.stringify(second.body)).toBe(429);
      expect(second.body?.error?.code).toBe('CALL_WEBHOOK_RATE_LIMITED');
      expect(second.body?.error?.recoverable).toBe(true);
      expect(second.body?.error?.retryAfterSeconds).toBe(60);
      expect(second.header['retry-after']).toBe('60');
    } finally {
      if (previousSecret == null) {
        delete process.env.CALL_WEBHOOK_SECRET;
      } else {
        process.env.CALL_WEBHOOK_SECRET = previousSecret;
      }
      if (previousRateLimitMax == null) {
        delete process.env.CALL_WEBHOOK_RATE_LIMIT_MAX;
      } else {
        process.env.CALL_WEBHOOK_RATE_LIMIT_MAX = previousRateLimitMax;
      }
      if (previousRateLimitWindow == null) {
        delete process.env.CALL_WEBHOOK_RATE_LIMIT_WINDOW_MS;
      } else {
        process.env.CALL_WEBHOOK_RATE_LIMIT_WINDOW_MS = previousRateLimitWindow;
      }
    }
  });
});
