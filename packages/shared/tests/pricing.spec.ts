import {
  computeDiscountAmount,
  computeInstallPriceBreakdown,
  evaluateInstallGuardrail,
} from '../src/index.js';
import {
  describe,
  expect,
  it,
} from 'vitest';

describe('computeInstallPriceBreakdown', () => {
  it('applies 20% cushion only to equipment and materials', () => {
    const result = computeInstallPriceBreakdown({
      installType: 'FURNACE_ONLY',
      accessType: 'STANDARD',
      equipmentCostCents: 100_000,
      materialsCostCents: 50_000,
      baseLaborCostCents: 80_000,
      permitCostCents: 10_000,
    });

    expect(result.equipmentAdjustedCents).toBe(120_000);
    expect(result.materialsAdjustedCents).toBe(60_000);
    expect(result.laborTotalCents).toBe(80_000);
    expect(result.adjustedCostCents).toBe(270_000);
  });

  it('uses install-type specific profit floor', () => {
    const combo = computeInstallPriceBreakdown({
      installType: 'COMBO',
      accessType: 'STANDARD',
      equipmentCostCents: 1,
      materialsCostCents: 1,
      baseLaborCostCents: 1,
      permitCostCents: 0,
    });
    const single = computeInstallPriceBreakdown({
      installType: 'AC_ONLY',
      accessType: 'STANDARD',
      equipmentCostCents: 1,
      materialsCostCents: 1,
      baseLaborCostCents: 1,
      permitCostCents: 0,
    });

    expect(combo.profitFloorCents).toBe(350_000);
    expect(single.profitFloorCents).toBe(200_000);
  });

  it('applies $500 access add-on before 5% sales cushion', () => {
    const result = computeInstallPriceBreakdown({
      installType: 'FURNACE_ONLY',
      accessType: 'ATTIC',
      equipmentCostCents: 100_000,
      materialsCostCents: 0,
      baseLaborCostCents: 0,
      permitCostCents: 0,
    });

    expect(result.accessAddOnCents).toBe(50_000);
    expect(result.basePriceCents).toBe(370_000);
    expect(result.priceBeforeDiscountCents).toBe(388_500);
  });

  it('always applies and rounds 5% sales cushion', () => {
    const result = computeInstallPriceBreakdown({
      installType: 'FURNACE_ONLY',
      accessType: 'STANDARD',
      equipmentCostCents: 12_345,
      materialsCostCents: 0,
      baseLaborCostCents: 0,
      permitCostCents: 0,
    });

    const expectedBase = Math.round(12_345 * 1.2) + 200_000;
    expect(result.basePriceCents).toBe(expectedBase);
    expect(result.priceBeforeDiscountCents).toBe(Math.round(expectedBase * 1.05));
  });

  it('sums percent and dollar discount amounts', () => {
    const result = computeInstallPriceBreakdown({
      installType: 'FURNACE_ONLY',
      accessType: 'STANDARD',
      equipmentCostCents: 100_000,
      materialsCostCents: 0,
      baseLaborCostCents: 0,
      permitCostCents: 0,
      discountPctBps: 500,
      discountCents: 10_000,
    });

    expect(result.discountTotalCents).toBe(
      computeDiscountAmount(result.priceBeforeDiscountCents, 500, 10_000),
    );
  });

  it('transitions guardrails at 18/15/12% thresholds after discount', () => {
    const baseInput = {
      installType: 'FURNACE_ONLY' as const,
      accessType: 'STANDARD' as const,
      equipmentCostCents: 100_000,
      materialsCostCents: 0,
      baseLaborCostCents: 0,
      permitCostCents: 0,
    };

    const ok = computeInstallPriceBreakdown({
      ...baseInput,
      discountCents: 200_000,
    });
    const warning = computeInstallPriceBreakdown({
      ...baseInput,
      discountCents: 214_060,
    });
    const requireApproval = computeInstallPriceBreakdown({
      ...baseInput,
      discountCents: 218_360,
    });
    const blocked = computeInstallPriceBreakdown({
      ...baseInput,
      discountCents: 222_400,
    });

    expect(ok.guardrailStatus).toBe('OK');
    expect(warning.guardrailStatus).toBe('WARNING');
    expect(requireApproval.guardrailStatus).toBe('REQUIRE_APPROVAL');
    expect(blocked.guardrailStatus).toBe('BLOCK');
  });

  it('never returns negative final sell price', () => {
    const result = computeInstallPriceBreakdown({
      installType: 'AC_ONLY',
      accessType: 'STANDARD',
      equipmentCostCents: 30_000,
      materialsCostCents: 10_000,
      baseLaborCostCents: 0,
      permitCostCents: 0,
      discountCents: 999_999_999,
    });

    expect(result.finalSellPriceCents).toBe(0);
    expect(result.guardrailStatus).toBe('BLOCK');
  });

  it('requires manual labor reason when manual adjustment is non-zero', () => {
    expect(() =>
      computeInstallPriceBreakdown({
        installType: 'AC_ONLY',
        accessType: 'STANDARD',
        equipmentCostCents: 1,
        materialsCostCents: 1,
        baseLaborCostCents: 1,
        manualLaborAdjustmentCents: 100,
      }),
    ).toThrow(/manualLaborReason/);
  });

  it('allows negative manual labor adjustment when a reason is provided', () => {
    const result = computeInstallPriceBreakdown({
      installType: 'AC_ONLY',
      accessType: 'STANDARD',
      equipmentCostCents: 80_000,
      materialsCostCents: 20_000,
      baseLaborCostCents: 40_000,
      manualLaborAdjustmentCents: -90_000,
      manualLaborReason: 'Warranty labor credit',
      permitCostCents: 0,
    });

    expect(result.laborTotalCents).toBe(-50_000);
    expect(result.finalSellPriceCents).toBeGreaterThanOrEqual(0);
  });
});

describe('evaluateInstallGuardrail', () => {
  it('handles explicit boundary values', () => {
    expect(evaluateInstallGuardrail(82_000, 100_000).status).toBe('OK');
    expect(evaluateInstallGuardrail(83_000, 100_000).status).toBe('WARNING');
    expect(evaluateInstallGuardrail(86_000, 100_000).status).toBe('REQUIRE_APPROVAL');
    expect(evaluateInstallGuardrail(89_000, 100_000).status).toBe('BLOCK');
  });
});
