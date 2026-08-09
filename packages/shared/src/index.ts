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
