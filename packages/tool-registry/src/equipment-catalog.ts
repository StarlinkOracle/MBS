import { createHash } from 'node:crypto';

export type EquipmentCatalogMapping = {
  skuColumn?: string;
  manufacturerColumn?: string;
  systemTypeColumn?: string;
  textColumns?: string[];
};

type CsvRow = Record<string, string>;

type Lookup = Record<string, string>;

type RowExtraction = {
  rawSku: string;
  rawText: string;
  manufacturer: string | null;
  systemTypeHint: string | null;
  rawJson: Record<string, string>;
};

export type CatalogExtractionResult = {
  rows: RowExtraction[];
  acceptedRows: number;
  skippedRows: number;
};

const SKU_CANDIDATES = [
  'sku',
  'model',
  'item_number',
  'item number',
  'item#',
  'item #',
  'part number',
  'part_number',
  'product code',
  'product_code',
  'code',
  'item',
] as const;

const MANUFACTURER_CANDIDATES = [
  'manufacturer',
  'brand',
  'make',
  'vendor',
] as const;

const SYSTEM_TYPE_CANDIDATES = [
  'system type',
  'system_type',
  'type',
  'category',
  'equipment type',
  'equipment_type',
] as const;

const TEXT_CANDIDATES = [
  'description',
  'long description',
  'short description',
  'name',
  'title',
  'product',
  'item',
  'equipment',
  'model',
  'sku',
  'manufacturer',
  'brand',
  'type',
  'system type',
  'seer',
  'afue',
  'btu',
  'tonnage',
] as const;

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

function buildLookup(row: CsvRow): Lookup {
  const lookup: Lookup = {};
  for (const [key, value] of Object.entries(row)) {
    const normalized = normalizeKey(key);
    if (!normalized) {
      continue;
    }
    lookup[normalized] = value;
  }
  return lookup;
}

function parseCsv(content: string): CsvRow[] {
  const text = content.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (char === '"') {
      const next = text[i + 1];
      if (inQuotes && next === '"') {
        currentCell += '"';
        i += 1;
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
      if (char === '\r' && text[i + 1] === '\n') {
        i += 1;
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
    records.push(normalizeRow(row));
  }

  return records;
}

function pickFromLookup(lookup: Lookup, candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    const normalized = normalizeKey(candidate);
    const value = lookup[normalized];
    if (value && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function pickFromConfiguredColumn(row: CsvRow, column?: string): string | undefined {
  if (!column || column.trim().length === 0) {
    return undefined;
  }

  const wanted = normalizeKey(column);
  for (const [key, value] of Object.entries(row)) {
    if (normalizeKey(key) === wanted && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

function stableRowHash(row: CsvRow): string {
  const keys = Object.keys(row).sort();
  const serialized = keys.map((key) => `${key}:${row[key] ?? ''}`).join('|');
  return createHash('sha256').update(serialized).digest('hex').slice(0, 20);
}

function nonEmptyValues(row: CsvRow): string[] {
  return Object.values(row)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function buildRawText(row: CsvRow, lookup: Lookup, mapping: EquipmentCatalogMapping): string {
  const configured = (mapping.textColumns ?? [])
    .map((column) => pickFromConfiguredColumn(row, column))
    .filter((value): value is string => Boolean(value && value.trim().length > 0));

  if (configured.length > 0) {
    return configured.join(' | ');
  }

  const preferredSegments = TEXT_CANDIDATES
    .map((candidate) => pickFromLookup(lookup, [candidate]))
    .filter((value): value is string => Boolean(value && value.trim().length > 0));

  if (preferredSegments.length > 0) {
    return [...new Set(preferredSegments)].join(' | ');
  }

  return nonEmptyValues(row).slice(0, 12).join(' | ');
}

function extractRow(row: CsvRow, mapping: EquipmentCatalogMapping): RowExtraction | null {
  const lookup = buildLookup(row);
  const allValues = nonEmptyValues(row);
  if (allValues.length === 0) {
    return null;
  }

  const rawSku =
    pickFromConfiguredColumn(row, mapping.skuColumn) ??
    pickFromLookup(lookup, SKU_CANDIDATES) ??
    `row_${stableRowHash(row)}`;

  const rawText = buildRawText(row, lookup, mapping);

  const manufacturer =
    pickFromConfiguredColumn(row, mapping.manufacturerColumn) ??
    pickFromLookup(lookup, MANUFACTURER_CANDIDATES) ??
    null;

  const systemTypeHint =
    pickFromConfiguredColumn(row, mapping.systemTypeColumn) ??
    pickFromLookup(lookup, SYSTEM_TYPE_CANDIDATES) ??
    null;

  return {
    rawSku,
    rawText: rawText.length > 0 ? rawText : rawSku,
    manufacturer,
    systemTypeHint,
    rawJson: row,
  };
}

export function extractEquipmentCatalogRows(
  csvContent: string,
  mapping: EquipmentCatalogMapping = {},
): CatalogExtractionResult {
  const parsedRows = parseCsv(csvContent);
  const rows: RowExtraction[] = [];
  let skippedRows = 0;

  for (const row of parsedRows) {
    const extracted = extractRow(row, mapping);
    if (!extracted) {
      skippedRows += 1;
      continue;
    }
    rows.push(extracted);
  }

  return {
    rows,
    acceptedRows: rows.length,
    skippedRows,
  };
}
