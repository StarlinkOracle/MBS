import {
  computeServiceQuoteTotals,
  recomputeDiagnosticCredit,
  resolveLaborRateCents,
  roundToNearestHalfHour,
  type ServiceQuoteLineItem,
} from '../src/index.js';
import {
  describe,
  expect,
  it,
} from 'vitest';

describe('roundToNearestHalfHour', () => {
  it('rounds to nearest 0.5 hour with expected boundaries', () => {
    expect(roundToNearestHalfHour(1.24)).toBe(1.0);
    expect(roundToNearestHalfHour(1.25)).toBe(1.5);
    expect(roundToNearestHalfHour(1.74)).toBe(1.5);
    expect(roundToNearestHalfHour(1.75)).toBe(2.0);
  });
});

describe('resolveLaborRateCents', () => {
  it('selects normal, after-hours, and member after-hours rates', () => {
    expect(resolveLaborRateCents('NORMAL', false)).toBe(10_000);
    expect(resolveLaborRateCents('AFTER_HOURS', false)).toBe(20_000);
    expect(resolveLaborRateCents('AFTER_HOURS', true)).toBe(15_000);
  });
});

describe('service pricing totals', () => {
  const diagnosticItemId = 'diag-item';

  const baseLineItems: ServiceQuoteLineItem[] = [
    {
      itemType: 'PRICEBOOK_ITEM',
      pricebookItemId: diagnosticItemId,
      categorySlugSnapshot: 'fees',
      kindSnapshot: 'FEE',
      nameSnapshot: 'Diagnostic Fee',
      qty: 1,
      unitPriceCents: 12_900,
      lineTotalCents: 12_900,
      sortOrder: 1,
      meta: { isDiagnosticFee: true },
    },
    {
      itemType: 'PRICEBOOK_ITEM',
      pricebookItemId: 'repair-1',
      categorySlugSnapshot: 'repair',
      kindSnapshot: 'SERVICE',
      nameSnapshot: 'Capacitor Replacement',
      qty: 1,
      unitPriceCents: 22_500,
      lineTotalCents: 22_500,
      sortOrder: 2,
    },
  ];

  it('after-hours affects labor only', () => {
    const normal = computeServiceQuoteTotals({
      timing: 'NORMAL',
      isMember: false,
      laborHours: 1.25,
      discountPctBps: 0,
      discountCents: 0,
      lineItems: baseLineItems,
      diagnosticItemId,
      repairCategorySlug: 'repair',
      maintenanceCategorySlug: 'maintenance',
    });

    const afterHours = computeServiceQuoteTotals({
      timing: 'AFTER_HOURS',
      isMember: false,
      laborHours: 1.25,
      discountPctBps: 0,
      discountCents: 0,
      lineItems: baseLineItems,
      diagnosticItemId,
      repairCategorySlug: 'repair',
      maintenanceCategorySlug: 'maintenance',
    });

    expect(normal.subtotalCents).toBe(afterHours.subtotalCents);
    expect(afterHours.laborRateCents).toBe(20_000);
    expect(normal.laborRateCents).toBe(10_000);
    expect(afterHours.laborTotalCents - normal.laborTotalCents).toBe(
      normal.laborHoursRounded * 10_000,
    );
  });

  it('applies diagnostic credit only when repair subtotal meets diagnostic fee', () => {
    const noRepair = recomputeDiagnosticCredit(
      [
        {
          itemType: 'PRICEBOOK_ITEM',
          pricebookItemId: diagnosticItemId,
          categorySlugSnapshot: 'fees',
          kindSnapshot: 'FEE',
          nameSnapshot: 'Diagnostic Fee',
          qty: 1,
          unitPriceCents: 12_900,
          lineTotalCents: 12_900,
          sortOrder: 1,
        },
      ],
      diagnosticItemId,
      'repair',
      12_900,
    );

    expect(noRepair.diagnosticCreditCents).toBe(0);
    expect(noRepair.lineItems.some((line) => line.nameSnapshot === 'Diagnostic Credit')).toBe(false);

    const withRepair = recomputeDiagnosticCredit(baseLineItems, diagnosticItemId, 'repair', 12_900);

    expect(withRepair.repairSubtotalCents).toBe(22_500);
    expect(withRepair.diagnosticCreditCents).toBe(12_900);
    expect(withRepair.lineItems.some((line) => line.nameSnapshot === 'Diagnostic Credit')).toBe(true);
  });

  it('adds and removes credit dynamically and includes it in subtotal once', () => {
    const withCredit = computeServiceQuoteTotals({
      timing: 'NORMAL',
      isMember: false,
      laborHours: 1,
      lineItems: baseLineItems,
      diagnosticItemId,
      repairCategorySlug: 'repair',
      maintenanceCategorySlug: 'maintenance',
    });

    const subtotalWithoutLabor = withCredit.subtotalCents;
    expect(withCredit.diagnosticCreditCents).toBe(12_900);
    expect(subtotalWithoutLabor).toBe(22_500);

    const withoutRepair = computeServiceQuoteTotals({
      timing: 'NORMAL',
      isMember: false,
      laborHours: 1,
      lineItems: baseLineItems.filter((line) => line.categorySlugSnapshot !== 'repair'),
      diagnosticItemId,
      repairCategorySlug: 'repair',
      maintenanceCategorySlug: 'maintenance',
    });

    expect(withoutRepair.diagnosticCreditCents).toBe(0);
    expect(withoutRepair.correctedLineItems.some((line) => line.nameSnapshot === 'Diagnostic Credit')).toBe(false);
  });

  it('applies percent + fixed discount sum after labor and credit', () => {
    const totals = computeServiceQuoteTotals({
      timing: 'AFTER_HOURS',
      isMember: true,
      laborHours: 2.24,
      discountPctBps: 500,
      discountCents: 5_000,
      lineItems: baseLineItems,
      diagnosticItemId,
      repairCategorySlug: 'repair',
      maintenanceCategorySlug: 'maintenance',
    });

    expect(totals.laborHoursRounded).toBe(2.0);
    expect(totals.laborRateCents).toBe(15_000);
    expect(totals.totalBeforeDiscountCents).toBe(totals.subtotalCents + totals.laborTotalCents);
    expect(totals.discountTotalCents).toBe(
      Math.round(totals.totalBeforeDiscountCents * 0.05) + 5_000,
    );
    expect(totals.finalTotalCents).toBe(
      Math.max(0, totals.totalBeforeDiscountCents - totals.discountTotalCents),
    );
  });

  it('blocks when final total falls below maintenance-only floor', () => {
    const maintenanceQuote = computeServiceQuoteTotals({
      timing: 'NORMAL',
      isMember: false,
      laborHours: 0,
      discountPctBps: 0,
      discountCents: 0,
      lineItems: [
        {
          itemType: 'PRICEBOOK_ITEM',
          pricebookItemId: 'maint-1',
          categorySlugSnapshot: 'maintenance',
          kindSnapshot: 'SERVICE',
          nameSnapshot: 'Maintenance Visit',
          qty: 1,
          unitPriceCents: 12_000,
          lineTotalCents: 12_000,
          sortOrder: 1,
        },
      ],
      diagnosticItemId,
      repairCategorySlug: 'repair',
      maintenanceCategorySlug: 'maintenance',
    });

    expect(maintenanceQuote.maintenanceOnly).toBe(true);
    expect(maintenanceQuote.floorCents).toBe(14_900);
    expect(maintenanceQuote.guardrailStatus).toBe('BLOCK');

    const repairQuote = computeServiceQuoteTotals({
      timing: 'NORMAL',
      isMember: false,
      laborHours: 0,
      lineItems: [
        {
          itemType: 'PRICEBOOK_ITEM',
          pricebookItemId: 'repair-1',
          categorySlugSnapshot: 'repair',
          kindSnapshot: 'SERVICE',
          nameSnapshot: 'Repair',
          qty: 1,
          unitPriceCents: 12_000,
          lineTotalCents: 12_000,
          sortOrder: 1,
        },
      ],
      diagnosticItemId,
      repairCategorySlug: 'repair',
      maintenanceCategorySlug: 'maintenance',
    });

    expect(repairQuote.maintenanceOnly).toBe(false);
    expect(repairQuote.floorCents).toBe(9_900);
    expect(repairQuote.guardrailStatus).toBe('OK');
  });
});
