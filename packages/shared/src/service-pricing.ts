export type ServiceTiming = 'NORMAL' | 'AFTER_HOURS';

export type ServiceGuardrailStatus = 'OK' | 'BLOCK';

export type ServiceQuoteLineItem = {
  id?: string;
  itemType: 'PRICEBOOK_ITEM' | 'CUSTOM';
  pricebookItemId?: string | null;
  categorySlugSnapshot?: string | null;
  kindSnapshot?: string | null;
  nameSnapshot: string;
  descriptionSnapshot?: string | null;
  qty: number;
  unitPriceCents: number;
  lineTotalCents?: number;
  sortOrder?: number;
  meta?: Record<string, unknown> | null;
};

export type DiagnosticCreditResult = {
  lineItems: ServiceQuoteLineItem[];
  diagnosticFeeCents: number;
  repairSubtotalCents: number;
  diagnosticCreditCents: number;
};

export type ServiceQuoteTotalsInput = {
  timing: ServiceTiming;
  isMember: boolean;
  laborHours: number;
  discountPctBps?: number;
  discountCents?: number;
  lineItems: ServiceQuoteLineItem[];
  diagnosticItemId?: string | null;
  repairCategorySlug?: string;
  maintenanceCategorySlug?: string;
};

export type ServiceQuoteTotalsResult = {
  correctedLineItems: ServiceQuoteLineItem[];
  laborRateCents: number;
  laborHoursRounded: number;
  laborTotalCents: number;
  subtotalCents: number;
  diagnosticFeeCents: number;
  repairSubtotalCents: number;
  diagnosticCreditCents: number;
  totalBeforeDiscountCents: number;
  discountPctBps: number;
  discountCents: number;
  discountTotalCents: number;
  finalTotalCents: number;
  floorCents: number;
  maintenanceOnly: boolean;
  guardrailStatus: ServiceGuardrailStatus;
  guardrailReasons: Array<{ code: string; message: string; floorCents: number }>;
};

