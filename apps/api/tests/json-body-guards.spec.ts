import {
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import supertest from 'supertest';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('api json body guardrails', () => {
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
      throw new Error('Seed org russell-comfort is required for json body guard tests');
    }
  });

  it('returns deterministic 400 when payload JSON is malformed', async () => {
    const response = await request
      .post('/api/mobile/sync/push')
      .set('content-type', 'application/json')
      .send('{"deviceId":');

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body?.error?.code).toBe('API_JSON_INVALID');
    expect(response.body?.error?.recoverable).toBe(true);
  });

  it('returns deterministic 413 when payload exceeds configured json body limit', async () => {
    const payload = JSON.stringify({
      blob: 'x'.repeat(1024 * 1024 + 32768),
    });

    const response = await request
      .post('/api/mobile/sync/push')
      .set('content-type', 'application/json')
      .send(payload);

    expect(response.status, JSON.stringify(response.body)).toBe(413);
    expect(response.body?.error?.code).toBe('API_JSON_PAYLOAD_TOO_LARGE');
    expect(response.body?.error?.recoverable).toBe(true);
    expect(response.body?.error?.details?.limit).toBeDefined();
  });
});
