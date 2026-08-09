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

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

describeIfDb('receipt OCR pipeline tool handlers', () => {
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
        name: `Receipt OCR ${suffix}`,
        slug: `receipt-ocr-${suffix}`,
      },
    });

    const user = await prisma.user.create({
      data: {
        orgId: org.id,
        email: `ocr-worker-${suffix}@example.com`,
        name: 'OCR Worker',
        actorType: ActorType.SYSTEM,
      },
    });

    await prisma.toolDefinition.create({
      data: {
        orgId: org.id,
        name: 'accounting.receipt.applyOcr',
        version: '1.0.0',
        description: 'Apply OCR extraction result',
        handlerKey: 'accounting.receipt.applyOcr',
        active: true,
        riskLevel: RiskLevel.MEDIUM,
        autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
        requiredPermissions: [],
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            receiptId: { type: 'string' },
            provider: {
              type: 'string',
              enum: ['OPENAI_VISION', 'GOOGLE_VISION', 'TESSERACT'],
            },
            status: {
              type: 'string',
              enum: ['PENDING', 'COMPLETED', 'FAILED'],
            },
            extractedMerchant: { type: 'string' },
            extractedDate: { type: 'string' },
            extractedTotalCents: { type: 'integer' },
            extractedTaxCents: { type: 'integer' },
            extractedLineItems: {},
            confidence: { type: 'object' },
            rawPayload: {},
            rawText: {},
            confidenceThreshold: { type: 'number' },
            errorMessage: { type: 'string' },
          },
          required: ['receiptId', 'provider'],
        },
        endpointAllowsHumanOverride: false,
        requiresReason: false,
        requiresSnapshot: false,
      },
    });

    orgId = org.id;
    userId = user.id;
  }

  async function createReceiptWithExpense(input?: {
    vendorName?: string | null;
    totalCents?: number | null;
    taxCents?: number | null;
    purchaseDate?: Date | null;
    expenseAmountCents?: number | null;
    expenseTaxCents?: number | null;
    expenseIncurredAt?: Date | null;
  }) {
    const attachment = await prisma.attachment.create({
      data: {
        orgId,
        kind: 'RECEIPT',
        storageProvider: 'S3',
        bucket: 'rcs-local',
        objectKey: `receipts/${randomUUID()}.jpg`,
        fileName: 'receipt.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1024,
        checksumSha256: randomUUID().replace(/-/g, ''),
        uploadedByUserId: userId,
      },
    });

    const receipt = await prisma.receipt.create({
      data: {
        orgId,
        attachmentId: attachment.id,
        vendorName: input?.vendorName ?? null,
        purchaseDate: input?.purchaseDate ?? null,
        totalCents: input?.totalCents ?? null,
        taxCents: input?.taxCents ?? null,
        createdByUserId: userId,
      },
    });

    const expense = await prisma.expense.create({
      data: {
        orgId,
        receiptId: receipt.id,
        amountCents: input?.expenseAmountCents ?? null,
        taxCents: input?.expenseTaxCents ?? null,
        incurredAt: input?.expenseIncurredAt ?? null,
        createdByUserId: userId,
      },
    });

    return { receipt, expense };
  }

  it('stores OCR result and applies high-confidence values to empty receipt/expense fields', async () => {
    await setupFixture();
    const { receipt, expense } = await createReceiptWithExpense();

    const result = await registry.execute(
      'accounting.receipt.applyOcr',
      {
        receiptId: receipt.id,
        provider: 'OPENAI_VISION',
        status: 'COMPLETED',
        extractedMerchant: 'Johnstone Supply',
        extractedDate: '2026-02-18T12:00:00.000Z',
        extractedTotalCents: 12150,
        extractedTaxCents: 850,
        extractedLineItems: [{ description: 'Filter', quantity: 1, unitPriceCents: 11300 }],
        confidence: { total: 0.93, merchant: 0.91, tax: 0.9 },
        rawPayload: { provider: 'openai' },
        rawText: 'Johnstone Supply ...',
      },
      {
        orgId,
        actorType: ActorType.SYSTEM,
        actorUserId: userId,
        actorLabel: 'test-ocr-worker',
        isAutonomous: false,
      },
    );

    expect(result.status).toBe('EXECUTED');

    const updatedReceipt = await prisma.receipt.findUnique({
      where: { id: receipt.id },
    });
    const updatedExpense = await prisma.expense.findUnique({
      where: { id: expense.id },
    });
    const ocrResult = await prisma.receiptOcrResult.findUnique({
      where: { receiptId: receipt.id },
    });

    expect(updatedReceipt?.vendorName).toBe('Johnstone Supply');
    expect(updatedReceipt?.totalCents).toBe(12150);
    expect(updatedReceipt?.taxCents).toBe(850);
    expect(updatedExpense?.amountCents).toBe(12150);
    expect(updatedExpense?.taxCents).toBe(850);
    expect(updatedExpense?.incurredAt?.toISOString()).toBe('2026-02-18T12:00:00.000Z');
    expect(ocrResult?.status).toBe('COMPLETED');
    expect(ocrResult?.extractedMerchant).toBe('Johnstone Supply');
    expect(ocrResult?.extractedTotalCents).toBe(12150);
  });

  it('does not overwrite existing user-entered values when confidence is low', async () => {
    await setupFixture();
    const existingDate = new Date('2026-01-15T00:00:00.000Z');
    const { receipt, expense } = await createReceiptWithExpense({
      vendorName: 'Manual Vendor',
      totalCents: 30000,
      taxCents: 2400,
      purchaseDate: existingDate,
      expenseAmountCents: 30000,
      expenseTaxCents: 2400,
      expenseIncurredAt: existingDate,
    });

    const result = await registry.execute(
      'accounting.receipt.applyOcr',
      {
        receiptId: receipt.id,
        provider: 'OPENAI_VISION',
        status: 'COMPLETED',
        extractedMerchant: 'OCR Vendor Should Not Replace',
        extractedDate: '2026-02-18T12:00:00.000Z',
        extractedTotalCents: 99999,
        extractedTaxCents: 9999,
        confidence: { total: 0.42, merchant: 0.4 },
        rawPayload: { provider: 'openai-low' },
        rawText: 'low confidence text',
      },
      {
        orgId,
        actorType: ActorType.SYSTEM,
        actorUserId: userId,
        actorLabel: 'test-ocr-worker',
        isAutonomous: false,
      },
    );

    expect(result.status).toBe('EXECUTED');

    const updatedReceipt = await prisma.receipt.findUnique({
      where: { id: receipt.id },
    });
    const updatedExpense = await prisma.expense.findUnique({
      where: { id: expense.id },
    });

    expect(updatedReceipt?.vendorName).toBe('Manual Vendor');
    expect(updatedReceipt?.totalCents).toBe(30000);
    expect(updatedReceipt?.taxCents).toBe(2400);
    expect(updatedReceipt?.purchaseDate?.toISOString()).toBe(existingDate.toISOString());
    expect(updatedExpense?.amountCents).toBe(30000);
    expect(updatedExpense?.taxCents).toBe(2400);
    expect(updatedExpense?.incurredAt?.toISOString()).toBe(existingDate.toISOString());

    const receiptMetadata = asObject(updatedReceipt?.metadata);
    const receiptOcrMetadata = asObject(receiptMetadata.ocr);
    expect(receiptOcrMetadata.needsReview).toBe(true);
  });
});
