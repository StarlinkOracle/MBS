import { randomUUID } from 'node:crypto';

import {
  ActorType,
  AutonomyLevel,
  EquipmentCatalogSourceStatus,
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

describeIfDb('catalog.equipment.importCsv', () => {
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
        name: `Catalog ${suffix}`,
        slug: `catalog-${suffix}`,
      },
    });

    const user = await prisma.user.create({
      data: {
        orgId: org.id,
        email: `catalog-${suffix}@example.com`,
        name: 'Catalog User',
        actorType: ActorType.HUMAN,
      },
    });

    await prisma.toolDefinition.create({
      data: {
        orgId: org.id,
        name: 'catalog.equipment.importCsv',
        version: '1.0.0',
        description: 'Import equipment catalog CSV',
        handlerKey: 'catalog.equipment.importCsv',
        active: true,
        riskLevel: RiskLevel.MEDIUM,
        autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
        requiredPermissions: [],
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sourceName: { type: 'string' },
            csvContent: { type: 'string' },
            attachmentRefId: { type: 'string' },
            mapping: { type: 'object' },
            metadata: { type: 'object' },
          },
          required: ['sourceName', 'csvContent'],
        },
        endpointAllowsHumanOverride: false,
        requiresReason: false,
        requiresSnapshot: false,
      },
    });

    orgId = org.id;
    userId = user.id;
  }

  it('imports rows using default heuristics and marks source ready', async () => {
    await setupFixture();

    const csvContent = [
      'Item Number,Description,Brand,Category',
      'GSX130361,Goodman 3 Ton Condenser,Goodman,Condenser',
    ].join('\n');

    const result = await registry.execute(
      'catalog.equipment.importCsv',
      {
        sourceName: 'Distributor Spring 2026',
        csvContent,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'catalog-test',
        isAutonomous: false,
      },
    );

    expect(result.status).toBe('EXECUTED');
    const source = await prisma.equipmentCatalogSource.findFirst({
      where: { orgId },
      include: {
        entries: true,
      },
    });

    expect(source).not.toBeNull();
    expect(source?.status).toBe(EquipmentCatalogSourceStatus.READY);
    expect(source?.entries).toHaveLength(1);
    expect(source?.entries[0]?.rawSku).toBe('GSX130361');
    expect(source?.entries[0]?.manufacturer).toBe('Goodman');
    expect(source?.entries[0]?.systemTypeHint).toBe('Condenser');
  });

  it('respects explicit column mapping overrides', async () => {
    await setupFixture();

    const csvContent = [
      'part_no,title,make,equipment_class',
      'AMV80805CN,Amana Furnace 80k BTU,Amana,Furnace',
    ].join('\n');

    const result = await registry.execute(
      'catalog.equipment.importCsv',
      {
        sourceName: 'Distributor Custom Columns',
        csvContent,
        mapping: {
          skuColumn: 'part_no',
          manufacturerColumn: 'make',
          systemTypeColumn: 'equipment_class',
          textColumns: ['title', 'equipment_class'],
        },
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: userId,
        actorLabel: 'catalog-test',
        isAutonomous: false,
      },
    );

    expect(result.status).toBe('EXECUTED');
    const entry = await prisma.equipmentCatalogEntry.findFirst({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
    });

    expect(entry).not.toBeNull();
    expect(entry?.rawSku).toBe('AMV80805CN');
    expect(entry?.manufacturer).toBe('Amana');
    expect(entry?.systemTypeHint).toBe('Furnace');
    expect(entry?.rawText).toContain('Amana Furnace 80k BTU');
  });
});