function normalizeCategorySlug(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function coerceLineTotal(line: ServiceQuoteLineItem): number {
  const qty = Number.isFinite(line.qty) ? Math.trunc(line.qty) : 1;
  const safeQty = qty <= 0 ? 1 : qty;
  const computed = safeQty * Math.round(line.unitPriceCents);
  if (typeof line.lineTotalCents !== 'number' || !Number.isFinite(line.lineTotalCents)) {
    return computed;
  }
  return Math.round(line.lineTotalCents);
}

function asMetaRecord(value: ServiceQuoteLineItem['meta']): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function isDiagnosticCreditLine(line: ServiceQuoteLineItem): boolean {
  const meta = asMetaRecord(line.meta);
  return meta.isDiagnosticCredit === true;
}

function createDiagnosticCreditLine(sortOrder: number, diagnosticFeeCents: number): ServiceQuoteLineItem {
  return {
    itemType: 'CUSTOM',
    pricebookItemId: null,
    categorySlugSnapshot: 'fees',
    kindSnapshot: 'FEE',
    nameSnapshot: 'Diagnostic Credit',
    descriptionSnapshot: 'Auto-applied diagnostic fee credit',
    qty: 1,
    unitPriceCents: -Math.abs(diagnosticFeeCents),
    lineTotalCents: -Math.abs(diagnosticFeeCents),
    sortOrder,
    meta: {
      isDiagnosticCredit: true,
    },
  };
}

export function roundToNearestHalfHour(hoursFloat: number): number {
  if (!Number.isFinite(hoursFloat)) {
    return 0;
  }
  const rounded = Math.round(hoursFloat * 2) / 2;
  return rounded < 0 ? 0 : rounded;
}

export function resolveLaborRateCents(
  timing: ServiceTiming,
  isMember: boolean,
): number {
  if (timing === 'AFTER_HOURS' && isMember) {
    return 15_000;
  }
  if (timing === 'AFTER_HOURS') {
    return 20_000;
  }
  return 10_000;
}

export function recomputeDiagnosticCredit(
  lineItems: ServiceQuoteLineItem[],
  diagnosticItemId: string | null | undefined,
  repairCategorySlug = 'repair',
  diagnosticFeeCents = 0,
): DiagnosticCreditResult {
  const creditStrippedItems: ServiceQuoteLineItem[] = lineItems
    .filter((line) => !isDiagnosticCreditLine(line))
    .map((line) => ({
      ...line,
      lineTotalCents: coerceLineTotal(line),
      qty: Math.max(1, Math.trunc(line.qty || 1)),
      unitPriceCents: Math.round(line.unitPriceCents),
      sortOrder: typeof line.sortOrder === 'number' ? line.sortOrder : 0,
      meta: asMetaRecord(line.meta),
    }));

  const normalizedDiagnosticItemId = (diagnosticItemId ?? '').trim();
  const diagnosticLines = normalizedDiagnosticItemId
    ? creditStrippedItems.filter(
        (line) => (line.pricebookItemId ?? '').trim() === normalizedDiagnosticItemId,
      )
    : [];

  if (diagnosticLines.length > 1) {
    throw new Error('Only one diagnostic fee line is allowed per service quote');
  }

  const diagnosticLine = diagnosticLines[0] ?? null;
  const resolvedDiagnosticFeeCents =
    diagnosticLine !== null
      ? Math.max(0, coerceLineTotal(diagnosticLine))
      : Math.max(0, Math.round(diagnosticFeeCents));

  const normalizedRepairSlug = normalizeCategorySlug(repairCategorySlug);
  let repairSubtotalCents = 0;
  for (const line of creditStrippedItems) {
    if (normalizeCategorySlug(line.categorySlugSnapshot) !== normalizedRepairSlug) {
      continue;
    }
    const lineTotal = coerceLineTotal(line);
    if (lineTotal > 0) {
      repairSubtotalCents += lineTotal;
    }
  }

  const shouldApplyCredit =
    diagnosticLine !== null &&
    resolvedDiagnosticFeeCents > 0 &&
    repairSubtotalCents >= resolvedDiagnosticFeeCents;

  const nextItems = [...creditStrippedItems];
  let diagnosticCreditCents = 0;

  if (shouldApplyCredit) {
    const maxSortOrder = nextItems.reduce(
      (max, line) => Math.max(max, typeof line.sortOrder === 'number' ? line.sortOrder : 0),
      0,
    );
    nextItems.push(createDiagnosticCreditLine(maxSortOrder + 1, resolvedDiagnosticFeeCents));
    diagnosticCreditCents = resolvedDiagnosticFeeCents;
  }

  return {
    lineItems: nextItems,
    diagnosticFeeCents: resolvedDiagnosticFeeCents,
    repairSubtotalCents,
    diagnosticCreditCents,
  };
}

export function computeServiceQuoteTotals(
  input: ServiceQuoteTotalsInput,
): ServiceQuoteTotalsResult {
  const discountPctBps = Math.max(0, Math.min(10_000, Math.round(input.discountPctBps ?? 0)));
  const discountCents = Math.max(0, Math.round(input.discountCents ?? 0));

  const corrected = recomputeDiagnosticCredit(
    input.lineItems,
    input.diagnosticItemId,
    input.repairCategorySlug ?? 'repair',
  );

  const subtotalCents = corrected.lineItems.reduce(
    (sum, line) => sum + coerceLineTotal(line),
    0,
  );

  const laborHoursRounded = roundToNearestHalfHour(input.laborHours);
  const laborRateCents = resolveLaborRateCents(input.timing, input.isMember);
  const laborTotalCents = Math.round(laborHoursRounded * laborRateCents);

  const totalBeforeDiscountCents = subtotalCents + laborTotalCents;
  const discountTotalCents =
    Math.round(totalBeforeDiscountCents * (discountPctBps / 10_000)) + discountCents;

  const finalTotalCents = Math.max(0, totalBeforeDiscountCents - discountTotalCents);

  const repairSlug = normalizeCategorySlug(input.repairCategorySlug ?? 'repair');
  const maintenanceSlug = normalizeCategorySlug(input.maintenanceCategorySlug ?? 'maintenance');

  const hasRepairItems = corrected.lineItems.some(
    (line) => normalizeCategorySlug(line.categorySlugSnapshot) === repairSlug,
  );
  const hasMaintenanceItems = corrected.lineItems.some(
    (line) => normalizeCategorySlug(line.categorySlugSnapshot) === maintenanceSlug,
  );

  const maintenanceOnly = !hasRepairItems && hasMaintenanceItems;
  const floorCents = maintenanceOnly ? 14_900 : 9_900;

  if (finalTotalCents < floorCents) {
    return {
      correctedLineItems: corrected.lineItems,
      laborRateCents,
      laborHoursRounded,
      laborTotalCents,
      subtotalCents,
      diagnosticFeeCents: corrected.diagnosticFeeCents,
      repairSubtotalCents: corrected.repairSubtotalCents,
      diagnosticCreditCents: corrected.diagnosticCreditCents,
      totalBeforeDiscountCents,
      discountPctBps,
      discountCents,
      discountTotalCents,
      finalTotalCents,
      floorCents,
      maintenanceOnly,
      guardrailStatus: 'BLOCK',
      guardrailReasons: [
        {
          code: 'SERVICE_FLOOR_BLOCK',
          message: 'Service quote total is below the configured floor after discount.',
          floorCents,
        },
      ],
    };
  }

  return {
    correctedLineItems: corrected.lineItems,
    laborRateCents,
    laborHoursRounded,
    laborTotalCents,
    subtotalCents,
    diagnosticFeeCents: corrected.diagnosticFeeCents,
    repairSubtotalCents: corrected.repairSubtotalCents,
    diagnosticCreditCents: corrected.diagnosticCreditCents,
    totalBeforeDiscountCents,
    discountPctBps,
    discountCents,
    discountTotalCents,
    finalTotalCents,
    floorCents,
    maintenanceOnly,
    guardrailStatus: 'OK',
    guardrailReasons: [],
  };
}
