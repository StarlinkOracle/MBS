import {
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import supertest from 'supertest';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let request: ReturnType<typeof supertest>;
let prisma: any;
let testOrgId = '';

const ACTOR_EMAIL = 'admin@russellcomfort.com';

describeIfDb('lead care API endpoints', () => {
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
      throw new Error('Seed org russell-comfort is required for lead care tests');
    }
    testOrgId = org.id;

    const actor = await prisma.user.findFirst({
      where: {
        orgId: testOrgId,
        email: ACTOR_EMAIL,
      },
      select: { id: true },
    });
    if (!actor) {
      throw new Error(`Seed actor ${ACTOR_EMAIL} is required for lead care tests`);
    }

    await prisma.leadSlaPolicy.upsert({
      where: { orgId: testOrgId },
      create: {
        orgId: testOrgId,
        hoursByStage: {
          NEW: 1,
          CONTACTED: 2,
          QUALIFIED: 8,
          APPOINTMENT_SET: 24,
          ESTIMATE_SENT: 24,
          WON: 0,
          LOST: 0,
          NURTURE: 168,
        },
        dueSoonMinutes: 60,
      },
      update: {
        dueSoonMinutes: 60,
      },
    });
  });

  it('upserts profile, updates stage, and evaluates SLA through governed endpoints', async () => {
    const unique = Date.now().toString();
    const profileRequestId = `lead-care-profile-${unique}`;

    const create = await request
      .post('/api/leads/profile/upsert')
      .set('x-actor-email', ACTOR_EMAIL)
      .send({
        leadType: 'RESIDENTIAL_SINGLE',
        displayName: `Lead Care API ${unique}`,
        primaryContact: {
          email: `lead-care-api-${unique}@example.test`,
          phone: `+1720555${unique.slice(-4)}`,
        },
        requestId: profileRequestId,
      });

    expect(create.status, JSON.stringify(create.body)).toBe(201);
    expect(create.body?.status).toBe('EXECUTED');
    const leadId = create.body?.output?.leadId;
    expect(typeof leadId).toBe('string');

    const stage = await request
      .patch(`/api/leads/${leadId}/stage`)
      .set('x-actor-email', ACTOR_EMAIL)
      .send({
        toStage: 'CONTACTED',
        reason: 'Reached by phone',
        requestId: `lead-care-stage-${unique}`,
      });

    expect(stage.status, JSON.stringify(stage.body)).toBe(200);
    expect(stage.body?.status).toBe('EXECUTED');

    const sla = await request
      .get(`/api/leads/${leadId}/sla`)
      .set('x-actor-email', ACTOR_EMAIL);

    expect(sla.status, JSON.stringify(sla.body)).toBe(200);
    expect(sla.body?.status).toBe('EXECUTED');
    expect(['OK', 'DUE_SOON', 'OVERDUE']).toContain(sla.body?.output?.slaStatus);

    const lead = await prisma.lead.findUnique({ where: { id: leadId } });
    expect(lead?.orgId).toBe(testOrgId);
  });

  it('returns pipeline board payload with columns and lead rows', async () => {
    const response = await request
      .get('/api/leads/pipeline')
      .set('x-actor-email', ACTOR_EMAIL);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(Array.isArray(response.body?.columns)).toBe(true);
    expect(Array.isArray(response.body?.leads)).toBe(true);
  });

  it('returns lead owner candidates and supports site upsert endpoint', async () => {
    const usersResponse = await request
      .get('/api/users/lead-owners')
      .set('x-actor-email', ACTOR_EMAIL);

    expect(usersResponse.status, JSON.stringify(usersResponse.body)).toBe(200);
    expect(Array.isArray(usersResponse.body?.users)).toBe(true);
    expect(usersResponse.body.users.length).toBeGreaterThan(0);

    const unique = Date.now().toString();
    const create = await request
      .post('/api/leads/profile/upsert')
      .set('x-actor-email', ACTOR_EMAIL)
      .send({
        leadType: 'COMMERCIAL',
        displayName: `Commercial Site Lead ${unique}`,
        primaryContact: {
          email: `commercial-site-${unique}@example.test`,
        },
        requestId: `site-upsert-lead-${unique}`,
      });

    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const leadId = create.body?.output?.leadId;
    expect(typeof leadId).toBe('string');

    const siteResponse = await request
      .post(`/api/leads/${leadId}/sites`)
      .set('x-actor-email', ACTOR_EMAIL)
      .send({
        label: 'Warehouse A',
        address: {
          line1: '123 Industrial Way',
          city: 'Arvada',
          state: 'CO',
          postalCode: '80002',
        },
        property: {
          propertyType: 'COMMERCIAL',
        },
        commercial: {
          rtuCount: 3,
          rooftopAccessType: 'LADDER',
        },
      });

    expect(siteResponse.status, JSON.stringify(siteResponse.body)).toBe(201);
    expect(siteResponse.body?.status).toBe('EXECUTED');
    expect(typeof siteResponse.body?.output?.siteId).toBe('string');
  });

  it('rejects invalid stage transitions with a structured 400', async () => {
    const unique = Date.now().toString();
    const create = await request
      .post('/api/leads/profile/upsert')
      .set('x-actor-email', ACTOR_EMAIL)
      .send({
        leadType: 'RESIDENTIAL_SINGLE',
        displayName: `Invalid Stage Lead ${unique}`,
        primaryContact: {
          email: `invalid-stage-${unique}@example.test`,
        },
        requestId: `invalid-stage-profile-${unique}`,
      });

    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const leadId = create.body?.output?.leadId;

    const stage = await request
      .patch(`/api/leads/${leadId}/stage`)
      .set('x-actor-email', ACTOR_EMAIL)
      .send({
        toStage: 'NOT_A_STAGE',
        requestId: `invalid-stage-update-${unique}`,
      });

    expect(stage.status).toBe(400);
    expect(typeof stage.body?.error).toBe('string');
  });
});
