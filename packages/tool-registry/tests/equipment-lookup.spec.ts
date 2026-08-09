import { randomUUID } from 'node:crypto';

import {
  ActorType,
  AutonomyLevel,
  EquipmentCatalogSourceStatus,
  EquipmentCatalogSourceType,
  Prisma,
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

describeIfDb('equipment lookup + select tools', () => {
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
        name: `Lookup ${suffix}`,
        slug: `lookup-${suffix}`,
      },
    });

    const user = await prisma.user.create({
      data: {
        orgId: org.id,
        email: `lookup-${suffix}@example.com`,
        name: 'Lookup User',
        actorType: ActorType.HUMAN,
      },
    });

    await prisma.toolDefinition.createMany({
      data: [
        {
          orgId: org.id,
          name: 'catalog.equipment.lookup',
          version: '1.0.0',
          description: 'Lookup catalog entries',
          handlerKey: 'catalog.equipment.lookup',
          active: true,
          riskLevel: RiskLevel.LOW,
          autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
          requiredPermissions: [],
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              query: { type: 'string' },
              manufacturer: { type: 'string' },
              systemType: { type: 'string' },
              limit: { type: 'integer' },
            },
            required: ['query'],
          },
          endpointAllowsHumanOverride: false,
          requiresReason: false,
          requiresSnapshot: false,
        },
        {
          orgId: org.id,
          name: 'crm.equipmentSpec.selectForAssessment',
          version: '1.0.0',
          description: 'Select equipment spec',
          handlerKey: 'crm.equipmentSpec.selectForAssessment',
          active: true,
          riskLevel: RiskLevel.MEDIUM,
          autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
          requiredPermissions: [],
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              assessmentId: { type: 'string' },
              query: { type: 'string' },
              selected: { type: 'object' },
              selectedEntryId: { type: 'string' },
              selectedCandidateIndex: { type: 'integer' },
              results: { type: 'array' },
            },
            required: ['assessmentId'],
          },
          endpointAllowsHumanOverride: false,
          requiresReason: false,
          requiresSnapshot: false,
        },
      ],
    });

    const source = await prisma.equipmentCatalogSource.create({
      data: {
        orgId: org.id,
        name: 'Distributor CSV',
        type: EquipmentCatalogSourceType.CSV,
        status: EquipmentCatalogSourceStatus.READY,
      },
      select: { id: true },
    });

    await prisma.equipmentCatalogEntry.createMany({
      data: [
        {
          orgId: org.id,
          sourceId: source.id,
          rawSku: 'GSX130361',
          rawText: 'Goodman Condenser 3 Ton 14 SEER',
          manufacturer: 'Goodman',
          systemTypeHint: 'Condenser',
          rawJson: {
            model: 'GSX130361',
            manufacturer: 'Goodman',
            systemType: 'Condenser',
            seer: '14',
          } as Prisma.InputJsonValue,
        },
        {
          orgId: org.id,
          sourceId: source.id,
          rawSku: 'AMV80805CN',
          rawText: 'Amana Furnace 80k BTU',
          manufacturer: 'Amana',
          systemTypeHint: 'Furnace',
          rawJson: {
            model: 'AMV80805CN',
            manufacturer: 'Amana',
            systemType: 'Furnace',
            btu: '80000',
            afue: '80',
          } as Prisma.InputJsonValue,
        },
      ],
    });

    const assessment = await prisma.systemAssessment.create({
      data: {
        orgId: org.id,
      },
      select: { id: true },
    });

    orgId = org.id;
    userId = user.id;

    return { assessmentId: assessment.id };
  }

  it('returns ranked lookup candidates and persists selected spec to assessment', async () => {
    const { assessmentId } = await setupFixture();

    const lookupResult = await registry.execute(
      'catalog.equipment.lookup',
      {
        query: 'GSX130361',
        manufacturer: 'Goodman',
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'lookup-test',
        isAutonomous: false,
      },
    );

    expect(lookupResult.status).toBe('EXECUTED');
    if (lookupResult.status !== 'EXECUTED') {
      return;
    }

    const output =
      lookupResult.output && typeof lookupResult.output === 'object' && !Array.isArray(lookupResult.output)
        ? (lookupResult.output as Record<string, unknown>)
        : {};
    const candidates = Array.isArray(output.candidates)
      ? (output.candidates as Array<Record<string, unknown>>)
      : [];

    expect(candidates.length).toBeGreaterThan(0);
    const first = candidates[0] ?? {};
    expect(first.model).toBe('GSX130361');
    expect(first.tonnage).toBe(3);

    const selectResult = await registry.execute(
      'crm.equipmentSpec.selectForAssessment',
      {
        assessmentId,
        query: 'GSX130361',
        selected: first,
        results: candidates,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'lookup-test',
        isAutonomous: false,
      },
    );

    expect(selectResult.status, JSON.stringify(selectResult)).toBe('EXECUTED');
    if (selectResult.status !== 'EXECUTED') {
      return;
    }

    const selectOutput =
      selectResult.output && typeof selectResult.output === 'object' && !Array.isArray(selectResult.output)
        ? (selectResult.output as Record<string, unknown>)
        : {};
    expect(typeof selectOutput.selectedSpecId).toBe('string');
    expect(typeof selectOutput.lookupRunId).toBe('string');

    const [assessment, lookupRun] = await Promise.all([
      prisma.systemAssessment.findUnique({ where: { id: assessmentId } }),
      prisma.equipmentLookupRun.findFirst({
        where: {
          orgId,
          assessmentId,
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    expect(assessment?.existingModel).toBe('GSX130361');
    expect(assessment?.existingTonnage).toBe(3);
    expect(lookupRun?.selectedSpecId).toBe(String(selectOutput.selectedSpecId));
  });
});
