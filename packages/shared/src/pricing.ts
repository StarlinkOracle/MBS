export type InstallType = 'COMBO' | 'FURNACE_ONLY' | 'AC_ONLY';

export type InstallAccessType = 'STANDARD' | 'ATTIC' | 'CONFINED_CRAWLSPACE';

export type QuotePricingMode = 'INSTALL_CUSHION20_FLOOR_ACCESS500_SALES5_DISCOUNT';

export type GuardrailStatus = 'OK' | 'WARNING' | 'REQUIRE_APPROVAL' | 'BLOCK';

export type InstallPriceInput = {
  installType: InstallType;
  accessType: InstallAccessType;
  equipmentCostCents: number;
  materialsCostCents: number;
  baseLaborCostCents: number;
  manualLaborAdjustmentCents?: number;
  manualLaborReason?: string | null;
  permitCostCents?: number;
  discountPctBps?: number;
  discountCents?: number;
};

export type GuardrailReason = {
  code:
    | 'FINAL_PRICE_ZERO'
    | 'MARGIN_LT_12'
    | 'MARGIN_LT_15'
    | 'MARGIN_LT_18';
  message: string;
  marginBps: number;
};

export type InstallPriceBreakdown = {
  pricingMode: QuotePricingMode;
  cushionPct: number;
  equipmentAdjustedCents: number;
  materialsAdjustedCents: number;
  laborTotalCents: number;
  adjustedCostCents: number;
  profitFloorCents: number;
  accessAddOnCents: number;
  basePriceCents: number;
  salesCushionPct: number;
  priceBeforeDiscountCents: number;
  discountPctBps: number;
  discountCents: number;
  discountTotalCents: number;
  finalSellPriceCents: number;
  rawCostTotalCents: number;
  effectiveProfitCents: number;
  effectiveMarginBps: number;
  guardrailStatus: GuardrailStatus;
  guardrailReasons: GuardrailReason[];
};

function assertNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  if (value < 0) {
    throw new Error(`${name} must be >= 0`);
  }
}

function profitFloorForInstallType(installType: InstallType): number {
  return installType === 'COMBO' ? 350_000 : 200_000;
}

function accessAddOnForType(accessType: InstallAccessType): number {
  return accessType === 'ATTIC' || accessType === 'CONFINED_CRAWLSPACE'
    ? 50_000
    : 0;
}

export function computeDiscountAmount(
  priceBeforeDiscountCents: number,
  discountPctBps = 0,
  discountCents = 0,
): number {
  assertNonNegative('priceBeforeDiscountCents', priceBeforeDiscountCents);
  assertNonNegative('discountPctBps', discountPctBps);
  assertNonNegative('discountCents', discountCents);

  const pctAmount = Math.round(
    priceBeforeDiscountCents * (discountPctBps / 10_000),
  );
  return pctAmount + Math.round(discountCents);
}

export function evaluateInstallGuardrail(
  rawCostTotalCents: number,
  finalSellPriceCents: number,
): {
  status: GuardrailStatus;
  effectiveProfitCents: number;
  effectiveMarginBps: number;
  reasons: GuardrailReason[];
} {
  if (!Number.isFinite(rawCostTotalCents)) {
    throw new Error('rawCostTotalCents must be a finite number');
  }
  assertNonNegative('finalSellPriceCents', finalSellPriceCents);

  const effectiveProfitCents = finalSellPriceCents - rawCostTotalCents;
  const effectiveMarginBps =
    finalSellPriceCents === 0
      ? 0
      : Math.round((effectiveProfitCents / finalSellPriceCents) * 10_000);

  if (finalSellPriceCents === 0) {
    return {
      status: 'BLOCK',
      effectiveProfitCents,
      effectiveMarginBps,
      reasons: [
        {
          code: 'FINAL_PRICE_ZERO',
          message:
            'Final sell price is zero; margin guardrail blocks this option.',
          marginBps: effectiveMarginBps,
        },
      ],
    };
  }

  if (effectiveMarginBps < 1_200) {
    return {
      status: 'BLOCK',
      effectiveProfitCents,
      effectiveMarginBps,
      reasons: [
        {
          code: 'MARGIN_LT_12',
          message: 'Effective margin below 12% blocks this option.',
          marginBps: effectiveMarginBps,
        },
      ],
    };
  }

  if (effectiveMarginBps < 1_500) {
    return {
      status: 'REQUIRE_APPROVAL',
      effectiveProfitCents,
      effectiveMarginBps,
      reasons: [
        {
          code: 'MARGIN_LT_15',
          message: 'Effective margin below 15% requires approval.',
          marginBps: effectiveMarginBps,
        },
      ],
    };
  }

  if (effectiveMarginBps < 1_800) {
    return {
      status: 'WARNING',
      effectiveProfitCents,
      effectiveMarginBps,
      reasons: [
        {
          code: 'MARGIN_LT_18',
          message: 'Effective margin below 18% should be reviewed.',
          marginBps: effectiveMarginBps,
        },
      ],
    };
  }

  return {
    status: 'OK',
    effectiveProfitCents,
    effectiveMarginBps,
    reasons: [],
  };
}

