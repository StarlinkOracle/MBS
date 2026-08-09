import {
  ActorType,
  type PrismaClient,
} from '@rcs/db';
import type { ToolRegistry } from '@rcs/tool-registry';

import { extractReceiptFields } from './ocr.js';

type ReceiptUploadedEventPayload = {
  receiptId?: unknown;
  executionId?: unknown;
};

function toPlainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

async function resolveReceiptId(
  prisma: PrismaClient,
  orgId: string,
  payload: ReceiptUploadedEventPayload,
): Promise<string | null> {
  const directReceiptId = toStringOrNull(payload.receiptId);
  if (directReceiptId) {
    return directReceiptId;
  }

  const executionId = toStringOrNull(payload.executionId);
  if (!executionId) {
    return null;
  }

  const execution = await prisma.toolExecution.findFirst({
    where: {
      id: executionId,
      orgId,
    },
    select: {
      outputPayload: true,
    },
  });
  if (!execution?.outputPayload || typeof execution.outputPayload !== 'object' || Array.isArray(execution.outputPayload)) {
    return null;
  }
  return toStringOrNull((execution.outputPayload as Record<string, unknown>).receiptId);
}

async function resolveActorUserId(
  prisma: PrismaClient,
  orgId: string,
): Promise<string | null> {
  const adminUser = await prisma.user.findFirst({
    where: {
      orgId,
      isActive: true,
      userRoles: {
        some: {
          role: {
            name: 'admin',
          },
        },
      },
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  if (adminUser) {
    return adminUser.id;
  }

  const systemUser = await prisma.user.findFirst({
    where: {
      orgId,
      isActive: true,
      actorType: ActorType.SYSTEM,
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  if (systemUser) {
    return systemUser.id;
  }

  const humanUser = await prisma.user.findFirst({
    where: {
      orgId,
      isActive: true,
      actorType: ActorType.HUMAN,
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  return humanUser?.id ?? null;
}

export async function processReceiptUploaded(args: {
  prisma: PrismaClient;
  registry: ToolRegistry;
  orgId: string;
  payload: unknown;
}) {
  const payload = toPlainObject(args.payload) as ReceiptUploadedEventPayload;
  const receiptId = await resolveReceiptId(args.prisma, args.orgId, payload);
  if (!receiptId) {
    throw new Error('receipt.uploaded event missing receiptId');
  }

  const actorUserId = await resolveActorUserId(args.prisma, args.orgId);
  if (!actorUserId) {
    throw new Error('No active actor found for OCR worker execution');
  }

  const requestResult = await args.registry.execute(
    'accounting.receipt.ocr.request',
    { receiptId },
    {
      orgId: args.orgId,
      actorType: ActorType.SYSTEM,
      actorUserId,
      actorLabel: 'ocr-worker',
      isAutonomous: false,
      reason: 'receipt.ocr.process',
    },
  );

  if (requestResult.status !== 'EXECUTED') {
    throw new Error(
      `OCR request tool did not execute: ${requestResult.status}`,
    );
  }

  const output = toPlainObject(requestResult.output);
  const attachment = toPlainObject(output.attachment);
  const bucket = toStringOrNull(attachment.bucket);
  const objectKey = toStringOrNull(attachment.objectKey);
  const mimeType = toStringOrNull(attachment.mimeType);

  if (!bucket || !objectKey) {
    throw new Error('OCR request did not return attachment location');
  }

  try {
    const extraction = await extractReceiptFields({
      bucket,
      objectKey,
      mimeType,
    });

    const applyResult = await args.registry.execute(
      'accounting.receipt.applyOcr',
      {
        receiptId,
        provider: extraction.provider,
        status: 'COMPLETED',
        extractedMerchant: extraction.extractedMerchant,
        extractedDate: extraction.extractedDate,
        extractedTotalCents: extraction.extractedTotalCents,
        extractedTaxCents: extraction.extractedTaxCents,
        extractedLineItems: extraction.extractedLineItems,
        confidence: extraction.confidence,
        rawText: extraction.rawText,
        rawPayload: extraction.rawPayload,
        confidenceThreshold: 0.85,
      },
      {
        orgId: args.orgId,
        actorType: ActorType.SYSTEM,
        actorUserId,
        actorLabel: 'ocr-worker',
        isAutonomous: false,
        reason: 'receipt.ocr.apply',
      },
    );

    if (applyResult.status !== 'EXECUTED') {
      throw new Error(`OCR apply tool did not execute: ${applyResult.status}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'OCR extraction failed';
    const applyFailureResult = await args.registry.execute(
      'accounting.receipt.applyOcr',
      {
        receiptId,
        provider: 'OPENAI_VISION',
        status: 'FAILED',
        confidence: { total: 0 },
        rawPayload: {
          error: message,
          source: 'ocr-worker',
        },
        errorMessage: message,
        confidenceThreshold: 0.85,
      },
      {
        orgId: args.orgId,
        actorType: ActorType.SYSTEM,
        actorUserId,
        actorLabel: 'ocr-worker',
        isAutonomous: false,
        reason: 'receipt.ocr.failed',
      },
    );

    if (applyFailureResult.status !== 'EXECUTED') {
      throw new Error(`Failed to persist OCR failure: ${applyFailureResult.status}`);
    }
  }
}
