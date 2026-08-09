import {
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import supertest from 'supertest';

const VALID_TOKEN = 'intake-test-token';
let testOrgId = '';
let request: ReturnType<typeof supertest>;
let prisma: any;

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('website intake endpoints', () => {
  beforeAll(() => {
    process.env.MBS_INGEST_TOKENS = VALID_TOKEN;
    process.env.MBS_IP_HASH_SALT = 'intake-test-salt';
    process.env.MBS_INGEST_RATE_LIMIT_WINDOW_MS = '60000';
    process.env.MBS_INGEST_RATE_LIMIT_MAX = '1000';
  });

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
      throw new Error('Seed org russell-comfort is required for intake tests');
    }
    testOrgId = org.id;
  });

  it('rejects missing or invalid bearer tokens', async () => {
    const payload = {
      firstName: 'Auth',
      lastName: 'Test',
      email: 'auth-test@invalid.example',
      phone: '+13035550199',
      source: 'website_contact',
    };

    const missing = await request
      .post('/api/intake/contact')
      .set('x-forwarded-for', '10.0.0.1')
      .send(payload);
    expect(missing.status).toBe(401);

    const invalid = await request
      .post('/api/intake/contact')
      .set('authorization', 'Bearer invalid-token')
      .set('x-forwarded-for', '10.0.0.2')
      .send(payload);
    expect(invalid.status).toBe(401);
  });

  it('returns 503 when ingest tokens are not configured', async () => {
    const previousTokens = process.env.MBS_INGEST_TOKENS;
    delete process.env.MBS_INGEST_TOKENS;

    try {
      const response = await request
        .post('/api/intake/contact')
        .set('authorization', `Bearer ${VALID_TOKEN}`)
        .set('x-forwarded-for', '10.0.0.3')
        .send({
          firstName: 'Config',
          lastName: 'Missing',
          email: 'missing-config@example.test',
          phone: '+13035550190',
          source: 'website_contact',
        });
      expect(response.status).toBe(503);
    } finally {
      if (previousTokens == null) {
        delete process.env.MBS_INGEST_TOKENS;
      } else {
        process.env.MBS_INGEST_TOKENS = previousTokens;
      }
    }
  });

  it('returns deterministic retry-after when intake token rate limit is exceeded', async () => {
    const previousRateLimitMax = process.env.MBS_INGEST_RATE_LIMIT_MAX;
    const previousRateLimitWindow = process.env.MBS_INGEST_RATE_LIMIT_WINDOW_MS;
    process.env.MBS_INGEST_RATE_LIMIT_MAX = '1';
    process.env.MBS_INGEST_RATE_LIMIT_WINDOW_MS = '60000';

    try {
      const unique = Date.now().toString();
      const payload = {
        firstName: 'Retry',
        lastName: 'After',
        email: `retry-after-${unique}@example.test`,
        phone: `+1303555${unique.slice(-4)}`,
        source: 'website_contact',
      };

      const first = await request
        .post('/api/intake/contact')
        .set('authorization', `Bearer ${VALID_TOKEN}`)
        .set('x-forwarded-for', '10.0.0.77')
        .send(payload);
      expect(first.status, JSON.stringify(first.body)).toBe(201);

      const second = await request
        .post('/api/intake/contact')
        .set('authorization', `Bearer ${VALID_TOKEN}`)
        .set('x-forwarded-for', '10.0.0.77')
        .send(payload);
      expect(second.status, JSON.stringify(second.body)).toBe(429);
      expect(second.header['retry-after']).toBe('60');
      expect(second.body?.error).toBe('Rate limit exceeded for ingest token');
    } finally {
      if (previousRateLimitMax == null) {
        delete process.env.MBS_INGEST_RATE_LIMIT_MAX;
      } else {
        process.env.MBS_INGEST_RATE_LIMIT_MAX = previousRateLimitMax;
      }
      if (previousRateLimitWindow == null) {
        delete process.env.MBS_INGEST_RATE_LIMIT_WINDOW_MS;
      } else {
        process.env.MBS_INGEST_RATE_LIMIT_WINDOW_MS = previousRateLimitWindow;
      }
    }
  });

  it('upserts contact intake idempotently and creates SLA task + attribution', async () => {
    const unique = Date.now().toString();
    const email = `intake-${unique}@example.test`;
    const phone = `+1303555${unique.slice(-4)}`;

    const payload = {
      firstName: 'Jordan',
      lastName: 'Intake',
      email,
      phone,
      address: '123 Main St',
      city: 'Denver',
      state: 'CO',
      zip: '80212',
      serviceType: 'AC Repair',
      preferredDate: '2026-02-20',
      preferredTime: '14:00',
      message: 'Please call back ASAP.',
      utmSource: 'google',
      utmMedium: 'cpc',
      utmCampaign: 'winter-promo',
      landingUrl: 'https://example.test/landing',
      referrerUrl: 'https://google.com/search?q=ac+repair',
      visitorId: `visitor-${unique}`,
    };

    const first = await request
      .post('/api/intake/contact')
      .set('authorization', `Bearer ${VALID_TOKEN}`)
      .set('x-forwarded-for', '10.0.0.10')
      .send(payload);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(typeof first.body.leadId).toBe('string');
    expect(typeof first.body.taskId).toBe('string');

    const second = await request
      .post('/api/intake/contact')
      .set('authorization', `Bearer ${VALID_TOKEN}`)
      .set('x-forwarded-for', '10.0.0.10')
      .send(payload);
    expect(second.status).toBe(201);
    expect(second.body.leadId).toBe(first.body.leadId);

    const lead = await prisma.lead.findFirst({
      where: {
        orgId: testOrgId,
        email,
      },
    });
    expect(lead?.id).toBe(first.body.leadId);

    const [taskCount, attributionCount] = await Promise.all([
      prisma.task.count({
        where: {
          orgId: lead?.orgId,
          leadId: lead?.id,
          kind: 'CONTACT',
          queue: 'SALES',
        },
      }),
      prisma.attributionEvent.count({
        where: {
          orgId: lead?.orgId,
          leadId: lead?.id,
        },
      }),
    ]);

    expect(taskCount).toBeGreaterThanOrEqual(2);
    expect(attributionCount).toBeGreaterThanOrEqual(1);
  });

  it('creates price match request, attachment ref, and high-priority task', async () => {
    const unique = Date.now().toString();
    const email = `price-match-${unique}@example.test`;
    const phone = `+1720555${unique.slice(-4)}`;

    const payload = {
      lead: {
        name: 'Casey Pricecheck',
        phone,
        email,
        address: '400 Market St, Denver, CO 80205',
        serviceType: 'Furnace Tuneup',
      },
      intakeType: 'PRICE_MATCH',
      competitor: {
        name: 'Competitor HVAC',
        priceCents: 18900,
        notes: 'Quoted online this morning.',
      },
      attachment: {
        provider: 'URL',
        url: 'https://example.test/uploads/quote.pdf',
        fileName: 'competitor-quote.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 12345,
      },
      attribution: {
        utmSource: 'facebook',
        utmCampaign: 'spring-offer',
        visitorId: `visitor-price-${unique}`,
      },
      source: 'website_price_match',
    };

    const response = await request
      .post('/api/intake/price-match')
      .set('authorization', `Bearer ${VALID_TOKEN}`)
      .set('x-forwarded-for', '10.0.0.11')
      .send(payload);

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(typeof response.body.leadId).toBe('string');
    expect(typeof response.body.priceMatchRequestId).toBe('string');
    expect(typeof response.body.taskId).toBe('string');
    expect(typeof response.body.attachmentRefId).toBe('string');

    const lead = await prisma.lead.findFirst({
      where: {
        orgId: testOrgId,
        email,
      },
    });
    expect(lead?.id).toBe(response.body.leadId);

    const [priceMatch, task] = await Promise.all([
      prisma.priceMatchRequest.findUnique({
        where: { id: response.body.priceMatchRequestId },
        include: { attachmentRef: true },
      }),
      prisma.task.findUnique({
        where: { id: response.body.taskId },
      }),
    ]);

    expect(priceMatch?.leadId).toBe(lead?.id);
    expect(priceMatch?.attachmentRef?.id).toBe(response.body.attachmentRefId);
    expect(priceMatch?.attachmentRef?.provider).toBe('URL');
    expect(task?.kind).toBe('PRICE_MATCH');
    expect(task?.priority).toBe('HIGH');
  });
});