export function computeInstallPriceBreakdown(
  input: InstallPriceInput,
): InstallPriceBreakdown {
  assertNonNegative('equipmentCostCents', input.equipmentCostCents);
  assertNonNegative('materialsCostCents', input.materialsCostCents);
  assertNonNegative('baseLaborCostCents', input.baseLaborCostCents);
  assertNonNegative('permitCostCents', input.permitCostCents ?? 0);

  const manualLaborAdjustmentCents = Math.round(
    input.manualLaborAdjustmentCents ?? 0,
  );
  if (
    manualLaborAdjustmentCents !== 0 &&
    !(input.manualLaborReason && input.manualLaborReason.trim().length > 0)
  ) {
    throw new Error('manualLaborReason is required when labor adjustment is non-zero');
  }

  const discountPctBps = Math.round(input.discountPctBps ?? 0);
  const discountCents = Math.round(input.discountCents ?? 0);
  if (discountPctBps < 0 || discountPctBps > 10_000) {
    throw new Error('discountPctBps must be between 0 and 10000');
  }
  if (discountCents < 0) {
    throw new Error('discountCents must be >= 0');
  }

  const equipmentAdjustedCents = Math.round(input.equipmentCostCents * 1.2);
  const materialsAdjustedCents = Math.round(input.materialsCostCents * 1.2);
  const laborTotalCents = input.baseLaborCostCents + manualLaborAdjustmentCents;
  const permitCostCents = input.permitCostCents ?? 0;

  const adjustedCostCents =
    equipmentAdjustedCents +
    materialsAdjustedCents +
    laborTotalCents +
    permitCostCents;

  const profitFloorCents = profitFloorForInstallType(input.installType);
  const accessAddOnCents = accessAddOnForType(input.accessType);
  const basePriceCents = adjustedCostCents + profitFloorCents + accessAddOnCents;
  const priceBeforeDiscountCents = Math.round(basePriceCents * 1.05);

  const discountTotalCents = computeDiscountAmount(
    priceBeforeDiscountCents,
    discountPctBps,
    discountCents,
  );
  const finalSellPriceCents = Math.max(
    0,
    priceBeforeDiscountCents - discountTotalCents,
  );

  const rawCostTotalCents =
    input.equipmentCostCents +
    input.materialsCostCents +
    laborTotalCents +
    permitCostCents;

  const guardrail = evaluateInstallGuardrail(rawCostTotalCents, finalSellPriceCents);

  return {
    pricingMode: 'INSTALL_CUSHION20_FLOOR_ACCESS500_SALES5_DISCOUNT',
    cushionPct: 20,
    equipmentAdjustedCents,
    materialsAdjustedCents,
    laborTotalCents,
    adjustedCostCents,
    profitFloorCents,
    accessAddOnCents,
    basePriceCents,
    salesCushionPct: 5,
    priceBeforeDiscountCents,
    discountPctBps,
    discountCents,
    discountTotalCents,
    finalSellPriceCents,
    rawCostTotalCents,
    effectiveProfitCents: guardrail.effectiveProfitCents,
    effectiveMarginBps: guardrail.effectiveMarginBps,
    guardrailStatus: guardrail.status,
    guardrailReasons: guardrail.reasons,
  };
}
