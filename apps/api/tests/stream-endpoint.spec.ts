import { randomUUID } from 'node:crypto';

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
let actorUserId = '';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('stream endpoint guardrails', () => {
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
        email: `stream-guard-${Date.now()}-${randomUUID().slice(0, 6)}@example.test`,
        name: 'Stream Guard Tester',
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
  });

  it('rejects unknown stream type filters with deterministic code', async () => {
    const response = await request
      .get('/api/stream')
      .query({
        types: 'tool.execution.created,unknown.type',
      })
      .set('x-org-slug', 'russell-comfort')
      .set('x-actor-user-id', actorUserId);

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body).toMatchObject({
      code: 'STREAM_INVALID_TYPES_FILTER',
    });
  });

  it('rejects oversized stream type filters with deterministic code', async () => {
    const previousMax = process.env.STREAM_TYPES_MAX_QUERY_BYTES;
    process.env.STREAM_TYPES_MAX_QUERY_BYTES = '16';
    try {
      const response = await request
        .get('/api/stream')
        .query({
          types: `tool.execution.created,${'x'.repeat(300)}`,
        })
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', actorUserId);

      expect(response.status, JSON.stringify(response.body)).toBe(400);
      expect(response.body).toMatchObject({
        code: 'STREAM_TYPES_FILTER_TOO_LARGE',
      });
    } finally {
      if (previousMax == null) {
        delete process.env.STREAM_TYPES_MAX_QUERY_BYTES;
      } else {
        process.env.STREAM_TYPES_MAX_QUERY_BYTES = previousMax;
      }
    }
  });

  it('rejects invalid stream since cursors with deterministic code', async () => {
    const response = await request
      .get('/api/stream')
      .query({
        since: 'not-a-date',
      })
      .set('x-org-slug', 'russell-comfort')
      .set('x-actor-user-id', actorUserId);

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body).toMatchObject({
      code: 'STREAM_INVALID_CURSOR',
    });
  });

  it('rejects oversized stream since cursors with deterministic code', async () => {
    const previousMax = process.env.STREAM_SINCE_MAX_QUERY_BYTES;
    process.env.STREAM_SINCE_MAX_QUERY_BYTES = '16';
    try {
      const response = await request
        .get('/api/stream')
        .query({
          since: `2026-02-24T12:00:00.000Z${'x'.repeat(300)}`,
        })
        .set('x-org-slug', 'russell-comfort')
        .set('x-actor-user-id', actorUserId);

      expect(response.status, JSON.stringify(response.body)).toBe(400);
      expect(response.body).toMatchObject({
        code: 'STREAM_CURSOR_TOO_LARGE',
      });
    } finally {
      if (previousMax == null) {
        delete process.env.STREAM_SINCE_MAX_QUERY_BYTES;
      } else {
        process.env.STREAM_SINCE_MAX_QUERY_BYTES = previousMax;
      }
    }
  });
});
