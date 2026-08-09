export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

export {
  computeDiscountAmount,
  computeInstallPriceBreakdown,
  evaluateInstallGuardrail,
} from './pricing.js';

export {
  computeServiceQuoteTotals,
  recomputeDiagnosticCredit,
  resolveLaborRateCents,
  roundToNearestHalfHour,
} from './service-pricing.js';

export type {
  GuardrailReason,
  GuardrailStatus,
  InstallAccessType,
  InstallPriceBreakdown,
  InstallPriceInput,
  InstallType,
  QuotePricingMode,
} from './pricing.js';

export type {
  DiagnosticCreditResult,
  ServiceGuardrailStatus,
  ServiceQuoteLineItem,
  ServiceQuoteTotalsInput,
  ServiceQuoteTotalsResult,
  ServiceTiming,
} from './service-pricing.js';

export type {
  MobileSyncPullRequest,
  MobileSyncPullResponse,
  MobileSyncPushAction,
  MobileSyncPushRequest,
  MobileSyncPushResponse,
  MobileSyncPushResult,
} from './mobile-sync-contract.js';

export {
  HVAC_CALCULATION_VERSION,
  HVAC_MEASUREMENT_DEFINITIONS,
  buildDeterministicHvacAssistantReply,
  buildHvacDiagnosticReportSnapshot,
  calculateHvacDerivedMeasurements,
  canonicalizeHvacMeasurement,
  compareHvacValueToReference,
  evaluateHvacDiagnosticSnapshot,
  getHvacNextStep,
  latestHvacMeasurements,
  parseHvacBoolean,
} from './hvac-diagnostics.js';

export type {
  CanonicalHvacMeasurement,
  HvacDerivedMeasurement,
  HvacDiagnosticSnapshot,
  HvacFindingDraft,
  HvacFindingSupport,
  HvacMeasurementCategory,
  HvacMeasurementDefinition,
  HvacMeasurementInput,
  HvacMeasurementStage,
  HvacNextStep,
  HvacOemReferenceLike,
  HvacOperatingMode,
} from './hvac-diagnostics.js';

