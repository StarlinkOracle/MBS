import {
  createHash,
} from 'node:crypto';
import {
  readFile,
} from 'node:fs/promises';

import {
  ActorType,
  ImportProvider,
  ImportRunStatus,
  type Prisma,
  type PrismaClient,
} from '@rcs/db';
import type { ToolExecutionResponse, ToolRegistry } from '@rcs/tool-registry';

const JOBBER_CSV_TYPES = [
  'clients',
  'products_services',
  'quotes_report',
  'invoices_report',
] as const;

type JobberCsvType = (typeof JOBBER_CSV_TYPES)[number];

type JobberCsvImportRequestedPayload = {
  importRunId?: unknown;
  filePath?: unknown;
  csvContent?: unknown;
  type?: unknown;
  dryRun?: unknown;
  actorUserId?: unknown;
};

type ImportStats = {
  acceptedRows: number;
  processed: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  queuedApprovals: number;
  dryRun: boolean;
  errors: Array<{
    rowNumber: number;
    sourceId: string;
    message: string;
  }>;
};

type RowPlan = {
  sourceType: JobberCsvType;
  sourceId: string;
  rawHash: string;
  toolName: string;
  mbsType: string;
  payload: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
};

type ParsedLineItem = {
  description: string;
  quantity?: number;
  unitPriceCents?: number;
};

type ParsedLineItems = {
  parsed: boolean;
  items: ParsedLineItem[];
  rawLineItemsText?: string;
};

type CsvRow = Record<string, string>;

type NormalizedLookup = Record<string, string>;

function isJobberCsvType(value: unknown): value is JobberCsvType {
  return typeof value === 'string' && (JOBBER_CSV_TYPES as readonly string[]).includes(value);
}

function toPlainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function normalizeKey(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function normalizeRow(row: CsvRow): CsvRow {
  const normalized: CsvRow = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[key.trim()] = value.trim();
  }
  return normalized;
}

function buildLookup(row: CsvRow): NormalizedLookup {
  const lookup: NormalizedLookup = {};
  for (const [key, value] of Object.entries(row)) {
    const normalizedKey = normalizeKey(key);
    if (!normalizedKey) {
      continue;
    }
    lookup[normalizedKey] = value.trim();
  }
  return lookup;
}

