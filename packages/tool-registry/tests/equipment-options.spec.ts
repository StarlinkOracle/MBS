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

describeIfDb('catalog.equipment.options.generate', () => {
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
        name: `Options ${suffix}`,
        slug: `options-${suffix}`,
      },
    });

    const user = await prisma.user.create({
      data: {
        orgId: org.id,
        email: `options-${suffix}@example.com`,
        name: 'Options User',
        actorType: ActorType.HUMAN,
      },
    });

    await prisma.toolDefinition.create({
      data: {
        orgId: org.id,
        name: 'catalog.equipment.options.generate',
        version: '1.0.0',
        description: 'Generate options',
        handlerKey: 'catalog.equipment.options.generate',
        active: true,
        riskLevel: RiskLevel.LOW,
        autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
        requiredPermissions: [],
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            assessmentId: { type: 'string' },
            addOns: { type: 'array' },
          },
          required: ['assessmentId'],
        },
        endpointAllowsHumanOverride: false,
        requiresReason: false,
        requiresSnapshot: false,
      },
    });

    const source = await prisma.equipmentCatalogSource.create({
      data: {
        orgId: org.id,
        name: 'Options Source',
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
          rawText: 'Goodman Condenser 3 Ton',
          manufacturer: 'Goodman',
          systemTypeHint: 'Condenser',
          rawJson: {
            model: 'GSX130361',
            manufacturer: 'Goodman',
            systemType: 'Condenser',
            priceCents: 420000,
          } as Prisma.InputJsonValue,
        },
        {
          orgId: org.id,
          sourceId: source.id,
          rawSku: 'ASX140361',
          rawText: 'Amana Condenser 3 Ton',
          manufacturer: 'Amana',
          systemTypeHint: 'Condenser',
          rawJson: {
            model: 'ASX140361',
            manufacturer: 'Amana',
            systemType: 'Condenser',
            priceCents: 510000,
          } as Prisma.InputJsonValue,
        },
        {
          orgId: org.id,
          sourceId: source.id,
          rawSku: 'AMHP150361',
          rawText: 'Amana Heat Pump 3 Ton',
          manufacturer: 'Amana',
          systemTypeHint: 'Heat Pump',
          rawJson: {
            model: 'AMHP150361',
            manufacturer: 'Amana',
            systemType: 'Heat Pump',
            priceCents: 640000,
          } as Prisma.InputJsonValue,
        },
      ],
    });

    const assessment = await prisma.systemAssessment.create({
      data: {
        orgId: org.id,
        existingTonnage: 3,
        existingSystemType: 'Condenser',
      },
      select: { id: true },
    });

    orgId = org.id;
    userId = user.id;

    return { assessmentId: assessment.id };
  }

  it('generates good/better/best options and applies add-ons to totals', async () => {
    const { assessmentId } = await setupFixture();

    const result = await registry.execute(
      'catalog.equipment.options.generate',
      {
        assessmentId,
        addOns: ['humidifier', 'uv'],
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'options-test',
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
    const tiers = Array.isArray(output.tiers)
      ? (output.tiers as Array<Record<string, unknown>>)
      : [];

    expect(tiers).toHaveLength(3);

    const good = tiers.find((tier) => tier.tier === 'GOOD');
    const better = tiers.find((tier) => tier.tier === 'BETTER');
    const best = tiers.find((tier) => tier.tier === 'BEST');

    expect(good?.available).toBe(true);
    expect(better?.available).toBe(true);
    expect(best?.available).toBe(true);

    expect(good?.model).toBe('GSX130361');
    expect(better?.model).toBe('ASX140361');
    expect(best?.model).toBe('AMHP150361');

    expect(Number(good?.totalPriceCents)).toBe(420000 + 75000 + 35000);
  });
});
