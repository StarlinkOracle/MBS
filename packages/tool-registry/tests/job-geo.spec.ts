import { randomUUID } from 'node:crypto';

import {
  ActorType,
  AutonomyLevel,
  PrismaClient,
  RiskLevel,
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

describeIfDb('job geotagging enforcement', () => {
  const prisma = new PrismaClient();
  const registry = new ToolRegistry(prisma);

  let orgId = '';
  let userId = '';

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterEach(async () => {
    if (orgId) {
      await prisma.organization.delete({ where: { id: orgId } });
    }
    orgId = '';
    userId = '';
  });

  async function setupFixture() {
    const suffix = randomUUID().slice(0, 8);
    const org = await prisma.organization.create({
      data: {
        name: `Geo ${suffix}`,
        slug: `geo-${suffix}`,
      },
    });

    const user = await prisma.user.create({
      data: {
        orgId: org.id,
        email: `geo-${suffix}@example.com`,
        name: 'Geo User',
        actorType: ActorType.HUMAN,
      },
    });

    await prisma.toolDefinition.createMany({
      data: [
        {
          orgId: org.id,
          name: 'jobs.job.create',
          version: '1.0.0',
          description: 'Create job',
          handlerKey: 'jobs.job.create',
          active: true,
          riskLevel: RiskLevel.MEDIUM,
          autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
          requiredPermissions: [],
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              customerId: { type: 'string' },
              title: { type: 'string' },
              addressLine1: { type: 'string' },
              city: { type: 'string' },
              state: { type: 'string' },
              postalCode: { type: 'string' },
            },
            required: ['title'],
          },
          endpointAllowsHumanOverride: false,
          requiresReason: false,
          requiresSnapshot: false,
        },
        {
          orgId: org.id,
          name: 'jobs.geo.ensure',
          version: '1.0.0',
          description: 'Ensure job geotag',
          handlerKey: 'jobs.geo.ensure',
          active: true,
          riskLevel: RiskLevel.MEDIUM,
          autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
          requiredPermissions: [],
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              jobId: { type: 'string' },
              addressLine1: { type: 'string' },
              city: { type: 'string' },
              state: { type: 'string' },
              postalCode: { type: 'string' },
            },
            required: ['jobId'],
          },
          endpointAllowsHumanOverride: false,
          requiresReason: false,
          requiresSnapshot: false,
        },
      ],
    });

    orgId = org.id;
    userId = user.id;
  }

  it('creates JobGeo when jobs.job.create executes', async () => {
    await setupFixture();

    const customer = await prisma.customer.create({
      data: {
        orgId,
        fullName: 'Geo Customer',
        addressLine1: '123 Main St',
        city: 'Denver',
        state: 'CO',
        postalCode: '80212',
      },
    });

    const result = await registry.execute(
      'jobs.job.create',
      {
        customerId: customer.id,
        title: 'Install Furnace',
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'geo-test',
        isAutonomous: false,
      },
    );

    expect(result.status).toBe('EXECUTED');
    if (result.status !== 'EXECUTED') {
      return;
    }

    const output =
      result.output && typeof result.output === 'object' && !Array.isArray(result.output)
        ? (result.output as Record<string, unknown>)
        : {};
    const job = output.job as Record<string, unknown>;
    expect(typeof job.id).toBe('string');

    const jobGeo = await prisma.jobGeo.findUnique({
      where: { jobId: String(job.id) },
    });
    expect(jobGeo).not.toBeNull();
    expect(jobGeo?.addressNormalized.length).toBeGreaterThan(0);
  });

  it('fallback geotag keeps city/zip and null lat/lng when no geocoder provider is configured', async () => {
    await setupFixture();

    const priorMapbox = process.env.MAPBOX_TOKEN;
    const priorGoogle = process.env.GOOGLE_MAPS_KEY;
    delete process.env.MAPBOX_TOKEN;
    delete process.env.GOOGLE_MAPS_KEY;

    try {
      const job = await prisma.job.create({
        data: {
          orgId,
          title: 'No Geocoder Provider Job',
          status: 'OPEN',
        },
      });

      const result = await registry.execute(
        'jobs.geo.ensure',
        {
          jobId: job.id,
          addressLine1: '200 Market St',
          city: 'Denver',
          state: 'CO',
          postalCode: '80205',
        },
        {
          orgId,
          actorType: ActorType.HUMAN,
          actorUserId: userId,
          actorLabel: 'geo-test',
          isAutonomous: false,
        },
      );

      expect(result.status).toBe('EXECUTED');

      const jobGeo = await prisma.jobGeo.findUnique({
        where: { jobId: job.id },
      });
      expect(jobGeo).not.toBeNull();
      expect(jobGeo?.city).toBe('Denver');
      expect(jobGeo?.zip).toBe('80205');
      expect(jobGeo?.lat).toBeNull();
      expect(jobGeo?.lng).toBeNull();
    } finally {
      if (priorMapbox !== undefined) {
        process.env.MAPBOX_TOKEN = priorMapbox;
      } else {
        delete process.env.MAPBOX_TOKEN;
      }
      if (priorGoogle !== undefined) {
        process.env.GOOGLE_MAPS_KEY = priorGoogle;
      } else {
        delete process.env.GOOGLE_MAPS_KEY;
      }
    }
  });
});