function pick(lookup: NormalizedLookup, candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    const normalized = normalizeKey(candidate);
    if (!normalized) {
      continue;
    }
    const value = lookup[normalized];
    if (value && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function parseCurrencyToCents(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const sanitized = value.replace(/[^0-9.-]/g, '');
  if (!sanitized) {
    return undefined;
  }
  const numeric = Number(sanitized);
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  return Math.round(numeric * 100);
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const numeric = Number(value.replace(/,/g, '').trim());
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  return numeric;
}

function parseLineItems(text: string | undefined): ParsedLineItems {
  if (!text || text.trim().length === 0) {
    return {
      parsed: true,
      items: [],
    };
  }

  const lines = text
    .replace(/\r/g, '\n')
    .split(/\n|;/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return {
      parsed: false,
      items: [],
      rawLineItemsText: text,
    };
  }

  const items: ParsedLineItem[] = [];
  let parsedStructured = false;

  for (const line of lines) {
    const qtyAtPrice = line.match(/^(.*?)[xX×]\s*([0-9]+(?:\.[0-9]+)?)\s*@\s*\$?([0-9,]+(?:\.[0-9]{1,2})?)$/);
    if (qtyAtPrice) {
      const quantity = parseNumber(qtyAtPrice[2]);
      const unitPriceCents = parseCurrencyToCents(qtyAtPrice[3]);
      items.push({
        description: qtyAtPrice[1].trim(),
        ...(typeof quantity === 'number' ? { quantity } : {}),
        ...(typeof unitPriceCents === 'number' ? { unitPriceCents } : {}),
      });
      parsedStructured = true;
      continue;
    }

    const qtyPriceCompact = line.match(/^(.*?)\s+qty[:\s]*([0-9]+(?:\.[0-9]+)?)\s+.*?\$?([0-9,]+(?:\.[0-9]{1,2})?)$/i);
    if (qtyPriceCompact) {
      const quantity = parseNumber(qtyPriceCompact[2]);
      const unitPriceCents = parseCurrencyToCents(qtyPriceCompact[3]);
      items.push({
        description: qtyPriceCompact[1].trim(),
        ...(typeof quantity === 'number' ? { quantity } : {}),
        ...(typeof unitPriceCents === 'number' ? { unitPriceCents } : {}),
      });
      parsedStructured = true;
      continue;
    }

    items.push({
      description: line,
    });
  }

  if (parsedStructured) {
    return {
      parsed: true,
      items,
      rawLineItemsText: text,
    };
  }

  return {
    parsed: false,
    items,
    rawLineItemsText: text,
  };
}

function stableHash(value: unknown): string {
  return createHash('sha256')
    .update(stableStringify(value))
    .digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function hashFallback(prefix: string, fields: Array<string | undefined>): string {
  const source = fields
    .map((field) => (field ?? '').trim().toLowerCase())
    .join('|');
  return `${prefix}:${stableHash(source).slice(0, 24)}`;
}

function parseCsv(content: string): CsvRow[] {
  const text = content.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (char === '"') {
      const next = text[index + 1];
      if (inQuotes && next === '"') {
        currentCell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === ',') {
      currentRow.push(currentCell);
      currentCell = '';
      continue;
    }

    if (!inQuotes && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[index + 1] === '\n') {
        index += 1;
      }
      currentRow.push(currentCell);
      currentCell = '';
      if (currentRow.some((value) => value.trim().length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
      continue;
    }

    currentCell += char;
  }

  currentRow.push(currentCell);
  if (currentRow.some((value) => value.trim().length > 0)) {
    rows.push(currentRow);
  }

  if (rows.length === 0) {
    return [];
  }

  const headerRow = rows[0].map((header, index) => {
    const trimmed = header.replace(/^\uFEFF/, '').trim();
    return trimmed.length > 0 ? trimmed : `column_${index + 1}`;
  });

  const records: CsvRow[] = [];
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const cells = rows[rowIndex];
    const row: CsvRow = {};
    for (let colIndex = 0; colIndex < headerRow.length; colIndex += 1) {
      const header = headerRow[colIndex];
      row[header] = (cells[colIndex] ?? '').trim();
    }
    records.push(row);
  }

  return records;
}

function extractEntityId(toolName: string, output: Prisma.JsonValue): string | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return null;
  }
  const obj = output as Record<string, unknown>;

  const pickNested = (root: Record<string, unknown>, key: string): string | null => {
    const value = root[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const id = (value as Record<string, unknown>).id;
      return typeof id === 'string' && id.trim().length > 0 ? id : null;
    }
    return null;
  };

  if (toolName === 'crm.customer.upsertFromJobberCsv') {
    return pickNested(obj, 'customer') ?? pickNested(obj, 'customerId');
  }
  if (toolName === 'pricing.item.upsertFromJobberCsv') {
    return pickNested(obj, 'item') ?? pickNested(obj, 'pricingItem') ?? pickNested(obj, 'itemId');
  }
  if (toolName === 'crm.quote.importFromJobberCsv') {
    return pickNested(obj, 'quote') ?? pickNested(obj, 'quoteId');
  }
  if (toolName === 'billing.invoice.importFromJobberCsv') {
    return pickNested(obj, 'invoice') ?? pickNested(obj, 'invoiceId');
  }

  return pickNested(obj, 'id');
}

function toStats(value: unknown, dryRun: boolean): ImportStats {
  const base = toPlainObject(value);
  return {
    acceptedRows: Number(base.acceptedRows ?? 0) || 0,
    processed: Number(base.processed ?? 0) || 0,
    created: Number(base.created ?? 0) || 0,
    updated: Number(base.updated ?? 0) || 0,
    skipped: Number(base.skipped ?? 0) || 0,
    failed: Number(base.failed ?? 0) || 0,
    queuedApprovals: Number(base.queuedApprovals ?? 0) || 0,
    dryRun,
    errors: Array.isArray(base.errors)
      ? base.errors
          .filter((item): item is { rowNumber: number; sourceId: string; message: string } => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
              return false;
            }
            const record = item as Record<string, unknown>;
            return (
              typeof record.rowNumber === 'number'
              && typeof record.sourceId === 'string'
              && typeof record.message === 'string'
            );
          })
          .slice(0, 50)
      : [],
  };
}

function normalizeIsoDate(value: string | undefined): string | undefined {
  if (!value || value.trim().length === 0) {
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed.toISOString();
}

function buildRowPlan(type: JobberCsvType, rawRow: CsvRow): RowPlan {
  const normalizedRow = normalizeRow(rawRow);
  const lookup = buildLookup(normalizedRow);

  if (type === 'clients') {
    const name =
      pick(lookup, ['name', 'client name', 'full name', 'display name'])
      ?? [
        pick(lookup, ['first name', 'firstname']),
        pick(lookup, ['last name', 'lastname']),
      ]
        .filter(Boolean)
        .join(' ')
        .trim();
    const email = pick(lookup, ['email', 'email address']);
    const phone = pick(lookup, ['phone', 'phone number', 'mobile', 'mobile phone']);
    const sourceId =
      pick(lookup, ['client id', 'id', 'jobber id', 'client number', 'client #'])
      ?? hashFallback('client', [email, phone, name]);

    const payload = {
      sourceId,
      sourceType: type,
      fullName: name || 'Unknown Client',
      email,
      phone,
      addressLine1: pick(lookup, ['address', 'address 1', 'street address']),
      city: pick(lookup, ['city']),
      state: pick(lookup, ['state', 'province']),
      postalCode: pick(lookup, ['postal code', 'zip', 'zip code']),
      rawRow: normalizedRow,
      metadata: {
        importProvider: ImportProvider.JOBBER,
      },
    };

    return {
      sourceType: type,
      sourceId,
      rawHash: stableHash({ type, row: normalizedRow }),
      toolName: 'crm.customer.upsertFromJobberCsv',
      mbsType: 'customer',
      payload,
      rawPayload: {
        row: normalizedRow,
      },
    };
  }

  if (type === 'products_services') {
    const name = pick(lookup, ['name', 'item name', 'product name', 'service name']);
    const sku = pick(lookup, ['sku', 'code', 'item code']);
    const sourceId =
      pick(lookup, ['item id', 'product id', 'service id', 'id'])
      ?? sku
      ?? hashFallback('pricing-item', [name]);
    const unitPriceCents = parseCurrencyToCents(
      pick(lookup, ['unit price', 'price', 'rate', 'cost']),
    );

    const payload = {
      sourceId,
      sourceType: type,
      name: name || 'Unnamed Item',
      sku,
      description: pick(lookup, ['description']),
      unitPriceCents,
      taxable: pick(lookup, ['taxable'])?.toLowerCase() === 'yes',
      rawRow: normalizedRow,
      metadata: {
        importProvider: ImportProvider.JOBBER,
      },
    };

    return {
      sourceType: type,
      sourceId,
      rawHash: stableHash({ type, row: normalizedRow }),
      toolName: 'pricing.item.upsertFromJobberCsv',
      mbsType: 'pricing_item',
      payload,
      rawPayload: {
        row: normalizedRow,
      },
    };
  }

  if (type === 'quotes_report') {
    const quoteNumber = pick(lookup, ['quote #', 'quote number', 'quote id', 'id']);
    const customerName = pick(lookup, ['client', 'client name', 'customer', 'customer name']);
    const lineItemsText = pick(lookup, ['line items', 'line item', 'items']);
    const lineItems = parseLineItems(lineItemsText);
    const sourceId =
      quoteNumber
      ?? hashFallback('quote', [
        customerName,
        pick(lookup, ['date', 'issued date']),
        pick(lookup, ['total', 'amount']),
      ]);

    const payload = {
      sourceId,
      sourceType: type,
      quoteNumber,
      customerName,
      customerEmail: pick(lookup, ['client email', 'customer email', 'email']),
      status: pick(lookup, ['status']),
      totalCents: parseCurrencyToCents(pick(lookup, ['total', 'amount'])),
      issuedAt: normalizeIsoDate(pick(lookup, ['date', 'issued date'])),
      expiresAt: normalizeIsoDate(pick(lookup, ['expiry date', 'expires'])),
      lineItems: lineItems.items,
      lineItemsText,
      lineItemsParsed: lineItems.parsed,
      rawRow: normalizedRow,
      metadata: {
        importProvider: ImportProvider.JOBBER,
        ...(lineItems.rawLineItemsText
          ? { rawLineItemsText: lineItems.rawLineItemsText }
          : {}),
      },
    };

    return {
      sourceType: type,
      sourceId,
      rawHash: stableHash({ type, row: normalizedRow }),
      toolName: 'crm.quote.importFromJobberCsv',
      mbsType: 'quote',
      payload,
      rawPayload: {
        row: normalizedRow,
        lineItems,
      },
    };
  }

  const invoiceNumber = pick(lookup, ['invoice #', 'invoice number', 'invoice id', 'id']);
  const customerName = pick(lookup, ['client', 'client name', 'customer', 'customer name']);
  const lineItemsText = pick(lookup, ['line items', 'line item', 'items']);
  const lineItems = parseLineItems(lineItemsText);
  const sourceId =
    invoiceNumber
    ?? hashFallback('invoice', [
      customerName,
      pick(lookup, ['invoice date', 'date']),
      pick(lookup, ['total', 'amount']),
    ]);

  const payload = {
    sourceId,
    sourceType: type,
    invoiceNumber,
    customerName,
    customerEmail: pick(lookup, ['client email', 'customer email', 'email']),
    status: pick(lookup, ['status']),
    totalCents: parseCurrencyToCents(pick(lookup, ['total', 'amount'])),
    balanceCents: parseCurrencyToCents(pick(lookup, ['balance', 'balance due'])),
    issuedAt: normalizeIsoDate(pick(lookup, ['invoice date', 'date'])),
    dueAt: normalizeIsoDate(pick(lookup, ['due date', 'due'])),
    lineItems: lineItems.items,
    lineItemsText,
    lineItemsParsed: lineItems.parsed,
    rawRow: normalizedRow,
    metadata: {
      importProvider: ImportProvider.JOBBER,
      ...(lineItems.rawLineItemsText
        ? { rawLineItemsText: lineItems.rawLineItemsText }
        : {}),
    },
  };

  return {
    sourceType: type,
    sourceId,
    rawHash: stableHash({ type, row: normalizedRow }),
    toolName: 'billing.invoice.importFromJobberCsv',
    mbsType: 'invoice',
    payload,
    rawPayload: {
      row: normalizedRow,
      lineItems,
    },
  };
}

async function resolveActorUserId(
  prisma: PrismaClient,
  orgId: string,
  preferredUserId: string | undefined,
): Promise<string | null> {
  if (preferredUserId) {
    const user = await prisma.user.findFirst({
      where: {
        id: preferredUserId,
        orgId,
        isActive: true,
      },
      select: { id: true },
    });
    if (user) {
      return user.id;
    }
  }

  const adminRole = await prisma.role.findFirst({
    where: {
      orgId,
      OR: [{ name: 'admin' }, { name: 'owner' }],
    },
    select: { id: true },
  });

  if (adminRole) {
    const userRole = await prisma.userRole.findFirst({
      where: {
        roleId: adminRole.id,
        user: {
          orgId,
          isActive: true,
        },
      },
      select: {
        userId: true,
      },
      orderBy: {
        assignedAt: 'asc',
      },
    });
    if (userRole?.userId) {
      return userRole.userId;
    }
  }

  const fallback = await prisma.user.findFirst({
    where: {
      orgId,
      isActive: true,
    },
    orderBy: {
      createdAt: 'asc',
    },
    select: { id: true },
  });

  return fallback?.id ?? null;
}

function isDryRun(value: unknown): boolean {
  return value === true || value === 'true';
}

function toStringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function summarizeToolFailure(result: Exclude<ToolExecutionResponse, { status: 'EXECUTED' }>): string {
  if (result.status === 'QUEUED_APPROVAL') {
    return `Queued approval (required=${result.requiredApprovals})`;
  }
  if (result.status === 'BLOCKED') {
    return result.reason;
  }
  return result.error;
}

async function persistProgress(
  prisma: PrismaClient,
  importRunId: string,
  filePath: string,
  rowCursor: number,
  stats: ImportStats,
  lastError?: string,
) {
  await prisma.importRun.update({
    where: { id: importRunId },
    data: {
      cursorState: {
        filePath,
        rowCursor,
      } as Prisma.InputJsonValue,
      stats: stats as Prisma.InputJsonValue,
      ...(lastError !== undefined ? { lastError } : {}),
    },
  });
}

export async function processJobberCsvImportRequested(args: {
  prisma: PrismaClient;
  registry: ToolRegistry;
  orgId: string;
  payload: unknown;
}) {
  const payload = toPlainObject(args.payload) as JobberCsvImportRequestedPayload;
  const importRunId = toStringOrUndefined(payload.importRunId);
  const filePath = toStringOrUndefined(payload.filePath);
  const inlineCsvContent = toStringOrUndefined(payload.csvContent);
  const typeRaw = payload.type;
  const actorUserIdRaw = toStringOrUndefined(payload.actorUserId);

  if (!importRunId || (!filePath && !inlineCsvContent) || !isJobberCsvType(typeRaw)) {
    throw new Error('Invalid jobber.csv.import.requested payload');
  }

  const run = await args.prisma.importRun.findFirst({
    where: {
      id: importRunId,
      orgId: args.orgId,
      provider: ImportProvider.JOBBER,
    },
  });
  if (!run) {
    throw new Error(`Import run not found: ${importRunId}`);
  }

  const dryRun = isDryRun(payload.dryRun) || isDryRun(toPlainObject(run.options).dryRun);
  const actorUserId = await resolveActorUserId(args.prisma, args.orgId, actorUserIdRaw ?? run.startedByUserId ?? undefined);
  if (!actorUserId && !dryRun) {
    throw new Error('No active actor available for tool execution');
  }

  let csvContent = '';
  let resolvedFilePath = filePath ?? '<inline>';
  if (filePath) {
    try {
      csvContent = await readFile(filePath, 'utf8');
    } catch (error) {
      if (inlineCsvContent) {
        csvContent = inlineCsvContent;
        resolvedFilePath = '<inline>';
      } else {
        throw error;
      }
    }
  } else if (inlineCsvContent) {
    csvContent = inlineCsvContent;
    resolvedFilePath = '<inline>';
  }

  const rows = parseCsv(csvContent);
  const cursorState = toPlainObject(run.cursorState);
  const initialCursor = Number(cursorState.rowCursor ?? 0);
  const rowStart = Number.isFinite(initialCursor) ? Math.max(0, Math.floor(initialCursor)) : 0;
  const stats = toStats(run.stats, dryRun);
  stats.acceptedRows = rows.length;

  await args.prisma.importRun.update({
    where: { id: run.id },
    data: {
      status: ImportRunStatus.RUNNING,
      startedAt: run.startedAt ?? new Date(),
      lastError: null,
      stats: stats as Prisma.InputJsonValue,
      cursorState: {
        filePath,
        rowCursor: rowStart,
      } as Prisma.InputJsonValue,
    },
  });

  try {
    for (let rowIndex = rowStart; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      const csvRowNumber = rowIndex + 2;

      try {
        const plan = buildRowPlan(typeRaw, row);
        const now = new Date();
        stats.processed += 1;

        await args.prisma.sourceRaw.create({
          data: {
            orgId: args.orgId,
            provider: ImportProvider.JOBBER,
            sourceType: plan.sourceType,
            sourceId: plan.sourceId,
            payload: plan.rawPayload as Prisma.InputJsonValue,
            importRunId: run.id,
            fetchedAt: now,
          },
        });

        const existingMapping = await args.prisma.sourceMapping.findUnique({
          where: {
            orgId_provider_sourceType_sourceId: {
              orgId: args.orgId,
              provider: ImportProvider.JOBBER,
              sourceType: plan.sourceType,
              sourceId: plan.sourceId,
            },
          },
        });

        if (existingMapping && existingMapping.rawHash === plan.rawHash) {
          stats.skipped += 1;
          await args.prisma.sourceMapping.update({
            where: { id: existingMapping.id },
            data: { lastSeenAt: now },
          });
          await persistProgress(args.prisma, run.id, resolvedFilePath, rowIndex + 1, stats);
          continue;
        }

        if (dryRun) {
          stats.skipped += 1;
          await persistProgress(args.prisma, run.id, resolvedFilePath, rowIndex + 1, stats);
          continue;
        }

        const toolPayload: Record<string, unknown> = existingMapping?.mbsId
          ? {
              ...plan.payload,
              existingMbsId: existingMapping.mbsId,
            }
          : plan.payload;

        const result = await args.registry.execute(plan.toolName, toolPayload, {
          orgId: args.orgId,
          actorType: ActorType.SYSTEM,
          actorUserId: actorUserId ?? undefined,
          actorLabel: 'jobber-csv-import-worker',
          isAutonomous: false,
          reason: `jobber.csv.import:${typeRaw}`,
        });

        if (result.status !== 'EXECUTED') {
          if (result.status === 'QUEUED_APPROVAL') {
            stats.queuedApprovals += 1;
          } else {
            stats.failed += 1;
          }
          if (stats.errors.length < 50) {
            stats.errors.push({
              rowNumber: csvRowNumber,
              sourceId: plan.sourceId,
              message: summarizeToolFailure(result),
            });
          }
          await persistProgress(args.prisma, run.id, resolvedFilePath, rowIndex + 1, stats);
          continue;
        }

        const entityId = extractEntityId(plan.toolName, result.output) ?? existingMapping?.mbsId ?? null;
        if (!entityId) {
          stats.failed += 1;
          if (stats.errors.length < 50) {
            stats.errors.push({
              rowNumber: csvRowNumber,
              sourceId: plan.sourceId,
              message: `Tool ${plan.toolName} executed but did not return entity id`,
            });
          }
          await persistProgress(args.prisma, run.id, resolvedFilePath, rowIndex + 1, stats);
          continue;
        }

        if (existingMapping) {
          stats.updated += 1;
        } else {
          stats.created += 1;
        }

        await args.prisma.sourceMapping.upsert({
          where: {
            orgId_provider_sourceType_sourceId: {
              orgId: args.orgId,
              provider: ImportProvider.JOBBER,
              sourceType: plan.sourceType,
              sourceId: plan.sourceId,
            },
          },
          update: {
            mbsType: plan.mbsType,
            mbsId: entityId,
            rawHash: plan.rawHash,
            lastSeenAt: now,
          },
          create: {
            orgId: args.orgId,
            provider: ImportProvider.JOBBER,
            sourceType: plan.sourceType,
            sourceId: plan.sourceId,
            mbsType: plan.mbsType,
            mbsId: entityId,
            rawHash: plan.rawHash,
            lastSeenAt: now,
          },
        });

        await persistProgress(args.prisma, run.id, resolvedFilePath, rowIndex + 1, stats);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown row processing error';
        stats.failed += 1;
        if (stats.errors.length < 50) {
          stats.errors.push({
            rowNumber: csvRowNumber,
            sourceId: `row:${rowIndex + 1}`,
            message,
          });
        }
        await persistProgress(
          args.prisma,
          run.id,
          resolvedFilePath,
          rowIndex + 1,
          stats,
          `Row ${csvRowNumber}: ${message}`,
        );
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown import worker failure';
    await args.prisma.importRun.update({
      where: { id: run.id },
      data: {
        status: ImportRunStatus.FAILED,
        lastError: message,
        stats: stats as Prisma.InputJsonValue,
      },
    });
    throw error;
  }

  await args.prisma.importRun.update({
    where: { id: run.id },
    data: {
      status: ImportRunStatus.COMPLETED,
      completedAt: new Date(),
      lastError: stats.failed > 0 ? `Completed with ${stats.failed} failed row(s)` : null,
      cursorState: {
        filePath,
        ...(resolvedFilePath !== filePath ? { fallback: resolvedFilePath } : {}),
        rowCursor: rows.length,
      } as Prisma.InputJsonValue,
      stats: stats as Prisma.InputJsonValue,
    },
  });
}
