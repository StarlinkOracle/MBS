import {
  AgentRunStatus,
  ActorType,
  AppointmentStatus,
  AppointmentType,
  AssessmentAttachmentKind,
  AttachmentRefProvider,
  AttachmentKind,
  AttachmentOwnerType,
  AttachmentStorageProvider,
  AttachmentTag,
  AttributionSourceType,
  CallDirection,
  EquipmentCatalogSourceStatus,
  ExpenseStatus,
  GuardrailStatus,
  InstallAccessType,
  InstallType,
  JobGeoSource,
  LeadStage,
  LeadType,
  LostOutcome,
  LeadSitePropertyType,
  MediaUploadSessionStatus,
  MembershipStatus,
  PricebookItemKind,
  RooftopAccessType,
  PrismaClient,
  Prisma,
  CommsChannel,
  CommsDirection,
  CommsEntityType,
  CommsStatus,
  QuoteBookingTriggerStatus,
  QuoteKind,
  QuoteLineItemType,
  QuotePricingMode,
  ReferralEventStatus,
  ReviewRequestChannel,
  ReviewRequestStatus,
  ReceiptOcrProvider,
  ReceiptOcrStatus,
  SafetyMode,
  ServiceTiming,
  TaskPriority,
  TaskStatus,
  TimeEditRequestStatus,
  TimeEntryStatus,
  TimeEntryType,
  TimeBlockCode,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import {
  MASTER_AGENT_GRAPH,
  isReachable as isSkillReachable,
  validateEntryCriteria as validateSkillEntry,
  type AgentGraphStateSummary,
} from '@rcs/agent-graph';
import {
  createGmailConnector,
  createIMessageConnectorMac,
  sendGmailMessage,
  sendIMessageViaShortcut,
  type CommsParticipant,
  type SyncMessageRecord,
} from '@rcs/connectors';
import {
  decodeCapacityFromModel,
  normalizeModel,
} from '@rcs/equipment-decoder';
import { enqueueOutbox } from '@rcs/event-bus';
import { geocodeAddress } from '@rcs/geocode';
import { deleteObject } from '@rcs/storage';
import {
  computeDiscountAmount,
  computeInstallPriceBreakdown,
  computeServiceQuoteTotals,
  evaluateInstallGuardrail,
  roundToNearestHalfHour,
} from '@rcs/shared';
import { z } from 'zod';

import {
  HandlerMap,
  ToolExecutionError,
  ToolHandler,
} from './types.js';
import {
  extractEquipmentCatalogRows,
  type EquipmentCatalogMapping,
} from './equipment-catalog.js';
import {
  applyTimeWindowOverlay,
  checkMaxRiskLevelAutonomous,
  isToolBlocked,
  wildcardMatch,
} from './policy/engine.js';

function jsonResult(value: unknown): Prisma.JsonValue {
  return value as Prisma.JsonValue;
}

function toInputJson(value: unknown): Prisma.InputJsonValue {
  if (value === undefined || value === null) {
    return {} as Prisma.InputJsonValue;
  }
  return value as Prisma.InputJsonValue;
}

function jsonObject(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toDateOrNull(value: unknown): Date | null {
  if (!value) {
    return null;
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function unknownObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function unknownObjectArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rows: Record<string, unknown>[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    rows.push(item as Record<string, unknown>);
  }
  return rows;
}

function parseContractReferences(text: string): string[] {
  const refs = new Set<string>();
  const pattern = /\b(?:section|sec\.?)\s+(\d+(?:\.\d+)*)\b/gi;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match) {
    const ref = match[1];
    if (ref) {
      refs.add(`Section ${ref}`);
    }
    match = pattern.exec(text);
  }
  return Array.from(refs);
}

function extractPlaceholders(text: string | null | undefined): string[] {
  if (!text) {
    return [];
  }
  const placeholders = new Set<string>();
  const pattern = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match) {
    const placeholder = toStringOrNull(match[1]);
    if (placeholder) {
      placeholders.add(placeholder);
    }
    match = pattern.exec(text);
  }
  return Array.from(placeholders).sort((a, b) => a.localeCompare(b));
}

function raiseToolError(
  code: string,
  message: string,
  recoverable: boolean,
): never {
  throw new ToolExecutionError({
    code,
    message,
    recoverable,
  });
}

function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes';
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  return false;
}

function normalizePhone(value: unknown): string | null {
  const input = toStringOrNull(value);
  if (!input) {
    return null;
  }

  const digits = input.replace(/\D/g, '');
  if (!digits) {
    return null;
  }
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }
  return `+${digits}`;
}

function normalizeEmail(value: unknown): string | null {
  const input = toStringOrNull(value);
  return input ? input.toLowerCase() : null;
}

function participantJsonToArray(value: unknown): CommsParticipant[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const participants: CommsParticipant[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const row = item as Record<string, unknown>;
    participants.push({
      name: toStringOrNull(row.name),
      phone: normalizePhone(row.phone ?? row.raw),
      email: normalizeEmail(row.email ?? row.raw),
      raw: toStringOrNull(row.raw),
    });
  }
  return participants;
}

function dedupeParticipants(participants: CommsParticipant[]): CommsParticipant[] {
  const seen = new Set<string>();
  const output: CommsParticipant[] = [];

  for (const participant of participants) {
    const key =
      participant.email?.toLowerCase() ??
      participant.phone ??
      participant.raw?.toLowerCase() ??
      JSON.stringify(participant);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(participant);
  }

  return output;
}

function extractThreadPhonesAndEmails(participants: CommsParticipant[]): {
  phones: string[];
  emails: string[];
} {
  const phoneSet = new Set<string>();
  const emailSet = new Set<string>();

  for (const participant of participants) {
    const phone = normalizePhone(participant.phone ?? participant.raw);
    const email = normalizeEmail(participant.email ?? participant.raw);
    if (phone) {
      phoneSet.add(phone);
    }
    if (email) {
      emailSet.add(email);
    }
  }

  return {
    phones: Array.from(phoneSet),
    emails: Array.from(emailSet),
  };
}

function localHourInTimezone(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '0';
  const parsed = Number.parseInt(hour, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeDirection(value: unknown): CallDirection {
  const normalized = String(value ?? '')
    .trim()
    .toUpperCase();
  return normalized === 'OUTBOUND' ? CallDirection.OUTBOUND : CallDirection.INBOUND;
}

function buildFullName(input: {
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  email?: string | null;
  phone?: string | null;
}): string {
  const explicit = toStringOrNull(input.fullName);
  if (explicit) {
    return explicit;
  }

  const first = toStringOrNull(input.firstName);
  const last = toStringOrNull(input.lastName);
  const combined = [first, last].filter(Boolean).join(' ').trim();
  if (combined.length > 0) {
    return combined;
  }

  return (
    toStringOrNull(input.email) ??
    toStringOrNull(input.phone) ??
    'Website Lead'
  );
}

function upsertLeadNote(existingNotes: string | null, note: string): string {
  const stamped = `[${new Date().toISOString()}] ${note}`;
  return existingNotes ? `${existingNotes}\n${stamped}` : stamped;
}

const LEAD_TERMINAL_STAGES = new Set<LeadStage>([LeadStage.WON, LeadStage.LOST]);

const DEFAULT_LEAD_SLA_HOURS: Record<LeadStage, number> = {
  [LeadStage.NEW]: 1,
  [LeadStage.CONTACTED]: 4,
  [LeadStage.QUALIFIED]: 8,
  [LeadStage.APPOINTMENT_SET]: 24,
  [LeadStage.ESTIMATE_SENT]: 24,
  [LeadStage.WON]: 0,
  [LeadStage.LOST]: 0,
  [LeadStage.NURTURE]: 168,
};

type LeadSlaConfig = {
  hoursByStage: Record<LeadStage, number>;
  dueSoonMinutes: number;
};

type LeadSlaEvaluation = {
  slaStatus: 'OK' | 'DUE_SOON' | 'OVERDUE';
  minutesUntilDue: number;
  escalationLevel: 'NONE' | 'DISPATCHER' | 'MANAGER';
};

function parseLeadStage(value: unknown): LeadStage {
  const normalized = String(value ?? '')
    .trim()
    .toUpperCase();

  if (normalized in LeadStage) {
    return normalized as LeadStage;
  }

  raiseToolError('LEAD_STAGE_INVALID', `Invalid lead stage: ${String(value ?? '')}`, false);
}

function leadStageFromRecord(value: unknown): LeadStage {
  const normalized = String(value ?? '')
    .trim()
    .toUpperCase();
  if (normalized in LeadStage) {
    return normalized as LeadStage;
  }
  return LeadStage.NEW;
}

function parseLeadType(value: unknown): LeadType {
  const normalized = String(value ?? '')
    .trim()
    .toUpperCase();

  if (normalized in LeadType) {
    return normalized as LeadType;
  }

  raiseToolError('LEAD_TYPE_INVALID', `Invalid lead type: ${String(value ?? '')}`, false);
}

function parseLostOutcome(value: unknown): LostOutcome | null {
  const normalized = String(value ?? '')
    .trim()
    .toUpperCase();
  if (!normalized) {
    return null;
  }
  if (normalized in LostOutcome) {
    return normalized as LostOutcome;
  }
  raiseToolError('LEAD_LOST_OUTCOME_INVALID', `Invalid lost outcome: ${String(value ?? '')}`, false);
}

function parseTaskPriority(value: unknown): TaskPriority {
  const normalized = String(value ?? 'NORMAL')
    .trim()
    .toUpperCase();
  if (normalized === 'LOW') {
    return TaskPriority.LOW;
  }
  if (normalized === 'HIGH') {
    return TaskPriority.HIGH;
  }
  return TaskPriority.MEDIUM;
}

function mergeLeadSlaHours(input: unknown): Record<LeadStage, number> {
  const hours: Record<LeadStage, number> = { ...DEFAULT_LEAD_SLA_HOURS };
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return hours;
  }

  for (const [rawStage, rawHours] of Object.entries(input as Record<string, unknown>)) {
    const normalized = rawStage.trim().toUpperCase();
    if (!(normalized in LeadStage)) {
      continue;
    }
    const parsed = Number(rawHours);
    if (!Number.isFinite(parsed) || parsed < 0) {
      continue;
    }
    hours[normalized as LeadStage] = Math.floor(parsed);
  }

  return hours;
}

async function loadLeadSlaConfig(
  client: PrismaClient | Prisma.TransactionClient,
  orgId: string,
): Promise<LeadSlaConfig> {
  const policy = await client.leadSlaPolicy.findUnique({
    where: { orgId },
    select: {
      hoursByStage: true,
      dueSoonMinutes: true,
    },
  });

  if (!policy) {
    return {
      hoursByStage: { ...DEFAULT_LEAD_SLA_HOURS },
      dueSoonMinutes: 60,
    };
  }

  return {
    hoursByStage: mergeLeadSlaHours(policy.hoursByStage),
    dueSoonMinutes:
      typeof policy.dueSoonMinutes === 'number' && Number.isFinite(policy.dueSoonMinutes)
        ? Math.max(1, Math.floor(policy.dueSoonMinutes))
        : 60,
  };
}

function computeNextTouchDueAt(
  stage: LeadStage,
  config: LeadSlaConfig,
  now: Date = new Date(),
): Date | null {
  if (LEAD_TERMINAL_STAGES.has(stage)) {
    return null;
  }
  const hours = config.hoursByStage[stage];
  const safeHours = Number.isFinite(hours) ? Math.max(1, Math.floor(hours)) : 1;
  return new Date(now.getTime() + safeHours * 60 * 60 * 1000);
}

function evaluateLeadSla(
  nextTouchDueAt: Date | null | undefined,
  dueSoonMinutes: number,
  now: Date = new Date(),
): LeadSlaEvaluation {
  if (!nextTouchDueAt) {
    return {
      slaStatus: 'OK',
      minutesUntilDue: 0,
      escalationLevel: 'NONE',
    };
  }

  const minutesUntilDue = Math.floor((nextTouchDueAt.getTime() - now.getTime()) / 60000);
  if (minutesUntilDue <= 0) {
    return {
      slaStatus: 'OVERDUE',
      minutesUntilDue,
      escalationLevel: 'MANAGER',
    };
  }
  if (minutesUntilDue <= dueSoonMinutes) {
    return {
      slaStatus: 'DUE_SOON',
      minutesUntilDue,
      escalationLevel: 'DISPATCHER',
    };
  }

  return {
    slaStatus: 'OK',
    minutesUntilDue,
    escalationLevel: 'NONE',
  };
}

async function createLeadTimelineEvent(
  client: PrismaClient | Prisma.TransactionClient,
  args: {
    orgId: string;
    leadId: string;
    type: string;
    message: string;
    requestId?: string | null;
    metadata?: Prisma.InputJsonValue;
  },
): Promise<{ event: { id: string }; idempotent: boolean }> {
  const requestId = toStringOrNull(args.requestId);
  if (requestId) {
    const existing = await client.timelineEvent.findFirst({
      where: {
        orgId: args.orgId,
        leadId: args.leadId,
        type: args.type,
        requestId,
      },
      select: { id: true },
    });
    if (existing) {
      return { event: existing, idempotent: true };
    }
  }

  const created = await client.timelineEvent.create({
    data: {
      orgId: args.orgId,
      leadId: args.leadId,
      type: args.type,
      message: args.message,
      requestId,
      metadata: args.metadata ?? ({} as Prisma.InputJsonValue),
    },
    select: { id: true },
  });
  return { event: created, idempotent: false };
}

async function closeLeadNextActions(
  client: PrismaClient | Prisma.TransactionClient,
  args: {
    orgId: string;
    leadId: string;
    now: Date;
  },
): Promise<number> {
  const result = await client.task.updateMany({
    where: {
      orgId: args.orgId,
      leadId: args.leadId,
      isNextAction: true,
      status: {
        in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS],
      },
    },
    data: {
      status: TaskStatus.COMPLETED,
      completedAt: args.now,
    },
  });
  return result.count;
}

async function ensureLeadNextActionTask(
  client: PrismaClient | Prisma.TransactionClient,
  args: {
    orgId: string;
    leadId: string;
    ownerUserId?: string | null;
    dueAt: Date;
    stage: LeadStage;
    requestId?: string | null;
    title?: string | null;
    description?: string | null;
    priority?: TaskPriority;
    taskType?: string | null;
  },
): Promise<{ taskId: string; idempotent: boolean } | null> {
  const openExisting = await client.task.findFirst({
    where: {
      orgId: args.orgId,
      leadId: args.leadId,
      isNextAction: true,
      status: {
        in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS],
      },
    },
    select: { id: true },
  });
  if (openExisting) {
    return {
      taskId: openExisting.id,
      idempotent: true,
    };
  }

  const requestId = toStringOrNull(args.requestId);
  if (requestId) {
    const existingByRequestId = await client.task.findFirst({
      where: {
        orgId: args.orgId,
        leadId: args.leadId,
        requestId,
      },
      select: { id: true },
    });
    if (existingByRequestId) {
      return {
        taskId: existingByRequestId.id,
        idempotent: true,
      };
    }
  }

  const created = await client.task.create({
    data: {
      orgId: args.orgId,
      leadId: args.leadId,
      title: toStringOrNull(args.title) ?? `Next action (${args.stage})`,
      description:
        toStringOrNull(args.description) ??
        `Follow up required for lead stage ${args.stage}.`,
      kind: toStringOrNull(args.taskType) ?? 'FOLLOW_UP',
      isNextAction: true,
      queue: 'SALES',
      dueAt: args.dueAt,
      priority: args.priority ?? TaskPriority.MEDIUM,
      assignedToUserId: toStringOrNull(args.ownerUserId),
      requestId,
      metadata: toInputJson({
        source: 'lead-care-auto',
        stage: args.stage,
      }),
    },
    select: { id: true },
  });

  return {
    taskId: created.id,
    idempotent: false,
  };
}

type VendorSuggestion = {
  canonicalName: string | null;
  aliasMatched: string | null;
};

function suggestVendorName(rawVendorName: string | null): VendorSuggestion {
  if (!rawVendorName) {
    return { canonicalName: null, aliasMatched: null };
  }
  const normalized = rawVendorName.toUpperCase();
  if (normalized.includes('JOHNSTONE')) {
    return { canonicalName: 'Johnstone Supply', aliasMatched: 'JOHNSTONE' };
  }
  if (normalized.includes('FERGUSON')) {
    return { canonicalName: 'Ferguson', aliasMatched: 'FERGUSON' };
  }
  return { canonicalName: rawVendorName, aliasMatched: null };
}

function suggestCategoryName(
  vendorName: string | null,
): 'COGS - Parts' | 'Fuel' | null {
  if (!vendorName) {
    return null;
  }
  const normalized = vendorName.toUpperCase();
  if (normalized.includes('JOHNSTONE') || normalized.includes('FERGUSON')) {
    return 'COGS - Parts';
  }
  if (normalized.includes('GAS')) {
    return 'Fuel';
  }
  return null;
}

function toReceiptOcrProvider(value: unknown): ReceiptOcrProvider {
  const normalized = String(value ?? 'OPENAI_VISION')
    .trim()
    .toUpperCase();

  if (normalized === 'GOOGLE_VISION') {
    return ReceiptOcrProvider.GOOGLE_VISION;
  }
  if (normalized === 'TESSERACT') {
    return ReceiptOcrProvider.TESSERACT;
  }
  return ReceiptOcrProvider.OPENAI_VISION;
}

function toReceiptOcrStatus(value: unknown): ReceiptOcrStatus {
  const normalized = String(value ?? 'COMPLETED')
    .trim()
    .toUpperCase();
  if (normalized === 'FAILED') {
    return ReceiptOcrStatus.FAILED;
  }
  if (normalized === 'PENDING') {
    return ReceiptOcrStatus.PENDING;
  }
  return ReceiptOcrStatus.COMPLETED;
}

function toReviewRequestChannel(
  value: unknown,
): ReviewRequestChannel | null {
  const normalized = String(value ?? '')
    .trim()
    .toUpperCase();
  if (normalized === 'SMS') {
    return ReviewRequestChannel.SMS;
  }
  if (normalized === 'EMAIL') {
    return ReviewRequestChannel.EMAIL;
  }
  return null;
}

function toReferralEventStatus(
  value: unknown,
): ReferralEventStatus | null {
  const normalized = String(value ?? '')
    .trim()
    .toUpperCase();
  if (normalized === 'INVITED') {
    return ReferralEventStatus.INVITED;
  }
  if (normalized === 'LEAD_CREATED') {
    return ReferralEventStatus.LEAD_CREATED;
  }
  if (normalized === 'WON') {
    return ReferralEventStatus.WON;
  }
  if (normalized === 'REWARDED') {
    return ReferralEventStatus.REWARDED;
  }
  if (normalized === 'VOID') {
    return ReferralEventStatus.VOID;
  }
  return null;
}

const websiteLeadUpsertSchema = z.object({
  firstName: z.string().trim().optional(),
  lastName: z.string().trim().optional(),
  fullName: z.string().trim().optional(),
  email: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  address: z.string().trim().optional(),
  city: z.string().trim().optional(),
  state: z.string().trim().optional(),
  zip: z.string().trim().optional(),
  serviceType: z.string().trim().optional(),
  preferredDate: z.string().trim().optional(),
  preferredTime: z.string().trim().optional(),
  message: z.string().trim().optional(),
  source: z.string().trim().min(1),
  leadSource: z.string().trim().optional(),
});

const websiteAttributionCaptureSchema = z.object({
  leadId: z.string().trim().min(1),
  sourceType: z.string().trim().optional(),
  utmSource: z.string().trim().optional(),
  utmMedium: z.string().trim().optional(),
  utmCampaign: z.string().trim().optional(),
  utmContent: z.string().trim().optional(),
  utmTerm: z.string().trim().optional(),
  gclid: z.string().trim().optional(),
  gbraid: z.string().trim().optional(),
  wbraid: z.string().trim().optional(),
  fbclid: z.string().trim().optional(),
  landingUrl: z.string().trim().optional(),
  referrerUrl: z.string().trim().optional(),
  visitorId: z.string().trim().optional(),
  userAgent: z.string().trim().optional(),
  ipHash: z.string().trim().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const timelineAddSchema = z.object({
  leadId: z.string().trim().min(1),
  type: z.string().trim().min(1),
  message: z.string().trim().min(1),
  metadata: z.record(z.unknown()).optional(),
});

const salesTaskCreateSchema = z.object({
  leadId: z.string().trim().min(1),
  kind: z.enum(['CONTACT', 'PRICE_MATCH']),
  dueInMinutes: z.number().int().positive(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  queue: z.string().trim().min(1).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const attachmentRefCreateSchema = z.object({
  provider: z.enum(['S3', 'URL']),
  bucket: z.string().trim().optional(),
  objectKey: z.string().trim().optional(),
  url: z.string().trim().optional(),
  fileName: z.string().trim().min(1),
  mimeType: z.string().trim().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  checksumSha256: z.string().trim().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const priceMatchCreateSchema = z.object({
  leadId: z.string().trim().min(1),
  competitorName: z.string().trim().min(1),
  competitorPriceCents: z.number().int().nonnegative().optional(),
  notes: z.string().trim().optional(),
  serviceType: z.string().trim().optional(),
  attachmentRefId: z.string().trim().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const leadUpdateStageSchema = z
  .object({
    leadId: z.string().trim().min(1),
    stage: z.string().trim().min(1),
    notes: z.string().trim().optional(),
    valueCents: z.number().int().nonnegative().optional(),
    assignedToUserId: z.string().trim().optional(),
  })
  .strict();

const leadProfileUpsertSchema = z
  .object({
    leadId: z.string().trim().min(1).optional(),
    sourceLeadId: z.string().trim().min(1).optional(),
    leadType: z.enum(['RESIDENTIAL_SINGLE', 'RESIDENTIAL_MULTI_PROPERTY', 'COMMERCIAL']),
    displayName: z.string().trim().optional(),
    primaryContact: z
      .object({
        name: z.string().trim().optional(),
        email: z.string().trim().optional(),
        phone: z.string().trim().optional(),
      })
      .partial()
      .optional(),
    company: z
      .object({
        legalName: z.string().trim().optional(),
        dba: z.string().trim().optional(),
        website: z.string().trim().optional(),
      })
      .partial()
      .optional(),
    tags: z.array(z.string().trim().min(1)).optional(),
    notes: z.string().trim().optional(),
    requestId: z.string().trim().optional(),
  })
  .strict();

const leadSiteUpsertSchema = z
  .object({
    leadId: z.string().trim().min(1),
    siteId: z.string().trim().min(1).optional(),
    label: z.string().trim().optional(),
    address: z
      .object({
        line1: z.string().trim().min(1),
        line2: z.string().trim().optional(),
        city: z.string().trim().min(1),
        state: z.string().trim().min(1),
        postalCode: z.string().trim().min(1),
      })
      .strict(),
    property: z
      .object({
        propertyType: z.enum(['RESIDENTIAL', 'COMMERCIAL']).optional(),
        units: z.number().int().positive().optional(),
        sqft: z.number().int().positive().optional(),
        yearBuilt: z.number().int().optional(),
      })
      .partial()
      .optional(),
    commercial: z
      .object({
        rtuCount: z.number().int().nonnegative().optional(),
        rooftopAccessType: z.enum(['NONE', 'HATCH', 'LADDER', 'STAIRS', 'UNKNOWN']).optional(),
        rooftopAccessNotes: z.string().trim().optional(),
      })
      .partial()
      .optional(),
    siteNotes: z.string().trim().optional(),
    requestId: z.string().trim().optional(),
  })
  .strict();

const leadStageUpdateV2Schema = z
  .object({
    leadId: z.string().trim().min(1),
    toStage: z.enum([
      'NEW',
      'CONTACTED',
      'QUALIFIED',
      'APPOINTMENT_SET',
      'ESTIMATE_SENT',
      'WON',
      'LOST',
      'NURTURE',
    ]),
    reason: z.string().trim().optional(),
    lostOutcome: z
      .enum([
        'NO_CONTACT',
        'NO_SHOW',
        'PRICE',
        'TIMING',
        'COMPETITOR',
        'NOT_A_FIT',
        'DUPLICATE',
        'OTHER',
      ])
      .optional(),
    lostNotes: z.string().trim().optional(),
    requestId: z.string().trim().optional(),
  })
  .strict();

const leadOwnerAssignSchema = z
  .object({
    leadId: z.string().trim().min(1),
    ownerUserId: z.string().trim().min(1),
    reason: z.string().trim().optional(),
    requestId: z.string().trim().optional(),
  })
  .strict();

const leadTouchRecordSchema = z
  .object({
    leadId: z.string().trim().min(1),
    channel: z.enum(['CALL', 'TEXT', 'EMAIL', 'IN_PERSON', 'OTHER']),
    direction: z.enum(['INBOUND', 'OUTBOUND']),
    summary: z.string().trim().min(1),
    outcome: z
      .enum([
        'CONNECTED',
        'LEFT_MESSAGE',
        'NO_ANSWER',
        'BOUNCED',
        'SENT',
        'RECEIVED',
        'OTHER',
      ])
      .optional(),
    relatedCommsThreadId: z.string().trim().optional(),
    requestId: z.string().trim().optional(),
  })
  .strict();

const leadNextActionSetSchema = z
  .object({
    leadId: z.string().trim().min(1),
    task: z
      .object({
        title: z.string().trim().min(1),
        description: z.string().trim().optional(),
        dueAt: z.string().trim().min(1),
        ownerUserId: z.string().trim().optional(),
        priority: z.enum(['LOW', 'NORMAL', 'HIGH']).optional(),
        type: z.enum(['FOLLOW_UP', 'SCHEDULE', 'ESTIMATE', 'DOCS', 'OTHER']).optional(),
      })
      .strict(),
    replaceExisting: z.boolean().optional(),
    requestId: z.string().trim().optional(),
  })
  .strict();

const leadSlaEvaluateSchema = z
  .object({
    leadId: z.string().trim().min(1),
  })
  .strict();

const leadNurtureEnrollSchema = z
  .object({
    leadId: z.string().trim().min(1),
    cadence: z.enum(['WEEKLY', 'BIWEEKLY', 'MONTHLY']),
    channels: z.array(z.enum(['TEXT', 'EMAIL'])).min(1),
    startAt: z.string().trim().optional(),
    notes: z.string().trim().optional(),
    requestId: z.string().trim().optional(),
  })
  .strict();

const quoteSendSchema = z
  .object({
    quoteId: z.string().trim().min(1),
    regenerateToken: z.boolean().optional(),
    expiresInDays: z.number().int().positive().max(60).optional(),
  })
  .strict();

const quoteAcceptSchema = z
  .object({
    quoteToken: z.string().trim().min(1),
    acceptedByName: z.string().trim().min(1),
    notes: z.string().trim().optional(),
    acceptedIpHash: z.string().trim().optional(),
  })
  .strict();

const contractClauseCreateDraftSchema = z
  .object({
    stableId: z.string().trim().min(1),
    version: z.number().int().positive(),
    jurisdiction: z.string().trim().min(1),
    title: z.string().trim().min(1),
    bodyText: z.string(),
    metadata: z.record(z.unknown()).optional(),
    requestId: z.string().trim().optional(),
  })
  .strict();

const contractClauseUpdateDraftSchema = z
  .object({
    stableId: z.string().trim().min(1),
    version: z.number().int().positive(),
    title: z.string().trim().optional(),
    bodyText: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
    requestId: z.string().trim().optional(),
  })
  .strict();

const contractClausePublishSchema = z
  .object({
    stableId: z.string().trim().min(1),
    version: z.number().int().positive(),
    requestId: z.string().trim().optional(),
  })
  .strict();

const contractClauseDeprecateSchema = z
  .object({
    stableId: z.string().trim().min(1),
    version: z.number().int().positive(),
    requestId: z.string().trim().optional(),
    reason: z.string().trim().optional(),
  })
  .strict();

const contractTemplateCreateDraftSchema = z
  .object({
    templateStableId: z.string().trim().min(1),
    version: z.number().int().positive(),
    jurisdiction: z.string().trim().min(1),
    name: z.string().trim().min(1),
    bodyText: z.string().optional(),
    clauseStableIds: z.array(z.string().trim().min(1)).optional(),
    structureJson: z.record(z.unknown()),
    metadata: z.record(z.unknown()).optional(),
    requestId: z.string().trim().optional(),
  })
  .strict();

const contractTemplateUpdateStructureSchema = z
  .object({
    templateStableId: z.string().trim().min(1),
    version: z.number().int().positive(),
    bodyText: z.string().optional(),
    clauseStableIds: z.array(z.string().trim().min(1)).optional(),
    structureJson: z.record(z.unknown()),
    metadata: z.record(z.unknown()).optional(),
    requestId: z.string().trim().optional(),
  })
  .strict();

const contractTemplateUpdateVariableSchemaSchema = z
  .object({
    templateStableId: z.string().trim().min(1),
    version: z.number().int().positive(),
    variableSchemaJson: z.record(z.unknown()),
    requestId: z.string().trim().optional(),
  })
  .strict();

const contractTemplatePublishSchema = z
  .object({
    templateStableId: z.string().trim().min(1),
    version: z.number().int().positive(),
    requestId: z.string().trim().optional(),
  })
  .strict();

const contractLegalPackUpsertSchema = z
  .object({
    packStableId: z.string().trim().min(1),
    jurisdiction: z.string().trim().min(1),
    version: z.string().trim().min(1),
    sourceRepo: z.string().trim().optional(),
    sourceTag: z.string().trim().optional(),
    templateStableIds: z.array(z.string().trim().min(1)).default([]),
    legalPackJson: z.record(z.unknown()),
    metadata: z.record(z.unknown()).optional(),
    requestId: z.string().trim().optional(),
  })
  .strict();

const quoteManifestGenerateSchema = z
  .object({
    quoteId: z.string().trim().min(1),
    optionKey: z.string().trim().optional(),
    requestId: z.string().trim().optional(),
  })
  .strict();

const quoteManifestGetSchema = z
  .object({
    quoteId: z.string().trim().min(1),
  })
  .strict();

const quoteAcceptWithEvidenceSchema = z
  .object({
    quoteId: z.string().trim().min(1),
    acceptedByName: z.string().trim().min(1),
    acceptedAt: z.string().trim().optional(),
    acceptedIpHash: z.string().trim().optional(),
    notes: z.string().trim().optional(),
    evidence: z.record(z.unknown()).optional(),
  })
  .strict();

const contractPreviewFromQuoteSchema = z
  .object({
    quoteId: z.string().trim().min(1),
    optionKey: z.string().trim().optional(),
    includeLineItems: z.boolean().optional(),
  })
  .strict();

const contractDraftCreateFromQuoteSchema = z
  .object({
    quoteId: z.string().trim().min(1),
    templateId: z.string().trim().optional(),
    signerClassification: z.string().trim().optional(),
    requestId: z.string().trim().optional(),
    notes: z.string().trim().optional(),
  })
  .strict();

const contractDraftGeneratePdfSchema = z
  .object({
    quoteId: z.string().trim().min(1),
    draftId: z.string().trim().optional(),
    requestId: z.string().trim().optional(),
  })
  .strict();

const contractSignatureEnvelopeCreateSchema = z
  .object({
    quoteId: z.string().trim().min(1),
    draftId: z.string().trim().optional(),
    recipientName: z.string().trim().optional(),
    recipientEmail: z.string().trim().optional(),
    channel: z.enum(['EMAIL', 'SMS']).optional(),
    requestId: z.string().trim().optional(),
  })
  .strict();

const contractEsignSendSchema = z
  .object({
    quoteId: z.string().trim().min(1),
    envelopeId: z.string().trim().optional(),
    requestId: z.string().trim().optional(),
  })
  .strict();

const contractFinalizeFromQuoteSchema = z
  .object({
    quoteId: z.string().trim().min(1),
    envelopeId: z.string().trim().optional(),
    requestId: z.string().trim().optional(),
    notes: z.string().trim().optional(),
  })
  .strict();

const contractRedlineGenerateSchema = z
  .object({
    quoteId: z.string().trim().optional(),
    baselineText: z.string().optional(),
    proposedText: z.string().optional(),
    requestId: z.string().trim().optional(),
  })
  .strict();

const contractReferencesExtractSchema = z
  .object({
    quoteId: z.string().trim().optional(),
    text: z.string().optional(),
  })
  .strict();

const jobCreateFromQuoteSchema = z
  .object({
    quoteId: z.string().trim().min(1),
    title: z.string().trim().optional(),
    scheduledAt: z.string().trim().optional(),
    addressLine1: z.string().trim().optional(),
    city: z.string().trim().optional(),
    state: z.string().trim().optional(),
    postalCode: z.string().trim().optional(),
  })
  .strict();

const schedulingSettingsUpdateSchema = z
  .object({
    timezone: z.string().trim().min(1).optional(),
    defaultServiceCapacityPerBlock: z.number().int().positive().max(20).optional(),
    defaultInstallCapacityPerBlock: z.number().int().positive().max(20).optional(),
    throttleServiceCapacityPerBlock: z.number().int().positive().max(20).optional(),
    throttleInstallCapacityPerBlock: z.number().int().positive().max(20).optional(),
    throttleServiceEnabled: z.boolean().optional(),
    throttleInstallEnabled: z.boolean().optional(),
    serviceBookingAllowedAt: z.enum(['SENT', 'ACCEPTED']).optional(),
    installBookingAllowedAt: z.enum(['SENT', 'ACCEPTED']).optional(),
  })
  .strict();

const schedulingListAvailabilitySchema = z
  .object({
    type: z.enum(['SERVICE_ESTIMATE', 'INSTALL']),
    startDate: z.string().trim().min(1),
    endDate: z.string().trim().min(1),
  })
  .strict();

const schedulingListForDaySchema = z
  .object({
    date: z.string().trim().min(1),
  })
  .strict();

const schedulingBookFromTokenSchema = z
  .object({
    quoteToken: z.string().trim().min(1),
    date: z.string().trim().min(1),
    timeBlockCode: z.enum([
      'BLOCK_0800_1000',
      'BLOCK_1000_1200',
      'BLOCK_1200_1400',
      'BLOCK_1400_1600',
    ]),
    type: z.enum(['SERVICE_ESTIMATE', 'INSTALL']).optional(),
    notes: z.string().trim().optional(),
  })
  .strict();

const appointmentRescheduleSchema = z
  .object({
    appointmentId: z.string().trim().min(1),
    date: z.string().trim().min(1),
    timeBlockCode: z.enum([
      'BLOCK_0800_1000',
      'BLOCK_1000_1200',
      'BLOCK_1200_1400',
      'BLOCK_1400_1600',
    ]),
    notes: z.string().trim().optional(),
  })
  .strict();

const appointmentCancelSchema = z
  .object({
    appointmentId: z.string().trim().min(1),
    reason: z.string().trim().optional(),
  })
  .strict();

const appointmentAssignTechSchema = z
  .object({
    appointmentId: z.string().trim().min(1),
    techUserId: z.string().trim().min(1),
  })
  .strict();

const timeClockInSchema = z
  .object({
    startedAtLocal: z.string().trim().optional(),
    timezoneOffsetMinutes: z.number().int().optional(),
    notes: z.string().trim().optional(),
  })
  .strict();

const timeClockOutSchema = z
  .object({
    endedAtLocal: z.string().trim().optional(),
    timezoneOffsetMinutes: z.number().int().optional(),
    notes: z.string().trim().optional(),
  })
  .strict();

const timeBreakStartSchema = z
  .object({
    startedAtLocal: z.string().trim().optional(),
    timezoneOffsetMinutes: z.number().int().optional(),
    notes: z.string().trim().optional(),
  })
  .strict();

const timeBreakEndSchema = z
  .object({
    endedAtLocal: z.string().trim().optional(),
    timezoneOffsetMinutes: z.number().int().optional(),
    notes: z.string().trim().optional(),
  })
  .strict();

const timeJobStartSchema = z
  .object({
    jobId: z.string().trim().min(1),
    startedAtLocal: z.string().trim().optional(),
    timezoneOffsetMinutes: z.number().int().optional(),
    notes: z.string().trim().optional(),
  })
  .strict();

const timeJobStopSchema = z
  .object({
    jobId: z.string().trim().optional(),
    endedAtLocal: z.string().trim().optional(),
    timezoneOffsetMinutes: z.number().int().optional(),
    notes: z.string().trim().optional(),
  })
  .strict();

const timeEditRequestSchema = z
  .object({
    timeEntryId: z.string().trim().min(1),
    requestedChanges: z
      .object({
        startedAt: z.string().trim().optional(),
        endedAt: z.string().trim().optional(),
        startedAtLocal: z.string().trim().optional(),
        endedAtLocal: z.string().trim().optional(),
        timezoneOffsetMinutes: z.number().int().optional(),
        notes: z.string().trim().optional(),
      })
      .strict(),
    reason: z.string().trim().min(3),
  })
  .strict();

const timeEditReviewSchema = z
  .object({
    timeEditRequestId: z.string().trim().min(1),
    decision: z.enum(['APPROVE', 'REJECT']),
    reviewNote: z.string().trim().optional(),
  })
  .strict();

const mobilePinSetSchema = z
  .object({
    userId: z.string().trim().min(1),
    newPin: z.string().trim().regex(/^\d{4,6}$/),
  })
  .strict();

const mobilePinResetSchema = z
  .object({
    userId: z.string().trim().min(1),
    temporaryPin: z.string().trim().regex(/^\d{4,6}$/).optional(),
  })
  .strict();

const mobilePinLoginSchema = z
  .object({
    orgSlug: z.string().trim().min(1),
    identifier: z.string().trim().min(1),
    pin: z.string().trim().regex(/^\d{4,6}$/),
    deviceId: z.string().trim().min(1).max(128),
    deviceName: z.string().trim().optional(),
  })
  .strict();

const mediaPhotoUploadSchema = z
  .object({
    attachmentId: z.string().trim().min(1),
    ownerType: z.enum(['QUOTE', 'JOB']),
    ownerId: z.string().trim().min(1),
    tag: z.enum(['BEFORE', 'AFTER', 'EQUIPMENT_PLATE', 'RECEIPT', 'PROBLEM', 'INSTALL', 'OTHER']),
    caption: z.string().trim().optional(),
    kind: z.enum(['QUOTE_PHOTO', 'JOB_PHOTO']),
    fileName: z.string().trim().min(1),
    bucket: z.string().trim().min(1),
    objectKey: z.string().trim().min(1),
    displayObjectKey: z.string().trim().min(1),
    thumbObjectKey: z.string().trim().min(1),
    mimeType: z.string().trim().min(1),
    sizeBytes: z.number().int().positive(),
    checksumSha256: z.string().trim().min(1),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  })
  .strict();

const mediaUploadSessionStartSchema = z
  .object({
    sessionKey: z.string().trim().min(8).max(128),
    ownerType: z.enum(['QUOTE', 'JOB']),
    ownerId: z.string().trim().min(1),
    tag: z.enum(['BEFORE', 'AFTER', 'EQUIPMENT_PLATE', 'RECEIPT', 'PROBLEM', 'INSTALL', 'OTHER']).optional(),
    caption: z.string().trim().optional(),
    fileName: z.string().trim().min(1),
    mimeType: z.string().trim().min(1),
    sizeBytes: z.number().int().positive().optional(),
    checksumSha256: z.string().trim().min(1).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

const mediaUploadSessionCompleteSchema = z
  .object({
    sessionKey: z.string().trim().min(8).max(128),
    attachmentId: z.string().trim().min(1).optional(),
    bucket: z.string().trim().min(1),
    objectKey: z.string().trim().min(1),
    displayObjectKey: z.string().trim().min(1),
    thumbObjectKey: z.string().trim().min(1),
    fileName: z.string().trim().min(1),
    mimeType: z.string().trim().min(1),
    sizeBytes: z.number().int().positive(),
    checksumSha256: z.string().trim().min(1),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  })
  .strict();

const mediaUploadSessionFailSchema = z
  .object({
    sessionKey: z.string().trim().min(8).max(128),
    errorMessage: z.string().trim().min(1).max(500),
  })
  .strict();

const mediaListSchema = z
  .object({
    ownerType: z.enum(['QUOTE', 'JOB']),
    ownerId: z.string().trim().min(1),
    includeDeleted: z.boolean().optional(),
  })
  .strict();

const mediaSetPublicSchema = z
  .object({
    attachmentId: z.string().trim().min(1),
    isPublic: z.boolean(),
  })
  .strict();

const mediaDeleteSchema = z
  .object({
    attachmentId: z.string().trim().min(1),
    reason: z.string().trim().optional(),
  })
  .strict();

const mediaPurgeExpiredSchema = z
  .object({
    limit: z.number().int().positive().max(1000).optional(),
  })
  .strict();

const commsSyncSchema = z
  .object({
    accountId: z.string().trim().optional(),
    externalAccountId: z.string().trim().optional(),
    displayName: z.string().trim().optional(),
    fullSync: z.boolean().optional(),
    batchSize: z.number().int().positive().max(5000).optional(),
    cursor: z.record(z.unknown()).optional(),
  })
  .strict();

const commsThreadLinkSchema = z
  .object({
    threadId: z.string().trim().min(1),
    entityType: z.enum(['CUSTOMER', 'LEAD', 'JOB', 'QUOTE']).optional(),
    entityId: z.string().trim().optional(),
    confidence: z.number().min(0).max(1).optional(),
    reason: z.string().trim().optional(),
  })
  .strict();

const commsDraftCreateSchema = z
  .object({
    threadId: z.string().trim().min(1),
    channel: z.enum(['IMESSAGE', 'SMS', 'EMAIL']),
    to: z.array(z.record(z.unknown())).min(1),
    subject: z.string().trim().optional(),
    bodyText: z.string().trim().min(1),
    bodyHtml: z.string().trim().optional(),
  })
  .strict();

const commsDraftApproveSendSchema = z
  .object({
    draftId: z.string().trim().min(1),
    requestId: z.string().trim().optional(),
  })
  .strict();

const commsDraftUpdateSchema = z
  .object({
    draftId: z.string().trim().min(1),
    subject: z.string().trim().optional(),
    bodyText: z.string().trim().min(1),
    bodyHtml: z.string().trim().optional(),
  })
  .strict();

const commsMessageMarkTriagedSchema = z
  .object({
    messageId: z.string().trim().min(1),
  })
  .strict();

const equipmentCatalogImportSchema = z.object({
  sourceName: z.string().trim().min(1),
  csvContent: z.string().min(1),
  attachmentRefId: z.string().trim().optional(),
  mapping: z
    .object({
      skuColumn: z.string().trim().optional(),
      manufacturerColumn: z.string().trim().optional(),
      systemTypeColumn: z.string().trim().optional(),
      textColumns: z.array(z.string().trim().min(1)).max(40).optional(),
    })
    .strict()
    .optional(),
  metadata: z.record(z.unknown()).optional(),
});

const equipmentLookupSchema = z.object({
  query: z.string().trim().min(1),
  manufacturer: z.string().trim().optional(),
  systemType: z.string().trim().optional(),
  limit: z.number().int().positive().max(25).optional(),
});

const equipmentSpecSelectSchema = z.object({
  assessmentId: z.string().trim().min(1),
  query: z.string().trim().optional(),
  selected: z
    .object({
      entryId: z.string().trim().optional(),
      manufacturer: z.string().trim().optional(),
      model: z.string().trim().optional(),
      systemType: z.string().trim().optional(),
      tonnage: z.number().nullable().optional(),
      btu: z.number().nullable().optional(),
      seer: z.number().nullable().optional(),
      afue: z.number().nullable().optional(),
      stages: z.number().int().nullable().optional(),
      refrigerant: z.string().trim().nullable().optional(),
      confidence: z.number().min(0).max(1).optional(),
      evidence: z.record(z.unknown()).optional(),
    })
    .strict()
    .optional(),
  selectedEntryId: z.string().trim().optional(),
  selectedCandidateIndex: z.number().int().nonnegative().optional(),
  results: z.array(z.record(z.unknown())).optional(),
});

const assessmentCreateSchema = z.object({
  existingManufacturer: z.string().trim().optional(),
  existingModel: z.string().trim().optional(),
  existingSystemType: z.string().trim().optional(),
  existingTonnage: z.number().optional(),
  existingFurnaceBtu: z.number().int().optional(),
  existingSeer: z.number().optional(),
  existingAfue: z.number().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const assessmentAttachmentAddSchema = z.object({
  assessmentId: z.string().trim().min(1),
  attachmentRefId: z.string().trim().min(1),
  kind: z.enum(['NAMEPLATE_PHOTO']).optional(),
});

const assessmentUpdateSchema = z.object({
  assessmentId: z.string().trim().min(1),
  existingManufacturer: z.string().trim().optional(),
  existingModel: z.string().trim().optional(),
  existingSystemType: z.string().trim().optional(),
  existingTonnage: z.number().nullable().optional(),
  existingFurnaceBtu: z.number().int().nullable().optional(),
  existingSeer: z.number().nullable().optional(),
  existingAfue: z.number().nullable().optional(),
  verifiedBySupplyHouse: z.boolean().optional(),
  supplyHouseNotes: z.string().trim().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const equipmentOptionsGenerateSchema = z.object({
  assessmentId: z.string().trim().min(1),
  addOns: z.array(z.string().trim().min(1)).optional(),
});

const installTypeSchema = z.enum(['COMBO', 'FURNACE_ONLY', 'AC_ONLY']);

const installAccessTypeSchema = z.enum([
  'STANDARD',
  'ATTIC',
  'CONFINED_CRAWLSPACE',
]);

const assessmentInstallPricingInputsSchema = z.object({
  assessmentId: z.string().trim().min(1),
  installType: installTypeSchema,
  accessType: installAccessTypeSchema,
  baseLaborCostCents: z.number().int().nonnegative(),
  manualLaborAdjustmentCents: z.number().int(),
  manualLaborReason: z.string().trim().optional(),
  permitCostCents: z.number().int().nonnegative().optional(),
});

const quoteSelectionSkuSchema = z.object({
  sku: z.string().trim().optional(),
  label: z.string().trim().optional(),
  costCents: z.number().int().nonnegative(),
});

const quoteTierSelectionSchema = z.object({
  equipment: z.array(quoteSelectionSkuSchema).default([]),
  materials: z.array(quoteSelectionSkuSchema).default([]),
});

const quoteGenerateInstallOptionsSchema = z.object({
  leadId: z.string().trim().min(1),
  assessmentId: z.string().trim().min(1),
  tierSelections: z
    .object({
      GOOD: quoteTierSelectionSchema,
      BETTER: quoteTierSelectionSchema,
      BEST: quoteTierSelectionSchema,
    })
    .strict(),
});

const quoteApplyDiscountSchema = z
  .object({
    quoteOptionId: z.string().trim().min(1),
    discountPctBps: z.number().int().min(0).max(10_000).optional(),
    discountCents: z.number().int().min(0).optional(),
    reason: z.string().trim().optional(),
  })
  .strict();

const pricingOverrideBlockSchema = z
  .object({
    quoteOptionId: z.string().trim().min(1),
    reason: z.string().trim().min(1),
  })
  .strict();

const serviceTimingSchema = z.enum(['NORMAL', 'AFTER_HOURS']);

const serviceQuoteCreateFromBundleSchema = z
  .object({
    leadId: z.string().trim().min(1),
    customerId: z.string().trim().optional(),
    bundleTemplateId: z.string().trim().min(1),
    timing: serviceTimingSchema,
  })
  .strict();

const serviceQuoteAddLineItemSchema = z
  .object({
    quoteId: z.string().trim().min(1),
    pricebookItemId: z.string().trim().optional(),
    custom: z
      .object({
        name: z.string().trim().min(1),
        description: z.string().trim().optional(),
        unitPriceCents: z.number().int(),
        categorySlug: z.string().trim().optional(),
        kindSnapshot: z.string().trim().optional(),
        meta: z.record(z.unknown()).optional(),
      })
      .strict()
      .optional(),
    qty: z.number().int().positive().optional(),
    sortOrder: z.number().int().optional(),
  })
  .strict();

const serviceQuoteRemoveLineItemSchema = z
  .object({
    quoteLineItemId: z.string().trim().min(1),
  })
  .strict();

const serviceQuoteSetLaborHoursSchema = z
  .object({
    quoteId: z.string().trim().min(1),
    laborHours: z.number().min(0),
  })
  .strict();

const serviceQuoteSetTimingSchema = z
  .object({
    quoteId: z.string().trim().min(1),
    timing: serviceTimingSchema,
  })
  .strict();

const serviceQuoteApplyDiscountSchema = z
  .object({
    quoteId: z.string().trim().min(1),
    discountPctBps: z.number().int().min(0).max(10_000).optional(),
    discountCents: z.number().int().min(0).optional(),
    reason: z.string().trim().optional(),
  })
  .strict();

const servicePricingOverrideBlockSchema = z
  .object({
    quoteId: z.string().trim().min(1).optional(),
    quoteOptionId: z.string().trim().min(1).optional(),
    reason: z.string().trim().min(1),
  })
  .strict();

const adminBundleTemplateUpsertSchema = z
  .object({
    id: z.string().trim().optional(),
    name: z.string().trim().min(1),
    active: z.boolean().optional(),
    includeDiagnostic: z.boolean().optional(),
    defaultLaborHours: z.number().min(0).optional(),
    baseItemIds: z.array(z.string().trim().min(1)).optional(),
    recommendedAddOnItemIds: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();

const adminPricebookCategoryUpsertSchema = z
  .object({
    id: z.string().trim().optional(),
    name: z.string().trim().min(1),
    slug: z.string().trim().min(1),
  })
  .strict();

const adminPricebookItemUpsertSchema = z
  .object({
    id: z.string().trim().optional(),
    categoryId: z.string().trim().min(1),
    kind: z.enum(['SERVICE', 'ADDON', 'FEE']),
    name: z.string().trim().min(1),
    description: z.string().trim().optional(),
    unitType: z.string().trim().optional(),
    defaultSellCents: z.number().int().nonnegative(),
    active: z.boolean().optional(),
    tags: z.array(z.string().trim()).optional(),
  })
  .strict();

function patchStateJson(
  stateJson: Prisma.JsonValue | null | undefined,
  patch: Record<string, unknown>,
): Prisma.InputJsonValue {
  return {
    ...jsonObject(stateJson),
    ...patch,
  } as Prisma.InputJsonValue;
}

type HandlerDecisionDirectiveInput = {
  status: 'BLOCKED' | 'QUEUED_APPROVAL';
  reason: string;
  requiredApprovals?: number;
  decision?: Record<string, unknown>;
  approvalPayload?: Record<string, unknown>;
  output?: Prisma.JsonValue;
};

function handlerGovernanceDirective(
  input: HandlerDecisionDirectiveInput,
): Prisma.JsonValue {
  const envelope: Record<string, unknown> = {
    __registryDecision: {
      status: input.status,
      reason: input.reason,
      ...(input.requiredApprovals !== undefined
        ? { requiredApprovals: input.requiredApprovals }
        : {}),
      ...(input.decision ? { decision: input.decision } : {}),
      ...(input.approvalPayload ? { approvalPayload: input.approvalPayload } : {}),
    },
  };

  if (input.output !== undefined) {
    envelope.output = input.output;
  }

  return jsonResult(envelope);
}

function toGraphStateSummary(
  stateJson: Prisma.JsonValue | null | undefined,
): AgentGraphStateSummary {
  const state = jsonObject(stateJson);

  return {
    goal: typeof state.goal === 'string' ? state.goal : '',
    contextBuilt: state.contextBuilt === true,
    leadsQualified: state.leadsQualified === true,
    followupsDrafted: state.followupsDrafted === true,
    communicationsRequested: state.communicationsRequested === true,
    jobsScheduled: state.jobsScheduled === true,
    billingRequested: state.billingRequested === true,
    reportFinalized: state.reportFinalized === true,
    pendingApproval: state.pendingApproval === true,
  };
}

type EquipmentCatalogEntryRow = {
  id: string;
  rawSku: string;
  rawText: string;
  manufacturer: string | null;
  systemTypeHint: string | null;
  rawJson: Prisma.JsonValue;
  fuzzyScore: number;
};

type EquipmentLookupCandidate = {
  entryId: string;
  manufacturer: string | null;
  model: string;
  systemType: string | null;
  tonnage: number | null;
  btu: number | null;
  seer: number | null;
  afue: number | null;
  stages: number | null;
  refrigerant: string | null;
  confidence: number;
  evidence: Record<string, unknown>;
};

function normalizeLookupKey(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function buildStringLookup(
  value: Prisma.JsonValue | null | undefined,
): Record<string, string> {
  const input = jsonObject(value);
  const lookup: Record<string, string> = {};
  for (const [key, raw] of Object.entries(input)) {
    const normalizedKey = normalizeLookupKey(key);
    if (!normalizedKey) {
      continue;
    }
    if (typeof raw === 'string') {
      lookup[normalizedKey] = raw.trim();
      continue;
    }
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      lookup[normalizedKey] = String(raw);
      continue;
    }
    if (typeof raw === 'boolean') {
      lookup[normalizedKey] = raw ? 'true' : 'false';
    }
  }
  return lookup;
}

function pickLookupString(
  lookup: Record<string, string>,
  candidates: string[],
): string | null {
  for (const candidate of candidates) {
    const normalized = normalizeLookupKey(candidate);
    const value = lookup[normalized];
    if (value && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function parseNumberFromLookup(
  lookup: Record<string, string>,
  candidates: string[],
): number | null {
  const value = pickLookupString(lookup, candidates);
  if (!value) {
    return null;
  }
  return toNumberOrNull(value);
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}

function toLookupCandidate(entry: EquipmentCatalogEntryRow): EquipmentLookupCandidate {
  const rowLookup = buildStringLookup(entry.rawJson);
  const manufacturer =
    toStringOrNull(entry.manufacturer) ??
    pickLookupString(rowLookup, ['manufacturer', 'brand', 'make']);
  const model =
    pickLookupString(rowLookup, ['model', 'sku', 'item_number', 'item number']) ??
    toStringOrNull(entry.rawSku) ??
    normalizeModel(entry.rawText);
  const systemType =
    toStringOrNull(entry.systemTypeHint) ??
    pickLookupString(rowLookup, ['system_type', 'system type', 'equipment type', 'category', 'type']);

  const explicitTonnage = parseNumberFromLookup(rowLookup, [
    'tonnage',
    'tons',
    'capacity_tons',
    'capacitytons',
  ]);
  const explicitBtu = parseNumberFromLookup(rowLookup, [
    'btu',
    'input_btu',
    'inputbtu',
    'capacity_btu',
    'capacitybtu',
  ]);
  const explicitSeer = parseNumberFromLookup(rowLookup, ['seer', 'seer2']);
  const explicitAfue = parseNumberFromLookup(rowLookup, ['afue']);
  const explicitStages = parseNumberFromLookup(rowLookup, ['stages', 'stage']);
  const explicitRefrigerant = pickLookupString(rowLookup, ['refrigerant', 'ref']);

  const decode = decodeCapacityFromModel(`${model} ${entry.rawSku} ${entry.rawText}`, {
    manufacturer,
  });

  const tonnage = explicitTonnage ?? decode.tonnage ?? null;
  const btu = explicitBtu === null ? decode.btu ?? null : Math.round(explicitBtu);
  const seer = explicitSeer;
  const afue = explicitAfue;
  const stages = explicitStages === null ? null : Math.round(explicitStages);
  const refrigerant = explicitRefrigerant;
  const hasExplicitSpec =
    explicitTonnage !== null ||
    explicitBtu !== null ||
    explicitSeer !== null ||
    explicitAfue !== null;

  let confidence = hasExplicitSpec ? 0.9 : decode.confidence;
  if (
    explicitTonnage !== null &&
    decode.tonnage !== undefined &&
    Math.abs(explicitTonnage - decode.tonnage) > 0.01
  ) {
    confidence -= 0.15;
  }
  if (explicitBtu !== null && decode.btu !== undefined && Math.round(explicitBtu) !== decode.btu) {
    confidence -= 0.15;
  }

  confidence = clampConfidence(confidence + Math.min(0.1, Math.max(0, entry.fuzzyScore)));

  return {
    entryId: entry.id,
    manufacturer,
    model,
    systemType,
    tonnage,
    btu,
    seer,
    afue,
    stages,
    refrigerant,
    confidence,
    evidence: {
      source: hasExplicitSpec ? 'csv-explicit+decoder' : 'decoder',
      fuzzyScore: entry.fuzzyScore,
      rawSku: entry.rawSku,
      decode: decode.evidence,
    },
  };
}

const EQUIPMENT_ADD_ON_CATALOG: Record<string, { label: string; priceCents: number }> = {
  humidifier: { label: 'Humidifier', priceCents: 75_000 },
  wet_switch: { label: 'Wet Switch', priceCents: 12_000 },
  uv: { label: 'UV Treatment', priceCents: 35_000 },
  electronic_filter: { label: 'Electronic Filter', priceCents: 18_000 },
  co_detectors: { label: 'CO Detectors', priceCents: 9_000 },
};

function toPriceCentsFromEntry(entry: EquipmentCatalogEntryRow): number | null {
  const lookup = buildStringLookup(entry.rawJson);
  const centsValue = parseNumberFromLookup(lookup, [
    'pricecents',
    'unitpricecents',
    'costcents',
    'amountcents',
  ]);
  if (centsValue !== null) {
    return Math.max(0, Math.round(centsValue));
  }

  const dollarsValue = parseNumberFromLookup(lookup, [
    'price',
    'unitprice',
    'cost',
    'amount',
  ]);
  if (dollarsValue !== null) {
    return Math.max(0, Math.round(dollarsValue * 100));
  }

  return null;
}

function buildCoreHandlers(prisma: PrismaClient): HandlerMap {
  const reportingContextBuild: ToolHandler = async ({ context }) => {
    const [leadCount, openJobs, draftInvoices] = await Promise.all([
      prisma.lead.count({ where: { orgId: context.orgId } }),
      prisma.job.count({ where: { orgId: context.orgId, status: 'OPEN' } }),
      prisma.invoice.count({ where: { orgId: context.orgId, status: 'DRAFT' } }),
    ]);

    return jsonResult({
      leadCount,
      openJobs,
      draftInvoices,
      generatedAt: new Date().toISOString(),
    });
  };

  const resolveActorUserId = async (
    orgId: string,
    actorUserId?: string,
  ): Promise<string> => {
    if (actorUserId) {
      return actorUserId;
    }

    const fallback = await prisma.user.findFirst({
      where: {
        orgId,
        actorType: ActorType.HUMAN,
        isActive: true,
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });

    if (!fallback) {
      throw new Error('No active user available for attribution');
    }
    return fallback.id;
  };

  const matchesPermission = (granted: string, required: string): boolean => {
    if (granted === '*' || granted === required) {
      return true;
    }
    if (granted.endsWith('*')) {
      return required.startsWith(granted.slice(0, -1));
    }
    return false;
  };

  const resolveActorAccess = async (context: {
    orgId: string;
    actorUserId?: string;
  }): Promise<{ permissions: Set<string>; roles: Set<string> }> => {
    if (!context.actorUserId) {
      return {
        permissions: new Set<string>(),
        roles: new Set<string>(),
      };
    }

    const userRoles = await prisma.userRole.findMany({
      where: {
        userId: context.actorUserId,
      },
      include: {
        role: {
          include: {
            rolePermissions: {
              include: {
                permission: true,
              },
            },
          },
        },
      },
    });

    const roles = new Set<string>();
    const permissions = new Set<string>();
    for (const link of userRoles) {
      roles.add(link.role.name.toLowerCase());
      for (const rolePermission of link.role.rolePermissions) {
        permissions.add(rolePermission.permission.key);
      }
    }

    return { permissions, roles };
  };

  const DEFAULT_TIME_BLOCKS: Array<{
    code: TimeBlockCode;
    startTime: string;
    endTime: string;
  }> = [
    {
      code: TimeBlockCode.BLOCK_0800_1000,
      startTime: '08:00',
      endTime: '10:00',
    },
    {
      code: TimeBlockCode.BLOCK_1000_1200,
      startTime: '10:00',
      endTime: '12:00',
    },
    {
      code: TimeBlockCode.BLOCK_1200_1400,
      startTime: '12:00',
      endTime: '14:00',
    },
    {
      code: TimeBlockCode.BLOCK_1400_1600,
      startTime: '14:00',
      endTime: '16:00',
    },
  ];

  const parseDateOnly = (value: string): Date => {
    const trimmed = value.trim();
    const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
      throw new Error(`Invalid date format: ${value}. Expected YYYY-MM-DD`);
    }
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month, day));
    if (Number.isNaN(date.getTime())) {
      throw new Error(`Invalid date value: ${value}`);
    }
    return date;
  };

  const toDateKey = (date: Date): string => {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const listDateRange = (start: Date, end: Date): Date[] => {
    const out: Date[] = [];
    const cursor = new Date(start.getTime());
    while (cursor.getTime() <= end.getTime()) {
      out.push(new Date(cursor.getTime()));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return out;
  };

  const appointmentTypeForQuoteKind = (kind: QuoteKind): AppointmentType =>
    kind === QuoteKind.INSTALL
      ? AppointmentType.INSTALL
      : AppointmentType.SERVICE_ESTIMATE;

  const bookingTriggerForQuoteKind = (
    settings: {
      serviceBookingAllowedAt: QuoteBookingTriggerStatus;
      installBookingAllowedAt: QuoteBookingTriggerStatus;
    },
    kind: QuoteKind,
  ): QuoteBookingTriggerStatus =>
    kind === QuoteKind.INSTALL
      ? settings.installBookingAllowedAt
      : settings.serviceBookingAllowedAt;

  const resolveCapacity = (
    settings: {
      defaultServiceCapacityPerBlock: number;
      defaultInstallCapacityPerBlock: number;
      throttleServiceCapacityPerBlock: number;
      throttleInstallCapacityPerBlock: number;
      throttleServiceEnabled: boolean;
      throttleInstallEnabled: boolean;
    },
    type: AppointmentType,
  ): number => {
    if (type === AppointmentType.INSTALL) {
      return settings.throttleInstallEnabled
        ? settings.throttleInstallCapacityPerBlock
        : settings.defaultInstallCapacityPerBlock;
    }

    return settings.throttleServiceEnabled
      ? settings.throttleServiceCapacityPerBlock
      : settings.defaultServiceCapacityPerBlock;
  };

  const toScheduledAtForBlock = (date: Date, blockStartTime: string): Date => {
    const [hourRaw, minuteRaw] = blockStartTime.split(':');
    const hour = Number(hourRaw ?? '0');
    const minute = Number(minuteRaw ?? '0');
    return new Date(
      Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
        Number.isFinite(hour) ? hour : 0,
        Number.isFinite(minute) ? minute : 0,
      ),
    );
  };

  const ensureSchedulingBootstrap = async (orgId: string) => {
    const settings = await prisma.orgSchedulingSettings.upsert({
      where: { orgId },
      update: {},
      create: {
        orgId,
        timezone: 'America/Denver',
      },
    });

    await prisma.timeBlockTemplate.createMany({
      data: DEFAULT_TIME_BLOCKS.map((block) => ({
        orgId,
        code: block.code,
        startTime: block.startTime,
        endTime: block.endTime,
        active: true,
      })),
      skipDuplicates: true,
    });

    const defaultHours = [
      { dayOfWeek: 0, openTime: '00:00', closeTime: '00:00', isClosed: true },
      { dayOfWeek: 1, openTime: '08:00', closeTime: '16:00', isClosed: false },
      { dayOfWeek: 2, openTime: '08:00', closeTime: '16:00', isClosed: false },
      { dayOfWeek: 3, openTime: '08:00', closeTime: '16:00', isClosed: false },
      { dayOfWeek: 4, openTime: '08:00', closeTime: '16:00', isClosed: false },
      { dayOfWeek: 5, openTime: '08:00', closeTime: '16:00', isClosed: false },
      { dayOfWeek: 6, openTime: '00:00', closeTime: '00:00', isClosed: true },
    ];

    await prisma.businessHours.createMany({
      data: defaultHours.map((row) => ({
        orgId,
        dayOfWeek: row.dayOfWeek,
        openTime: row.openTime,
        closeTime: row.closeTime,
        isClosed: row.isClosed,
      })),
      skipDuplicates: true,
    });

    return settings;
  };

  const buildBookingValidationError = (
    trigger: QuoteBookingTriggerStatus,
    quoteStatus: string,
    quoteKind: QuoteKind,
  ): string =>
    `Booking requires quote status ${trigger} for ${quoteKind} quotes (current status: ${quoteStatus}).`;

  const isQuoteStatusEligibleForBooking = (
    status: string,
    trigger: QuoteBookingTriggerStatus,
  ): boolean => {
    const normalized = status.trim().toUpperCase();
    if (trigger === QuoteBookingTriggerStatus.ACCEPTED) {
      return normalized === 'ACCEPTED';
    }
    return normalized === 'SENT' || normalized === 'ACCEPTED';
  };

  const actorHasPermission = (
    permissions: Set<string>,
    required: string,
  ): boolean => {
    for (const granted of permissions) {
      if (matchesPermission(granted, required)) {
        return true;
      }
    }
    return false;
  };

  const resolveDiscountTier = (
    roles: Set<string>,
  ): 'OWNER' | 'MANAGER' | 'SALES' => {
    if (roles.has('owner') || roles.has('admin')) {
      return 'OWNER';
    }
    if ([...roles].some((role) => role.includes('manager'))) {
      return 'MANAGER';
    }
    return 'SALES';
  };

  const discountLimitForTier = (
    tier: 'OWNER' | 'MANAGER' | 'SALES',
    priceBeforeDiscountCents: number,
  ): number => {
    if (tier === 'OWNER') {
      return Number.POSITIVE_INFINITY;
    }
    if (tier === 'MANAGER') {
      return Math.max(Math.round(priceBeforeDiscountCents * 0.15), 100_000);
    }
    return Math.max(Math.round(priceBeforeDiscountCents * 0.05), 25_000);
  };

  const normalizeSlug = (value: string | null | undefined): string =>
    (value ?? '').trim().toLowerCase();

  const extractStringArray = (
    value: Prisma.JsonValue | null | undefined,
  ): string[] => {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry.length > 0);
  };

  const isServiceDiagnosticCreditMeta = (
    meta: Prisma.JsonValue | null | undefined,
  ): boolean => jsonObject(meta).isDiagnosticCredit === true;

  const resolveDiagnosticPricebookItem = async (
    tx: Prisma.TransactionClient,
    orgId: string,
  ) => {
    return tx.pricebookItem.findFirst({
      where: {
        orgId,
        active: true,
        kind: PricebookItemKind.FEE,
        name: { contains: 'diagnostic', mode: 'insensitive' },
      },
      include: {
        category: true,
      },
      orderBy: [{ createdAt: 'asc' }],
    });
  };

  const resolveServiceQuoteContext = async (
    tx: Prisma.TransactionClient,
    orgId: string,
    quoteId: string,
  ) => {
    const quote = await tx.quote.findFirst({
      where: {
        id: quoteId,
        orgId,
      },
    });
    if (!quote) {
      throw new Error('Service quote not found');
    }
    if (quote.kind !== QuoteKind.SERVICE) {
      throw new Error('Quote is not a service quote');
    }

    const lineItems = await tx.quoteLineItem.findMany({
      where: {
        orgId,
        quoteId: quote.id,
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    return { quote, lineItems };
  };

  const persistServiceQuoteComputedState = async (args: {
    tx: Prisma.TransactionClient;
    quote: Prisma.QuoteGetPayload<Record<string, never>>;
    lineItems: Prisma.QuoteLineItemGetPayload<Record<string, never>>[];
    discountPctBps?: number;
    discountCents?: number;
  }) => {
    const quoteMeta = jsonObject(args.quote.metadata);
    const servicePricingMeta = jsonObject(quoteMeta.servicePricing as Prisma.JsonValue);
    const diagnosticItemId = toStringOrNull(servicePricingMeta.diagnosticItemId);

    const nonCreditLines = args.lineItems.filter(
      (line) => !isServiceDiagnosticCreditMeta(line.meta),
    );

    const computed = computeServiceQuoteTotals({
      timing: args.quote.timing as ServiceTiming,
      isMember: args.quote.isMember,
      laborHours: args.quote.laborHours,
      discountPctBps: args.discountPctBps ?? args.quote.discountPctBps,
      discountCents: args.discountCents ?? args.quote.discountCents,
      diagnosticItemId,
      repairCategorySlug: 'repair',
      maintenanceCategorySlug: 'maintenance',
      lineItems: nonCreditLines.map((line) => ({
        id: line.id,
        itemType: line.itemType as 'PRICEBOOK_ITEM' | 'CUSTOM',
        pricebookItemId: line.pricebookItemId,
        categorySlugSnapshot: line.categorySlugSnapshot,
        kindSnapshot: line.kindSnapshot,
        nameSnapshot: line.nameSnapshot,
        descriptionSnapshot: line.descriptionSnapshot,
        qty: line.qty,
        unitPriceCents: line.unitPriceCents,
        lineTotalCents: line.lineTotalCents,
        sortOrder: line.sortOrder,
        meta: jsonObject(line.meta),
      })),
    });

    const existingCreditIds = args.lineItems
      .filter((line) => isServiceDiagnosticCreditMeta(line.meta))
      .map((line) => line.id);
    if (existingCreditIds.length > 0) {
      await args.tx.quoteLineItem.deleteMany({
        where: {
          id: { in: existingCreditIds },
        },
      });
    }

    const desiredCredit = computed.correctedLineItems.find(
      (line) => jsonObject(line.meta as Prisma.JsonValue).isDiagnosticCredit === true,
    );
    if (desiredCredit) {
      await args.tx.quoteLineItem.create({
        data: {
          orgId: args.quote.orgId,
          quoteId: args.quote.id,
          itemType: QuoteLineItemType.CUSTOM,
          pricebookItemId: null,
          categorySlugSnapshot: desiredCredit.categorySlugSnapshot ?? null,
          kindSnapshot: desiredCredit.kindSnapshot ?? null,
          nameSnapshot: desiredCredit.nameSnapshot,
          descriptionSnapshot: desiredCredit.descriptionSnapshot ?? null,
          qty: Math.max(1, Math.trunc(desiredCredit.qty)),
          unitPriceCents: Math.round(desiredCredit.unitPriceCents),
          lineTotalCents: Math.round(
            desiredCredit.lineTotalCents ??
              desiredCredit.unitPriceCents * desiredCredit.qty,
          ),
          sortOrder: typeof desiredCredit.sortOrder === 'number' ? desiredCredit.sortOrder : 0,
          meta: toInputJson({
            ...(jsonObject(desiredCredit.meta as Prisma.JsonValue) ?? {}),
            isDiagnosticCredit: true,
          }),
        },
      });
    }

    const updatedQuote = await args.tx.quote.update({
      where: { id: args.quote.id },
      data: {
        laborHoursRounded: computed.laborHoursRounded,
        laborRateCents: computed.laborRateCents,
        laborTotalCents: computed.laborTotalCents,
        subtotalCents: computed.subtotalCents,
        diagnosticFeeCents: computed.diagnosticFeeCents,
        repairSubtotalCents: computed.repairSubtotalCents,
        diagnosticCreditCents: computed.diagnosticCreditCents,
        totalBeforeDiscountCents: computed.totalBeforeDiscountCents,
        discountPctBps: computed.discountPctBps,
        discountCents: computed.discountCents,
        discountTotalCents: computed.discountTotalCents,
        finalTotalCents: computed.finalTotalCents,
        guardrailStatus:
          computed.guardrailStatus === 'BLOCK'
            ? GuardrailStatus.BLOCK
            : GuardrailStatus.OK,
        guardrailReasons: toInputJson(computed.guardrailReasons),
        totalCents: computed.finalTotalCents,
      },
    });

    const refreshedLineItems = await args.tx.quoteLineItem.findMany({
      where: {
        orgId: args.quote.orgId,
        quoteId: args.quote.id,
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    return {
      quote: updatedQuote,
      lineItems: refreshedLineItems,
      computed,
    };
  };

  const ensureJobGeoForJob = async (args: {
    orgId: string;
    jobId: string;
    customerId?: string | null;
    addressLine1?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
  }) => {
    const customer =
      args.customerId
        ? await prisma.customer.findFirst({
            where: {
              id: args.customerId,
              orgId: args.orgId,
            },
            select: {
              addressLine1: true,
              city: true,
              state: true,
              postalCode: true,
            },
          })
        : null;

    const addressInput = {
      addressLine1: toStringOrNull(args.addressLine1) ?? customer?.addressLine1 ?? null,
      city: toStringOrNull(args.city) ?? customer?.city ?? null,
      state: toStringOrNull(args.state) ?? customer?.state ?? null,
      postalCode: toStringOrNull(args.postalCode) ?? customer?.postalCode ?? null,
      country: 'US',
    };

    const geocoded = await geocodeAddress(addressInput);
    const source =
      geocoded.lat !== null && geocoded.lng !== null
        ? JobGeoSource.GEOCODED
        : JobGeoSource.PROPERTY_ADDRESS;

    const jobGeo = await prisma.jobGeo.upsert({
      where: {
        jobId: args.jobId,
      },
      update: {
        source,
        addressNormalized: geocoded.addressNormalized,
        city: geocoded.city,
        state: geocoded.state,
        zip: geocoded.zip,
        lat: geocoded.lat,
        lng: geocoded.lng,
        geohash: geocoded.geohash,
        geocodedAt: geocoded.geocodedAt ?? undefined,
      },
      create: {
        orgId: args.orgId,
        jobId: args.jobId,
        source,
        addressNormalized: geocoded.addressNormalized,
        city: geocoded.city,
        state: geocoded.state,
        zip: geocoded.zip,
        lat: geocoded.lat,
        lng: geocoded.lng,
        geohash: geocoded.geohash,
        geocodedAt: geocoded.geocodedAt ?? undefined,
      },
    });

    await enqueueOutbox(prisma, {
      orgId: args.orgId,
      eventType: 'job.geotagged',
      payload: toInputJson({
        jobId: args.jobId,
        jobGeoId: jobGeo.id,
        source,
        city: jobGeo.city,
        state: jobGeo.state,
        zip: jobGeo.zip,
        geohash: jobGeo.geohash,
        geocodedAt: jobGeo.geocodedAt?.toISOString() ?? null,
      }),
    });

    return jobGeo;
  };

  const leadList: ToolHandler = async ({ context, payload }) => {
    const status = typeof payload.status === 'string' ? payload.status : undefined;
    const leads = await prisma.lead.findMany({
      where: {
        orgId: context.orgId,
        ...(status ? { status } : {}),
      },
      take: 100,
      orderBy: { createdAt: 'desc' },
    });

    return jsonResult({ leads });
  };

  const leadCreate: ToolHandler = async ({ context, payload }) => {
    const fullName = toStringOrNull(payload.fullName);
    if (!fullName) {
      throw new Error('fullName is required');
    }

    const email = toStringOrNull(payload.email);
    const phone = normalizePhone(payload.phone) ?? toStringOrNull(payload.phone);
    const status = toStringOrNull(payload.status) ?? 'NEW';
    const score = toNumberOrNull(payload.score);
    const notes = toStringOrNull(payload.notes);

    const existing = await prisma.lead.findFirst({
      where: {
        orgId: context.orgId,
        OR: [
          ...(email ? [{ email }] : []),
          ...(phone ? [{ phone }] : []),
        ],
      },
      orderBy: { createdAt: 'asc' },
    });

    const lead = existing
      ? await prisma.lead.update({
          where: { id: existing.id },
          data: {
            fullName,
            ...(email ? { email } : {}),
            ...(phone ? { phone } : {}),
            status,
            ...(score === null ? {} : { score: Math.round(score) }),
            ...(notes ? { notes: upsertLeadNote(existing.notes, notes) } : {}),
          },
        })
      : await prisma.lead.create({
          data: {
            orgId: context.orgId,
            fullName,
            email,
            phone,
            status,
            score: score === null ? 0 : Math.round(score),
            notes: notes ?? null,
          },
        });

    return jsonResult({
      action: existing ? 'updated' : 'created',
      lead: {
        id: lead.id,
        fullName: lead.fullName,
        status: lead.status,
        email: lead.email,
        phone: lead.phone,
      },
    });
  };

  const leadUpdateStage: ToolHandler = async ({ context, payload }) => {
    const input = leadUpdateStageSchema.parse(payload);
    const lead = await prisma.lead.findFirst({
      where: {
        id: input.leadId,
        orgId: context.orgId,
      },
    });

    if (!lead) {
      throw new Error('Lead not found');
    }

    const stage = input.stage.trim().toUpperCase();
    const nextNotes =
      input.notes && input.notes.trim().length > 0
        ? upsertLeadNote(
            lead.notes,
            `Stage update: ${stage} (${input.notes.trim()})`,
          )
        : lead.notes;

    const updatedLead = await prisma.lead.update({
      where: { id: lead.id },
      data: {
        stage,
        status: stage,
        notes: nextNotes,
      },
    });

    const existingOpportunity = await prisma.opportunity.findFirst({
      where: {
        orgId: context.orgId,
        leadId: lead.id,
      },
      orderBy: { createdAt: 'asc' },
    });

    const opportunity = existingOpportunity
      ? await prisma.opportunity.update({
          where: { id: existingOpportunity.id },
          data: {
            stage,
            ...(input.valueCents === undefined
              ? {}
              : { valueCents: Math.round(input.valueCents) }),
            ...(input.assignedToUserId === undefined
              ? {}
              : { assignedToUserId: toStringOrNull(input.assignedToUserId) }),
            metadata: toInputJson({
              ...jsonObject(existingOpportunity.metadata),
              lastLeadStageUpdateAt: new Date().toISOString(),
              lastLeadStageUpdatedByUserId: context.actorUserId ?? null,
            }),
          },
        })
      : await prisma.opportunity.create({
          data: {
            orgId: context.orgId,
            leadId: lead.id,
            stage,
            valueCents:
              input.valueCents === undefined ? 0 : Math.round(input.valueCents),
            assignedToUserId: toStringOrNull(input.assignedToUserId),
            metadata: toInputJson({
              createdFromLeadStageUpdateAt: new Date().toISOString(),
            }),
          },
        });

    return jsonResult({
      lead: {
        id: updatedLead.id,
        stage: updatedLead.stage,
        status: updatedLead.status,
      },
      opportunity: {
        id: opportunity.id,
        stage: opportunity.stage,
        valueCents: opportunity.valueCents,
        assignedToUserId: opportunity.assignedToUserId,
      },
    });
  };

  const leadProfileUpsert: ToolHandler = async ({ context, payload }) => {
    const input = leadProfileUpsertSchema.parse(payload);
    const now = new Date();
    const requestId = toStringOrNull(input.requestId);
    const sourceLeadId = toStringOrNull(input.sourceLeadId);
    const normalizedEmail = normalizeEmail(input.primaryContact?.email);
    const normalizedPhone = normalizePhone(input.primaryContact?.phone) ?? toStringOrNull(input.primaryContact?.phone);
    const normalizedTags = Array.from(
      new Set((input.tags ?? []).map((tag) => tag.trim()).filter((tag) => tag.length > 0)),
    );
    const leadType = parseLeadType(input.leadType);

    const result = await prisma.$transaction(async (tx) => {
      const slaConfig = await loadLeadSlaConfig(tx, context.orgId);
      const existing = await tx.lead.findFirst({
        where: {
          orgId: context.orgId,
          OR: [
            ...(toStringOrNull(input.leadId) ? [{ id: toStringOrNull(input.leadId) as string }] : []),
            ...(sourceLeadId
              ? [
                  {
                    profile: {
                      path: ['sourceLeadId'],
                      equals: sourceLeadId,
                    },
                  },
                ]
              : []),
            ...(normalizedEmail ? [{ email: normalizedEmail }] : []),
            ...(normalizedPhone ? [{ phone: normalizedPhone }] : []),
          ],
        },
        orderBy: { createdAt: 'asc' },
      });

      if (requestId && existing?.id) {
        const existingEvent = await tx.timelineEvent.findFirst({
          where: {
            orgId: context.orgId,
            leadId: existing.id,
            type: 'LEAD_PROFILE_UPDATED',
            requestId,
          },
          select: { id: true },
        });
        if (existingEvent) {
          return {
            lead: existing,
            timelineEventId: existingEvent.id,
            nextActionTaskId: null as string | null,
            idempotent: true,
          };
        }
      }

      const company = unknownObject(input.company);
      const companyDisplay =
        toStringOrNull(company.dba) ??
        toStringOrNull(company.legalName);
      const displayName =
        toStringOrNull(input.displayName) ??
        toStringOrNull(input.primaryContact?.name) ??
        companyDisplay ??
        existing?.fullName ??
        normalizedEmail ??
        normalizedPhone ??
        'Lead';
      const profile = {
        ...jsonObject(existing?.profile),
        sourceLeadId,
        primaryContact: {
          name: toStringOrNull(input.primaryContact?.name),
          email: normalizedEmail,
          phone: normalizedPhone,
        },
        company: {
          legalName: toStringOrNull(company.legalName),
          dba: toStringOrNull(company.dba),
          website: toStringOrNull(company.website),
        },
        tags: normalizedTags,
      };

      const lead =
        existing
          ? await tx.lead.update({
              where: { id: existing.id },
              data: {
                fullName: displayName,
                ...(normalizedEmail ? { email: normalizedEmail } : {}),
                ...(normalizedPhone ? { phone: normalizedPhone } : {}),
                leadType,
                profile: toInputJson(profile),
                ...(input.notes
                  ? {
                      notes: upsertLeadNote(existing.notes, input.notes),
                    }
                  : {}),
              },
            })
          : await tx.lead.create({
              data: {
                orgId: context.orgId,
                fullName: displayName,
                email: normalizedEmail,
                phone: normalizedPhone,
                stage: LeadStage.NEW,
                status: LeadStage.NEW,
                leadType,
                stageEnteredAt: now,
                nextTouchDueAt: computeNextTouchDueAt(LeadStage.NEW, slaConfig, now),
                profile: toInputJson(profile),
                notes: toStringOrNull(input.notes),
              },
            });

      let nextActionTaskId: string | null = null;
      const leadStage = leadStageFromRecord(lead.stage);
      if (!LEAD_TERMINAL_STAGES.has(leadStage)) {
        const nextDueAt =
          lead.nextTouchDueAt ??
          computeNextTouchDueAt(leadStage, slaConfig, now);
        if (nextDueAt && (!lead.nextTouchDueAt || lead.nextTouchDueAt.getTime() !== nextDueAt.getTime())) {
          await tx.lead.update({
            where: { id: lead.id },
            data: {
              nextTouchDueAt: nextDueAt,
            },
          });
        }
        if (nextDueAt) {
          const ensuredTask = await ensureLeadNextActionTask(tx, {
            orgId: context.orgId,
            leadId: lead.id,
            ownerUserId: lead.ownerUserId,
            dueAt: nextDueAt,
            stage: leadStage,
            requestId: requestId ? `${requestId}:auto-next-action` : null,
            title: `Next action for ${lead.fullName}`,
            description: `Follow up for lead stage ${leadStage}.`,
            priority: TaskPriority.MEDIUM,
            taskType: 'FOLLOW_UP',
          });
          nextActionTaskId = ensuredTask?.taskId ?? null;
        }
      }

      const timeline = await createLeadTimelineEvent(tx, {
        orgId: context.orgId,
        leadId: lead.id,
        type: 'LEAD_PROFILE_UPDATED',
        message: `Lead profile updated (${leadType}).`,
        requestId,
        metadata: toInputJson({
          leadType,
          sourceLeadId,
          hasPrimaryEmail: Boolean(normalizedEmail),
          hasPrimaryPhone: Boolean(normalizedPhone),
          tags: normalizedTags,
        }),
      });

      await enqueueOutbox(tx, {
        orgId: context.orgId,
        eventType: 'lead.profile.updated',
        payload: toInputJson({
          leadId: lead.id,
          leadType,
          sourceLeadId,
          requestId,
          timelineEventId: timeline.event.id,
        }),
      });

      return {
        lead,
        timelineEventId: timeline.event.id,
        nextActionTaskId,
        idempotent: timeline.idempotent,
      };
    });

    const warnings: string[] = [];
    if (result.lead.leadType === LeadType.COMMERCIAL) {
      const siteCount = await prisma.leadSite.count({
        where: {
          orgId: context.orgId,
          leadId: result.lead.id,
        },
      });
      if (siteCount === 0) {
        warnings.push('COMMERCIAL lead should include at least one site.');
      }
    }

    return jsonResult({
      leadId: result.lead.id,
      lead: {
        id: result.lead.id,
        fullName: result.lead.fullName,
        stage: result.lead.stage,
        status: result.lead.status,
        leadType: result.lead.leadType,
        ownerUserId: result.lead.ownerUserId,
        nextTouchDueAt: result.lead.nextTouchDueAt?.toISOString() ?? null,
      },
      timelineEventId: result.timelineEventId,
      nextActionTaskId: result.nextActionTaskId,
      warnings,
      idempotent: result.idempotent,
    });
  };

  const leadSiteUpsert: ToolHandler = async ({ context, payload }) => {
    const input = leadSiteUpsertSchema.parse(payload);
    const requestId = toStringOrNull(input.requestId);

    const result = await prisma.$transaction(async (tx) => {
      const lead = await tx.lead.findFirst({
        where: {
          id: input.leadId,
          orgId: context.orgId,
        },
      });
      if (!lead) {
        throw new Error('Lead not found');
      }

      if (requestId) {
        const existingByRequestId = await tx.leadSite.findFirst({
          where: {
            orgId: context.orgId,
            leadId: lead.id,
            requestId,
          },
        });
        if (existingByRequestId) {
          return {
            lead,
            site: existingByRequestId,
            idempotent: true,
          };
        }
      }

      const property = input.property ?? {};
      const commercial = input.commercial ?? {};
      const propertyTypeRaw = toStringOrNull(property.propertyType);
      const rooftopAccessRaw = toStringOrNull(commercial.rooftopAccessType);
      const propertyType =
        propertyTypeRaw && propertyTypeRaw in LeadSitePropertyType
          ? (propertyTypeRaw as LeadSitePropertyType)
          : null;
      const rooftopAccessType =
        rooftopAccessRaw && rooftopAccessRaw in RooftopAccessType
          ? (rooftopAccessRaw as RooftopAccessType)
          : null;

      let site;
      if (toStringOrNull(input.siteId)) {
        const existingSite = await tx.leadSite.findFirst({
          where: {
            id: toStringOrNull(input.siteId) as string,
            orgId: context.orgId,
            leadId: lead.id,
          },
        });
        if (!existingSite) {
          throw new Error('Lead site not found');
        }
        site = await tx.leadSite.update({
          where: { id: existingSite.id },
          data: {
            label: toStringOrNull(input.label),
            addressLine1: input.address.line1.trim(),
            addressLine2: toStringOrNull(input.address.line2),
            city: input.address.city.trim(),
            state: input.address.state.trim().toUpperCase(),
            postalCode: input.address.postalCode.trim(),
            propertyType,
            units:
              typeof property.units === 'number' && Number.isFinite(property.units)
                ? Math.max(0, Math.floor(property.units))
                : null,
            sqft:
              typeof property.sqft === 'number' && Number.isFinite(property.sqft)
                ? Math.max(0, Math.floor(property.sqft))
                : null,
            yearBuilt:
              typeof property.yearBuilt === 'number' && Number.isFinite(property.yearBuilt)
                ? Math.max(0, Math.floor(property.yearBuilt))
                : null,
            rtuCount:
              typeof commercial.rtuCount === 'number' && Number.isFinite(commercial.rtuCount)
                ? Math.max(0, Math.floor(commercial.rtuCount))
                : null,
            rooftopAccessType,
            rooftopAccessNotes: toStringOrNull(commercial.rooftopAccessNotes),
            siteNotes: toStringOrNull(input.siteNotes),
            requestId,
          },
        });
      } else {
        site = await tx.leadSite.create({
          data: {
            orgId: context.orgId,
            leadId: lead.id,
            label: toStringOrNull(input.label),
            addressLine1: input.address.line1.trim(),
            addressLine2: toStringOrNull(input.address.line2),
            city: input.address.city.trim(),
            state: input.address.state.trim().toUpperCase(),
            postalCode: input.address.postalCode.trim(),
            propertyType,
            units:
              typeof property.units === 'number' && Number.isFinite(property.units)
                ? Math.max(0, Math.floor(property.units))
                : null,
            sqft:
              typeof property.sqft === 'number' && Number.isFinite(property.sqft)
                ? Math.max(0, Math.floor(property.sqft))
                : null,
            yearBuilt:
              typeof property.yearBuilt === 'number' && Number.isFinite(property.yearBuilt)
                ? Math.max(0, Math.floor(property.yearBuilt))
                : null,
            rtuCount:
              typeof commercial.rtuCount === 'number' && Number.isFinite(commercial.rtuCount)
                ? Math.max(0, Math.floor(commercial.rtuCount))
                : null,
            rooftopAccessType,
            rooftopAccessNotes: toStringOrNull(commercial.rooftopAccessNotes),
            siteNotes: toStringOrNull(input.siteNotes),
            requestId,
          },
        });
      }

      const timeline = await createLeadTimelineEvent(tx, {
        orgId: context.orgId,
        leadId: lead.id,
        type: 'LEAD_SITE_UPDATED',
        message: `Lead site ${site.label ?? site.addressLine1} saved.`,
        requestId,
        metadata: toInputJson({
          siteId: site.id,
          propertyType: site.propertyType,
          rtuCount: site.rtuCount,
          rooftopAccessType: site.rooftopAccessType,
        }),
      });

      await enqueueOutbox(tx, {
        orgId: context.orgId,
        eventType: 'lead.site.updated',
        payload: toInputJson({
          leadId: lead.id,
          siteId: site.id,
          requestId,
          timelineEventId: timeline.event.id,
        }),
      });

      return {
        lead,
        site,
        timelineEventId: timeline.event.id,
        idempotent: false,
      };
    });

    return jsonResult({
      leadId: result.lead.id,
      siteId: result.site.id,
      site: result.site,
      timelineEventId: result.timelineEventId,
      idempotent: result.idempotent,
    });
  };

  const leadStageUpdateV2: ToolHandler = async ({ context, payload }) => {
    const input = leadStageUpdateV2Schema.parse(payload);
    const requestId = toStringOrNull(input.requestId);
    const now = new Date();

    const result = await prisma.$transaction(async (tx) => {
      const lead = await tx.lead.findFirst({
        where: {
          id: input.leadId,
          orgId: context.orgId,
        },
      });
      if (!lead) {
        throw new Error('Lead not found');
      }

      if (requestId) {
        const existingEvent = await tx.timelineEvent.findFirst({
          where: {
            orgId: context.orgId,
            leadId: lead.id,
            type: 'LEAD_STAGE_CHANGED',
            requestId,
          },
          select: { id: true },
        });
        if (existingEvent) {
          return {
            lead,
            timelineEventId: existingEvent.id,
            nextActionTaskId: null as string | null,
            idempotent: true,
          };
        }
      }

      const toStage = parseLeadStage(input.toStage);
      const lostOutcome = parseLostOutcome(input.lostOutcome);
      const slaConfig = await loadLeadSlaConfig(tx, context.orgId);
      const nextTouchDueAt = computeNextTouchDueAt(toStage, slaConfig, now);

      const updatedLead = await tx.lead.update({
        where: { id: lead.id },
        data: {
          stage: toStage,
          status: toStage,
          stageEnteredAt: now,
          nextTouchDueAt,
          ...(toStage === LeadStage.LOST
            ? {
                lostOutcome,
                lostNotes: toStringOrNull(input.lostNotes),
              }
            : {
                lostOutcome: null,
                lostNotes: null,
              }),
        },
      });

      let nextActionTaskId: string | null = null;
      if (LEAD_TERMINAL_STAGES.has(toStage)) {
        await closeLeadNextActions(tx, {
          orgId: context.orgId,
          leadId: lead.id,
          now,
        });
      } else if (nextTouchDueAt) {
        const ensured = await ensureLeadNextActionTask(tx, {
          orgId: context.orgId,
          leadId: lead.id,
          ownerUserId: updatedLead.ownerUserId,
          dueAt: nextTouchDueAt,
          stage: toStage,
          requestId: requestId ? `${requestId}:auto-next-action` : null,
          title: `Next action for ${updatedLead.fullName}`,
          description: `Follow up for lead stage ${toStage}.`,
          priority: TaskPriority.MEDIUM,
          taskType: 'FOLLOW_UP',
        });
        nextActionTaskId = ensured?.taskId ?? null;
      }

      const stageTimeline = await createLeadTimelineEvent(tx, {
        orgId: context.orgId,
        leadId: lead.id,
        type: 'LEAD_STAGE_CHANGED',
        message: `Lead stage changed to ${toStage}${input.reason ? ` (${input.reason})` : ''}.`,
        requestId,
        metadata: toInputJson({
          fromStage: lead.stage,
          toStage,
          reason: toStringOrNull(input.reason),
          lostOutcome,
          lostNotes: toStringOrNull(input.lostNotes),
          nextTouchDueAt: nextTouchDueAt?.toISOString() ?? null,
        }),
      });

      if (toStage === LeadStage.WON) {
        await createLeadTimelineEvent(tx, {
          orgId: context.orgId,
          leadId: lead.id,
          type: 'LEAD_MARKED_WON',
          message: `Lead marked WON${input.reason ? ` (${input.reason})` : ''}.`,
          requestId,
          metadata: toInputJson({
            reason: toStringOrNull(input.reason),
          }),
        });
      }
      if (toStage === LeadStage.LOST) {
        await createLeadTimelineEvent(tx, {
          orgId: context.orgId,
          leadId: lead.id,
          type: 'LEAD_MARKED_LOST',
          message: `Lead marked LOST${lostOutcome ? ` (${lostOutcome})` : ''}.`,
          requestId,
          metadata: toInputJson({
            reason: toStringOrNull(input.reason),
            lostOutcome,
            lostNotes: toStringOrNull(input.lostNotes),
          }),
        });
      }

      await enqueueOutbox(tx, {
        orgId: context.orgId,
        eventType: 'lead.stage.changed',
        payload: toInputJson({
          leadId: lead.id,
          fromStage: lead.stage,
          toStage,
          requestId,
          timelineEventId: stageTimeline.event.id,
          nextActionTaskId,
        }),
      });

      return {
        lead: updatedLead,
        timelineEventId: stageTimeline.event.id,
        nextActionTaskId,
        idempotent: stageTimeline.idempotent,
      };
    });

    return jsonResult({
      leadId: result.lead.id,
      lead: {
        id: result.lead.id,
        stage: result.lead.stage,
        status: result.lead.status,
        stageEnteredAt: result.lead.stageEnteredAt.toISOString(),
        nextTouchDueAt: result.lead.nextTouchDueAt?.toISOString() ?? null,
        lostOutcome: result.lead.lostOutcome,
      },
      timelineEventId: result.timelineEventId,
      nextActionTaskId: result.nextActionTaskId,
      idempotent: result.idempotent,
    });
  };

  const leadOwnerAssign: ToolHandler = async ({ context, payload }) => {
    const input = leadOwnerAssignSchema.parse(payload);
    const requestId = toStringOrNull(input.requestId);

    const result = await prisma.$transaction(async (tx) => {
      const [lead, ownerUser] = await Promise.all([
        tx.lead.findFirst({
          where: {
            id: input.leadId,
            orgId: context.orgId,
          },
        }),
        tx.user.findFirst({
          where: {
            id: input.ownerUserId,
            orgId: context.orgId,
            isActive: true,
          },
        }),
      ]);

      if (!lead) {
        throw new Error('Lead not found');
      }
      if (!ownerUser) {
        throw new Error('Owner user not found');
      }

      if (requestId) {
        const existingEvent = await tx.timelineEvent.findFirst({
          where: {
            orgId: context.orgId,
            leadId: lead.id,
            type: 'LEAD_OWNER_ASSIGNED',
            requestId,
          },
          select: { id: true },
        });
        if (existingEvent) {
          return {
            lead,
            timelineEventId: existingEvent.id,
            idempotent: true,
          };
        }
      }

      const updatedLead = await tx.lead.update({
        where: { id: lead.id },
        data: {
          ownerUserId: ownerUser.id,
        },
      });

      await tx.task.updateMany({
        where: {
          orgId: context.orgId,
          leadId: lead.id,
          isNextAction: true,
          status: {
            in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS],
          },
        },
        data: {
          assignedToUserId: ownerUser.id,
        },
      });

      const timeline = await createLeadTimelineEvent(tx, {
        orgId: context.orgId,
        leadId: lead.id,
        type: 'LEAD_OWNER_ASSIGNED',
        message: `Lead owner assigned to ${ownerUser.name}.`,
        requestId,
        metadata: toInputJson({
          ownerUserId: ownerUser.id,
          reason: toStringOrNull(input.reason),
        }),
      });

      await enqueueOutbox(tx, {
        orgId: context.orgId,
        eventType: 'lead.owner.assigned',
        payload: toInputJson({
          leadId: lead.id,
          ownerUserId: ownerUser.id,
          requestId,
          timelineEventId: timeline.event.id,
        }),
      });

      return {
        lead: updatedLead,
        timelineEventId: timeline.event.id,
        idempotent: timeline.idempotent,
      };
    });

    return jsonResult({
      leadId: result.lead.id,
      ownerUserId: result.lead.ownerUserId,
      timelineEventId: result.timelineEventId,
      idempotent: result.idempotent,
    });
  };

  const leadTouchRecord: ToolHandler = async ({ context, payload }) => {
    const input = leadTouchRecordSchema.parse(payload);
    const requestId = toStringOrNull(input.requestId);
    const now = new Date();

    const result = await prisma.$transaction(async (tx) => {
      const lead = await tx.lead.findFirst({
        where: {
          id: input.leadId,
          orgId: context.orgId,
        },
      });
      if (!lead) {
        throw new Error('Lead not found');
      }

      if (requestId) {
        const existingEvent = await tx.timelineEvent.findFirst({
          where: {
            orgId: context.orgId,
            leadId: lead.id,
            type: 'LEAD_TOUCHED',
            requestId,
          },
          select: { id: true },
        });
        if (existingEvent) {
          return {
            lead,
            timelineEventId: existingEvent.id,
            nextActionTaskId: null as string | null,
            idempotent: true,
          };
        }
      }

      const leadStage = leadStageFromRecord(lead.stage);
      const slaConfig = await loadLeadSlaConfig(tx, context.orgId);
      const nextTouchDueAt = computeNextTouchDueAt(leadStage, slaConfig, now);

      const updatedLead = await tx.lead.update({
        where: { id: lead.id },
        data: {
          lastTouchAt: now,
          nextTouchDueAt,
        },
      });

      let nextActionTaskId: string | null = null;
      if (!LEAD_TERMINAL_STAGES.has(leadStage) && nextTouchDueAt) {
        const ensured = await ensureLeadNextActionTask(tx, {
          orgId: context.orgId,
          leadId: lead.id,
          ownerUserId: updatedLead.ownerUserId,
          dueAt: nextTouchDueAt,
          stage: leadStage,
          requestId: requestId ? `${requestId}:auto-next-action` : null,
          title: `Next action for ${updatedLead.fullName}`,
          description: `Follow up after ${input.channel} touch (${input.direction}).`,
          priority: TaskPriority.MEDIUM,
          taskType: 'FOLLOW_UP',
        });
        nextActionTaskId = ensured?.taskId ?? null;
      }

      const timeline = await createLeadTimelineEvent(tx, {
        orgId: context.orgId,
        leadId: lead.id,
        type: 'LEAD_TOUCHED',
        message: `${input.direction} ${input.channel}: ${input.summary}`,
        requestId,
        metadata: toInputJson({
          channel: input.channel,
          direction: input.direction,
          outcome: toStringOrNull(input.outcome),
          relatedCommsThreadId: toStringOrNull(input.relatedCommsThreadId),
          nextTouchDueAt: nextTouchDueAt?.toISOString() ?? null,
        }),
      });

      await enqueueOutbox(tx, {
        orgId: context.orgId,
        eventType: 'lead.touched',
        payload: toInputJson({
          leadId: lead.id,
          channel: input.channel,
          direction: input.direction,
          requestId,
          timelineEventId: timeline.event.id,
        }),
      });

      return {
        lead: updatedLead,
        timelineEventId: timeline.event.id,
        nextActionTaskId,
        idempotent: timeline.idempotent,
      };
    });

    return jsonResult({
      leadId: result.lead.id,
      lastTouchAt: result.lead.lastTouchAt?.toISOString() ?? null,
      nextTouchDueAt: result.lead.nextTouchDueAt?.toISOString() ?? null,
      timelineEventId: result.timelineEventId,
      nextActionTaskId: result.nextActionTaskId,
      idempotent: result.idempotent,
    });
  };

  const leadNextActionSet: ToolHandler = async ({ context, payload }) => {
    const input = leadNextActionSetSchema.parse(payload);
    const requestId = toStringOrNull(input.requestId);
    const dueAt = toDateOrNull(input.task.dueAt);
    if (!dueAt) {
      raiseToolError('LEAD_NEXT_ACTION_DUE_INVALID', 'task.dueAt must be a valid ISO timestamp', true);
    }

    const result = await prisma.$transaction(async (tx) => {
      const lead = await tx.lead.findFirst({
        where: {
          id: input.leadId,
          orgId: context.orgId,
        },
      });
      if (!lead) {
        throw new Error('Lead not found');
      }

      if (requestId) {
        const existingTask = await tx.task.findFirst({
          where: {
            orgId: context.orgId,
            leadId: lead.id,
            requestId,
          },
        });
        if (existingTask) {
          return {
            lead,
            task: existingTask,
            timelineEventId: null as string | null,
            idempotent: true,
          };
        }
      }

      const ownerUserId = toStringOrNull(input.task.ownerUserId) ?? lead.ownerUserId;
      if (ownerUserId) {
        const owner = await tx.user.findFirst({
          where: {
            id: ownerUserId,
            orgId: context.orgId,
            isActive: true,
          },
          select: { id: true },
        });
        if (!owner) {
          throw new Error('Task owner user not found');
        }
      }

      if (input.replaceExisting) {
        await closeLeadNextActions(tx, {
          orgId: context.orgId,
          leadId: lead.id,
          now: new Date(),
        });
      }

      const task = await tx.task.create({
        data: {
          orgId: context.orgId,
          leadId: lead.id,
          title: input.task.title.trim(),
          description: toStringOrNull(input.task.description),
          kind: toStringOrNull(input.task.type) ?? 'FOLLOW_UP',
          isNextAction: true,
          queue: 'SALES',
          dueAt,
          priority: parseTaskPriority(input.task.priority),
          status: TaskStatus.OPEN,
          assignedToUserId: ownerUserId,
          requestId,
          metadata: toInputJson({
            source: 'lead.nextAction.set',
            replaceExisting: Boolean(input.replaceExisting),
          }),
        },
      });

      const leadStage = leadStageFromRecord(lead.stage);
      if (!LEAD_TERMINAL_STAGES.has(leadStage)) {
        await tx.lead.update({
          where: { id: lead.id },
          data: {
            nextTouchDueAt: dueAt,
          },
        });
      }

      const timeline = await createLeadTimelineEvent(tx, {
        orgId: context.orgId,
        leadId: lead.id,
        type: 'LEAD_NEXT_ACTION_SET',
        message: `Next action set: ${task.title ?? task.kind} (due ${dueAt.toISOString()}).`,
        requestId,
        metadata: toInputJson({
          taskId: task.id,
          type: task.kind,
          priority: task.priority,
          dueAt: dueAt.toISOString(),
        }),
      });

      await enqueueOutbox(tx, {
        orgId: context.orgId,
        eventType: 'lead.next_action.set',
        payload: toInputJson({
          leadId: lead.id,
          taskId: task.id,
          dueAt: dueAt.toISOString(),
          requestId,
          timelineEventId: timeline.event.id,
        }),
      });

      return {
        lead,
        task,
        timelineEventId: timeline.event.id,
        idempotent: false,
      };
    });

    return jsonResult({
      leadId: result.lead.id,
      taskId: result.task.id,
      task: {
        id: result.task.id,
        title: result.task.title,
        description: result.task.description,
        dueAt: result.task.dueAt.toISOString(),
        ownerUserId: result.task.assignedToUserId,
        priority: result.task.priority,
        type: result.task.kind,
        status: result.task.status,
      },
      timelineEventId: result.timelineEventId,
      idempotent: result.idempotent,
    });
  };

  const leadSlaEvaluate: ToolHandler = async ({ context, payload }) => {
    const input = leadSlaEvaluateSchema.parse(payload);
    const lead = await prisma.lead.findFirst({
      where: {
        id: input.leadId,
        orgId: context.orgId,
      },
      select: {
        id: true,
        stage: true,
        nextTouchDueAt: true,
      },
    });
    if (!lead) {
      throw new Error('Lead not found');
    }

    const config = await loadLeadSlaConfig(prisma, context.orgId);
    const evaluation = evaluateLeadSla(lead.nextTouchDueAt, config.dueSoonMinutes, new Date());
    const leadStage = leadStageFromRecord(lead.stage);

    const recommendedNextActionTemplate =
      LEAD_TERMINAL_STAGES.has(leadStage)
        ? null
        : evaluation.slaStatus === 'OVERDUE'
          ? {
              title: 'Urgent follow-up required',
              priority: 'HIGH',
              type: 'FOLLOW_UP',
            }
          : evaluation.slaStatus === 'DUE_SOON'
            ? {
                title: 'Follow up before SLA due',
                priority: 'NORMAL',
                type: 'FOLLOW_UP',
              }
            : {
                title: `Continue ${leadStage.toLowerCase().replace('_', ' ')} workflow`,
                priority: 'LOW',
                type: 'FOLLOW_UP',
              };

    return jsonResult({
      slaStatus: evaluation.slaStatus,
      minutesUntilDue: evaluation.minutesUntilDue,
      recommendedNextActionTemplate,
      escalationLevel: evaluation.escalationLevel,
    });
  };

  const leadNurtureEnroll: ToolHandler = async ({ context, payload }) => {
    const input = leadNurtureEnrollSchema.parse(payload);
    const requestId = toStringOrNull(input.requestId);
    const now = new Date();
    const startAt = toDateOrNull(input.startAt) ?? now;

    const result = await prisma.$transaction(async (tx) => {
      const lead = await tx.lead.findFirst({
        where: {
          id: input.leadId,
          orgId: context.orgId,
        },
      });
      if (!lead) {
        throw new Error('Lead not found');
      }

      if (requestId) {
        const existingEvent = await tx.timelineEvent.findFirst({
          where: {
            orgId: context.orgId,
            leadId: lead.id,
            type: 'LEAD_NURTURE_ENROLLED',
            requestId,
          },
          select: { id: true },
        });
        if (existingEvent) {
          return {
            lead,
            timelineEventId: existingEvent.id,
            nextActionTaskId: null as string | null,
            idempotent: true,
          };
        }
      }

      const config = await loadLeadSlaConfig(tx, context.orgId);
      const nextTouchDueAt = computeNextTouchDueAt(LeadStage.NURTURE, config, startAt);

      const updatedLead = await tx.lead.update({
        where: { id: lead.id },
        data: {
          stage: LeadStage.NURTURE,
          status: LeadStage.NURTURE,
          stageEnteredAt: now,
          nextTouchDueAt,
          nurtureConfig: toInputJson({
            cadence: input.cadence,
            channels: input.channels,
            startAt: startAt.toISOString(),
            notes: toStringOrNull(input.notes),
            enrolledByUserId: context.actorUserId ?? null,
            enrolledByType: context.actorType,
            requestId,
          }),
        },
      });

      let nextActionTaskId: string | null = null;
      if (nextTouchDueAt) {
        const ensured = await ensureLeadNextActionTask(tx, {
          orgId: context.orgId,
          leadId: lead.id,
          ownerUserId: updatedLead.ownerUserId,
          dueAt: nextTouchDueAt,
          stage: LeadStage.NURTURE,
          requestId: requestId ? `${requestId}:auto-next-action` : null,
          title: `Nurture follow-up for ${updatedLead.fullName}`,
          description: `Nurture cadence ${input.cadence}.`,
          priority: TaskPriority.MEDIUM,
          taskType: 'FOLLOW_UP',
        });
        nextActionTaskId = ensured?.taskId ?? null;
      }

      const timeline = await createLeadTimelineEvent(tx, {
        orgId: context.orgId,
        leadId: lead.id,
        type: 'LEAD_NURTURE_ENROLLED',
        message: `Lead enrolled in ${input.cadence.toLowerCase()} nurture cadence.`,
        requestId,
        metadata: toInputJson({
          cadence: input.cadence,
          channels: input.channels,
          startAt: startAt.toISOString(),
          notes: toStringOrNull(input.notes),
          nextTouchDueAt: nextTouchDueAt?.toISOString() ?? null,
        }),
      });

      await enqueueOutbox(tx, {
        orgId: context.orgId,
        eventType: 'lead.nurture.enrolled',
        payload: toInputJson({
          leadId: lead.id,
          cadence: input.cadence,
          channels: input.channels,
          requestId,
          timelineEventId: timeline.event.id,
          nextActionTaskId,
        }),
      });

      return {
        lead: updatedLead,
        timelineEventId: timeline.event.id,
        nextActionTaskId,
        idempotent: timeline.idempotent,
      };
    });

    return jsonResult({
      leadId: result.lead.id,
      stage: result.lead.stage,
      nextTouchDueAt: result.lead.nextTouchDueAt?.toISOString() ?? null,
      timelineEventId: result.timelineEventId,
      nextActionTaskId: result.nextActionTaskId,
      idempotent: result.idempotent,
    });
  };

  const customerGet: ToolHandler = async ({ context, payload }) => {
    const customerId = String(payload.customerId);
    const customer = await prisma.customer.findFirst({
      where: {
        id: customerId,
        orgId: context.orgId,
      },
    });

    return jsonResult({ customer });
  };

  const jobsList: ToolHandler = async ({ context, payload }) => {
    const status = typeof payload.status === 'string' ? payload.status : undefined;
    const jobs = await prisma.job.findMany({
      where: {
        orgId: context.orgId,
        ...(status ? { status } : {}),
      },
      take: 100,
      orderBy: { createdAt: 'desc' },
    });

    return jsonResult({ jobs });
  };

  const leadScore: ToolHandler = async ({ context, payload }) => {
    const updatedLead = await prisma.lead.update({
      where: {
        id: String(payload.leadId),
      },
      data: {
        score: Number(payload.score),
      },
    });

    return jsonResult({ updatedLead });
  };

  const taskCreate: ToolHandler = async ({ payload }) => {
    return jsonResult({
      taskId: `task_${Date.now()}`,
      leadId: payload.leadId,
      note: payload.note,
      status: 'CREATED',
    });
  };

  const leadUpsertFromWebsite: ToolHandler = async ({ context, payload }) => {
    const input = websiteLeadUpsertSchema.parse(payload);
    const fullName = buildFullName({
      firstName: input.firstName,
      lastName: input.lastName,
      fullName: input.fullName,
      email: input.email,
      phone: input.phone,
    });
    const email = toStringOrNull(input.email);
    const phone = normalizePhone(input.phone) ?? toStringOrNull(input.phone);
    const source = toStringOrNull(input.source) ?? 'website';
    const leadSource = toStringOrNull(input.leadSource) ?? source;

    if (!email && !phone && !fullName) {
      throw new Error('email, phone, or fullName is required');
    }

    const websiteSummary = [
      `Website intake source=${source}`,
      input.serviceType ? `serviceType=${input.serviceType}` : null,
      input.preferredDate ? `preferredDate=${input.preferredDate}` : null,
      input.preferredTime ? `preferredTime=${input.preferredTime}` : null,
      input.address ? `address=${input.address}` : null,
      input.city ? `city=${input.city}` : null,
      input.state ? `state=${input.state}` : null,
      input.zip ? `zip=${input.zip}` : null,
      input.message ? `message=${input.message}` : null,
    ]
      .filter(Boolean)
      .join(' | ');

    const existing = await prisma.lead.findFirst({
      where: {
        orgId: context.orgId,
        OR: [
          ...(email ? [{ email }] : []),
          ...(phone ? [{ phone }] : []),
        ],
      },
      orderBy: { createdAt: 'asc' },
    });

    const lead = existing
      ? await prisma.lead.update({
          where: { id: existing.id },
          data: {
            fullName,
            ...(email ? { email } : {}),
            ...(phone ? { phone } : {}),
            leadSource,
            ...(websiteSummary
              ? { notes: upsertLeadNote(existing.notes, websiteSummary) }
              : {}),
          },
        })
      : await prisma.lead.create({
          data: {
            orgId: context.orgId,
            fullName,
            email,
            phone,
            leadSource,
            status: 'NEW',
            score: 0,
            notes: websiteSummary || null,
          },
        });

    return jsonResult({
      action: existing ? 'updated' : 'created',
      leadId: lead.id,
      lead: {
        id: lead.id,
        fullName: lead.fullName,
        email: lead.email,
        phone: lead.phone,
        leadSource: lead.leadSource,
        status: lead.status,
      },
    });
  };

  const attributionCaptureFromWebsite: ToolHandler = async ({ context, payload }) => {
    const input = websiteAttributionCaptureSchema.parse(payload);

    const lead = await prisma.lead.findFirst({
      where: {
        id: input.leadId,
        orgId: context.orgId,
      },
      select: { id: true },
    });
    if (!lead) {
      throw new Error('Lead not found');
    }

    const sourceTypeRaw = input.sourceType?.trim().toUpperCase();
    const sourceType =
      sourceTypeRaw && sourceTypeRaw in AttributionSourceType
        ? (sourceTypeRaw as AttributionSourceType)
        : AttributionSourceType.WEB_FORM;

    const event = await prisma.attributionEvent.create({
      data: {
        orgId: context.orgId,
        leadId: lead.id,
        sourceType,
        utmSource: toStringOrNull(input.utmSource),
        utmMedium: toStringOrNull(input.utmMedium),
        utmCampaign: toStringOrNull(input.utmCampaign),
        utmContent: toStringOrNull(input.utmContent),
        utmTerm: toStringOrNull(input.utmTerm),
        gclid: toStringOrNull(input.gclid),
        gbraid: toStringOrNull(input.gbraid),
        wbraid: toStringOrNull(input.wbraid),
        fbclid: toStringOrNull(input.fbclid),
        landingUrl: toStringOrNull(input.landingUrl),
        referrerUrl: toStringOrNull(input.referrerUrl),
        userAgent: toStringOrNull(input.userAgent),
        ipHash: toStringOrNull(input.ipHash),
        metadata: toInputJson({
          visitorId: toStringOrNull(input.visitorId),
          sourceTypeRaw: sourceTypeRaw ?? null,
          ...(input.metadata ?? {}),
        }),
      },
    });

    return jsonResult({
      attributionEventId: event.id,
      attributionEvent: {
        id: event.id,
        leadId: event.leadId,
        sourceType: event.sourceType,
        capturedAt: event.capturedAt.toISOString(),
      },
    });
  };

  const timelineAdd: ToolHandler = async ({ context, payload }) => {
    const input = timelineAddSchema.parse(payload);

    const lead = await prisma.lead.findFirst({
      where: {
        id: input.leadId,
        orgId: context.orgId,
      },
      select: { id: true },
    });
    if (!lead) {
      throw new Error('Lead not found');
    }

    const event = await prisma.timelineEvent.create({
      data: {
        orgId: context.orgId,
        leadId: lead.id,
        type: input.type,
        message: input.message,
        metadata: toInputJson(input.metadata),
      },
    });

    return jsonResult({
      timelineEventId: event.id,
      timelineEvent: {
        id: event.id,
        leadId: event.leadId,
        type: event.type,
        message: event.message,
        createdAt: event.createdAt.toISOString(),
      },
    });
  };

  const taskCreateSalesSla: ToolHandler = async ({ context, payload }) => {
    const input = salesTaskCreateSchema.parse(payload);

    const lead = await prisma.lead.findFirst({
      where: {
        id: input.leadId,
        orgId: context.orgId,
      },
      select: { id: true },
    });
    if (!lead) {
      throw new Error('Lead not found');
    }

    const dueAt = new Date(Date.now() + input.dueInMinutes * 60_000);
    const task = await prisma.task.create({
      data: {
        orgId: context.orgId,
        leadId: lead.id,
        kind: input.kind,
        queue: toStringOrNull(input.queue) ?? 'SALES',
        dueAt,
        priority: input.priority as TaskPriority,
        metadata: toInputJson(input.metadata),
      },
    });

    return jsonResult({
      taskId: task.id,
      task: {
        id: task.id,
        leadId: task.leadId,
        kind: task.kind,
        queue: task.queue,
        priority: task.priority,
        status: task.status,
        dueAt: task.dueAt.toISOString(),
      },
    });
  };

  const attachmentRefCreate: ToolHandler = async ({ context, payload }) => {
    const input = attachmentRefCreateSchema.parse(payload);
    const provider = input.provider as AttachmentRefProvider;

    if (provider === AttachmentRefProvider.S3) {
      if (!toStringOrNull(input.bucket) || !toStringOrNull(input.objectKey)) {
        throw new Error('S3 attachments require bucket and objectKey');
      }
    }

    const attachmentRef = await prisma.attachmentRef.create({
      data: {
        orgId: context.orgId,
        provider,
        bucket: toStringOrNull(input.bucket),
        objectKey: toStringOrNull(input.objectKey),
        url: toStringOrNull(input.url),
        fileName: input.fileName,
        mimeType: toStringOrNull(input.mimeType),
        sizeBytes:
          typeof input.sizeBytes === 'number' && Number.isFinite(input.sizeBytes)
            ? Math.round(input.sizeBytes)
            : null,
        checksumSha256: toStringOrNull(input.checksumSha256),
        metadata: toInputJson(input.metadata),
      },
    });

    return jsonResult({
      attachmentRefId: attachmentRef.id,
      attachmentRef: {
        id: attachmentRef.id,
        provider: attachmentRef.provider,
        bucket: attachmentRef.bucket,
        objectKey: attachmentRef.objectKey,
        url: attachmentRef.url,
      },
    });
  };

  const priceMatchCreate: ToolHandler = async ({ context, payload }) => {
    const input = priceMatchCreateSchema.parse(payload);

    const lead = await prisma.lead.findFirst({
      where: {
        id: input.leadId,
        orgId: context.orgId,
      },
      select: { id: true },
    });
    if (!lead) {
      throw new Error('Lead not found');
    }

    const attachmentRefId = toStringOrNull(input.attachmentRefId);
    if (attachmentRefId) {
      const attachment = await prisma.attachmentRef.findFirst({
        where: {
          id: attachmentRefId,
          orgId: context.orgId,
        },
        select: { id: true },
      });
      if (!attachment) {
        throw new Error('AttachmentRef not found');
      }
    }

    const priceMatch = await prisma.priceMatchRequest.create({
      data: {
        orgId: context.orgId,
        leadId: lead.id,
        competitorName: input.competitorName,
        competitorPriceCents:
          typeof input.competitorPriceCents === 'number'
            ? input.competitorPriceCents
            : null,
        notes: toStringOrNull(input.notes),
        serviceType: toStringOrNull(input.serviceType),
        attachmentRefId,
        metadata: toInputJson(input.metadata),
      },
    });

    return jsonResult({
      priceMatchRequestId: priceMatch.id,
      priceMatchRequest: {
        id: priceMatch.id,
        leadId: priceMatch.leadId,
        competitorName: priceMatch.competitorName,
        competitorPriceCents: priceMatch.competitorPriceCents,
        attachmentRefId: priceMatch.attachmentRefId,
      },
    });
  };

  const noteAdd: ToolHandler = async ({ payload }) => {
    const leadId = String(payload.leadId);
    const note = String(payload.note);
    const existing = await prisma.lead.findUnique({
      where: { id: leadId },
      select: { notes: true },
    });

    const stamped = `[${new Date().toISOString()}] ${note}`;
    const mergedNotes = existing?.notes
      ? `${existing.notes}\n${stamped}`
      : stamped;

    const updatedLead = await prisma.lead.update({
      where: { id: leadId },
      data: { notes: mergedNotes },
      select: {
        id: true,
        notes: true,
        updatedAt: true,
      },
    });

    return jsonResult({ updatedLead });
  };

  const smsDraft: ToolHandler = async ({ payload }) => {
    return jsonResult({
      channel: 'sms',
      customerId: payload.customerId,
      body: `Hi! This is Russell Comfort Solutions following up on your service request.`,
    });
  };

  const emailDraft: ToolHandler = async ({ payload }) => {
    return jsonResult({
      channel: 'email',
      customerId: payload.customerId,
      subject: 'Russell Comfort Solutions Follow-up',
      body: 'Thank you for choosing Russell Comfort Solutions. We can help schedule your next step.',
    });
  };

  const smsSend: ToolHandler = async ({ payload }) => {
    return jsonResult({
      channel: 'sms',
      messageId: `sms_${Date.now()}`,
      customerId: payload.customerId,
      body: payload.body,
      delivered: true,
    });
  };

  const emailSend: ToolHandler = async ({ payload }) => {
    return jsonResult({
      channel: 'email',
      messageId: `email_${Date.now()}`,
      customerId: payload.customerId,
      subject: payload.subject,
      delivered: true,
    });
  };

  const createReviewRequestDraft = async (args: {
    context: {
      orgId: string;
      actorType: ActorType;
      actorUserId?: string;
    };
    payload: Record<string, unknown>;
  }) => {
    const jobId = toStringOrNull(args.payload.jobId);
    const customerIdInput = toStringOrNull(args.payload.customerId);
    let customerId = customerIdInput;

    const job = jobId
      ? await prisma.job.findFirst({
          where: {
            id: jobId,
            orgId: args.context.orgId,
          },
          include: {
            customer: true,
          },
        })
      : null;

    if (jobId && !job) {
      throw new Error('Job not found');
    }

    if (!customerId && job?.customerId) {
      customerId = job.customerId;
    }

    const customer = customerId
      ? await prisma.customer.findFirst({
          where: {
            id: customerId,
            orgId: args.context.orgId,
          },
        })
      : null;

    const explicitChannel = toReviewRequestChannel(args.payload.channel);
    const channel =
      explicitChannel ??
      (customer?.phone
        ? ReviewRequestChannel.SMS
        : customer?.email
          ? ReviewRequestChannel.EMAIL
          : null);
    if (!channel) {
      throw new Error('Unable to determine review request channel; provide channel and destination');
    }

    const destination =
      toStringOrNull(args.payload.destination) ??
      (channel === ReviewRequestChannel.SMS
        ? toStringOrNull(customer?.phone)
        : toStringOrNull(customer?.email));
    if (!destination) {
      throw new Error('Unable to determine destination for review request');
    }

    const reviewUrl = toStringOrNull(args.payload.reviewUrl);
    const messageDraft =
      toStringOrNull(args.payload.messageDraft) ??
      [
        `Hi ${customer?.fullName ?? 'there'}, thanks for choosing Russell Comfort Solutions.`,
        'Would you mind leaving a quick review?',
        reviewUrl ?? 'Reply to this message and we will send you a review link.',
      ].join(' ');

    const createdByUserId = args.context.actorUserId
      ? await resolveActorUserId(args.context.orgId, args.context.actorUserId)
      : null;

    const providerMeta = {
      ...(jsonObject(args.payload.providerMeta as Prisma.JsonValue | null | undefined)),
      source: toStringOrNull(args.payload.source) ?? 'review-request-tool',
      draftedAt: new Date().toISOString(),
      queueSendRequested: toBoolean(args.payload.queueSend),
      reviewUrl,
    };

    const reviewRequest = await prisma.reviewRequest.create({
      data: {
        orgId: args.context.orgId,
        customerId: customer?.id ?? customerId ?? null,
        jobId: job?.id ?? null,
        channel,
        status: ReviewRequestStatus.DRAFT,
        destination,
        messageDraft,
        createdByType: args.context.actorType,
        createdByUserId,
        providerMeta: toInputJson(providerMeta),
      },
    });

    await enqueueOutbox(prisma, {
      orgId: args.context.orgId,
      eventType: 'marketing.review.request.drafted',
      payload: {
        reviewRequestId: reviewRequest.id,
        customerId: reviewRequest.customerId,
        jobId: reviewRequest.jobId,
        channel: reviewRequest.channel,
        destination: reviewRequest.destination,
      },
    });

    return {
      reviewRequest,
      queueSendRequested: toBoolean(args.payload.queueSend),
    };
  };

  const reviewRequestDraft: ToolHandler = async ({ context, payload }) => {
    const created = await createReviewRequestDraft({
      context,
      payload,
    });

    return jsonResult({
      reviewRequest: {
        id: created.reviewRequest.id,
        customerId: created.reviewRequest.customerId,
        jobId: created.reviewRequest.jobId,
        channel: created.reviewRequest.channel,
        status: created.reviewRequest.status,
        destination: created.reviewRequest.destination,
        messageDraft: created.reviewRequest.messageDraft,
        createdAt: created.reviewRequest.createdAt.toISOString(),
      },
      queueSendRequested: created.queueSendRequested,
    });
  };

  const reviewRequestSend: ToolHandler = async ({ context, payload }) => {
    const reviewRequestId = toStringOrNull(payload.reviewRequestId);
    if (!reviewRequestId) {
      throw new Error('reviewRequestId is required');
    }

    const existing = await prisma.reviewRequest.findFirst({
      where: {
        id: reviewRequestId,
        orgId: context.orgId,
      },
    });
    if (!existing) {
      throw new Error('Review request not found');
    }

    if (existing.status === ReviewRequestStatus.SENT) {
      return jsonResult({
        reviewRequest: {
          id: existing.id,
          status: existing.status,
          channel: existing.channel,
          destination: existing.destination,
          sentAt: existing.sentAt?.toISOString() ?? null,
        },
        delivery: {
          messageId: (jsonObject(existing.providerMeta).messageId as string | undefined) ?? null,
          provider: (jsonObject(existing.providerMeta).provider as string | undefined) ?? 'stub',
          alreadySent: true,
        },
      });
    }

    const sentAt = new Date();
    const messageId = `review_${existing.channel.toLowerCase()}_${Date.now()}`;
    const providerMeta = {
      ...jsonObject(existing.providerMeta),
      provider: toStringOrNull(payload.provider) ?? 'stub',
      messageId,
      sentAt: sentAt.toISOString(),
      sentByType: context.actorType,
      sentByUserId: context.actorUserId ?? null,
    };

    const updated = await prisma.reviewRequest.update({
      where: { id: existing.id },
      data: {
        status: ReviewRequestStatus.SENT,
        sentAt,
        providerMeta: toInputJson(providerMeta),
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'marketing.review.request.sent',
      payload: {
        reviewRequestId: updated.id,
        customerId: updated.customerId,
        jobId: updated.jobId,
        channel: updated.channel,
        destination: updated.destination,
        sentAt: sentAt.toISOString(),
      },
    });

    return jsonResult({
      reviewRequest: {
        id: updated.id,
        status: updated.status,
        channel: updated.channel,
        destination: updated.destination,
        sentAt: updated.sentAt?.toISOString() ?? null,
      },
      delivery: {
        provider: providerMeta.provider,
        messageId,
      },
    });
  };

  const reviewRequestAuto: ToolHandler = async ({ context, payload }) => {
    const jobId = toStringOrNull(payload.jobId);
    if (!jobId) {
      throw new Error('jobId is required');
    }

    const created = await createReviewRequestDraft({
      context,
      payload: {
        ...payload,
        source: toStringOrNull(payload.source) ?? 'job.completed',
      },
    });

    return jsonResult({
      reviewRequest: {
        id: created.reviewRequest.id,
        jobId: created.reviewRequest.jobId,
        customerId: created.reviewRequest.customerId,
        status: created.reviewRequest.status,
        channel: created.reviewRequest.channel,
      },
      queueSendRequested: created.queueSendRequested,
      nextAction: created.queueSendRequested
        ? 'Invoke marketing.review.request.send to queue approval and dispatch.'
        : 'Review request drafted for operator review.',
    });
  };

  const referralInvite: ToolHandler = async ({ context, payload }) => {
    const customerId = toStringOrNull(payload.customerId);
    if (!customerId) {
      throw new Error('customerId is required');
    }

    const customer = await prisma.customer.findFirst({
      where: {
        id: customerId,
        orgId: context.orgId,
      },
    });
    if (!customer) {
      throw new Error('Customer not found');
    }

    const explicitProgramId = toStringOrNull(payload.programId);
    const program = explicitProgramId
      ? await prisma.referralProgram.findFirst({
          where: {
            id: explicitProgramId,
            orgId: context.orgId,
          },
        })
      : await prisma.referralProgram.findFirst({
          where: {
            orgId: context.orgId,
            isActive: true,
          },
          orderBy: { createdAt: 'asc' },
        });
    if (!program) {
      throw new Error('No referral program configured');
    }

    const referralCode = `RCS-${customer.id.slice(-6).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
    const linkBase =
      toStringOrNull(payload.linkBaseUrl) ??
      process.env.REFERRAL_BASE_URL ??
      'https://referrals.russellcomfort.local/invite';
    const referralLink = `${linkBase.replace(/\/+$/, '')}/${referralCode}`;
    const channel = toStringOrNull(payload.channel)?.toUpperCase() ?? 'SMS';
    const destination =
      toStringOrNull(payload.destination) ??
      (channel === 'EMAIL'
        ? toStringOrNull(customer.email)
        : toStringOrNull(customer.phone));

    const event = await prisma.referralEvent.create({
      data: {
        orgId: context.orgId,
        programId: program.id,
        referrerCustomerId: customer.id,
        status: ReferralEventStatus.INVITED,
        rewardIssued: false,
        metadata: toInputJson({
          referralCode,
          referralLink,
          channel,
          destination,
          invitedAt: new Date().toISOString(),
          invitedByType: context.actorType,
          invitedByUserId: context.actorUserId ?? null,
          messageDraft:
            toStringOrNull(payload.messageDraft) ??
            `Share this link with friends and family: ${referralLink}`,
        }),
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'marketing.referral.invited',
      payload: {
        referralEventId: event.id,
        programId: program.id,
        referrerCustomerId: customer.id,
        referralCode,
        referralLink,
      },
    });

    return jsonResult({
      referralEvent: {
        id: event.id,
        status: event.status,
        programId: event.programId,
        referrerCustomerId: event.referrerCustomerId,
      },
      invite: {
        referralCode,
        referralLink,
        channel,
        destination,
      },
    });
  };

  const referralConvert: ToolHandler = async ({ context, payload }) => {
    const referralEventId = toStringOrNull(payload.referralEventId);
    if (!referralEventId) {
      throw new Error('referralEventId is required');
    }

    const existing = await prisma.referralEvent.findFirst({
      where: {
        id: referralEventId,
        orgId: context.orgId,
      },
    });
    if (!existing) {
      throw new Error('Referral event not found');
    }

    const referredLeadId = toStringOrNull(payload.referredLeadId);
    const referredCustomerId = toStringOrNull(payload.referredCustomerId);
    const explicitStatus = toReferralEventStatus(payload.status);
    const nextStatus =
      explicitStatus ??
      (referredCustomerId
        ? ReferralEventStatus.WON
        : referredLeadId
          ? ReferralEventStatus.LEAD_CREATED
          : existing.status);

    const updated = await prisma.referralEvent.update({
      where: { id: existing.id },
      data: {
        ...(referredLeadId !== null ? { referredLeadId } : {}),
        ...(referredCustomerId !== null ? { referredCustomerId } : {}),
        status: nextStatus,
        metadata: toInputJson({
          ...jsonObject(existing.metadata),
          convertedAt: new Date().toISOString(),
          convertedByType: context.actorType,
          convertedByUserId: context.actorUserId ?? null,
          notes: toStringOrNull(payload.notes),
        }),
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'marketing.referral.converted',
      payload: {
        referralEventId: updated.id,
        status: updated.status,
        referredLeadId: updated.referredLeadId,
        referredCustomerId: updated.referredCustomerId,
      },
    });

    return jsonResult({
      referralEvent: {
        id: updated.id,
        status: updated.status,
        referredLeadId: updated.referredLeadId,
        referredCustomerId: updated.referredCustomerId,
      },
    });
  };

  const referralRewardIssue: ToolHandler = async ({ context, payload }) => {
    const referralEventId = toStringOrNull(payload.referralEventId);
    if (!referralEventId) {
      throw new Error('referralEventId is required');
    }

    const event = await prisma.referralEvent.findFirst({
      where: {
        id: referralEventId,
        orgId: context.orgId,
      },
      include: {
        program: true,
      },
    });
    if (!event) {
      throw new Error('Referral event not found');
    }

    const existingMetadata = jsonObject(event.metadata);
    if (event.rewardIssued) {
      return jsonResult({
        referralEvent: {
          id: event.id,
          status: event.status,
          rewardIssued: event.rewardIssued,
          rewardIssuedAt: event.rewardIssuedAt?.toISOString() ?? null,
        },
        reward: {
          alreadyIssued: true,
          rewardType:
            toStringOrNull(existingMetadata.rewardType) ?? event.program.rewardType,
          rewardValueCents:
            toNumberOrNull(existingMetadata.rewardValueCents) ??
            event.program.rewardValueCents,
        },
      });
    }

    const rewardValueCentsRaw = toNumberOrNull(payload.rewardValueCents);
    const rewardValueCents =
      rewardValueCentsRaw === null
        ? event.program.rewardValueCents
        : Math.max(0, Math.round(rewardValueCentsRaw));
    const issuedAt = new Date();

    const updated = await prisma.referralEvent.update({
      where: { id: event.id },
      data: {
        status: ReferralEventStatus.REWARDED,
        rewardIssued: true,
        rewardIssuedAt: issuedAt,
        metadata: toInputJson({
          ...existingMetadata,
          rewardIssuedAt: issuedAt.toISOString(),
          rewardIssuedByType: context.actorType,
          rewardIssuedByUserId: context.actorUserId ?? null,
          rewardType: event.program.rewardType,
          rewardValueCents,
          memo: toStringOrNull(payload.memo),
        }),
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'marketing.referral.reward.issued',
      payload: {
        referralEventId: updated.id,
        rewardValueCents,
        rewardType: event.program.rewardType,
      },
    });

    return jsonResult({
      referralEvent: {
        id: updated.id,
        status: updated.status,
        rewardIssued: updated.rewardIssued,
        rewardIssuedAt: updated.rewardIssuedAt?.toISOString() ?? null,
      },
      reward: {
        rewardType: event.program.rewardType,
        rewardValueCents,
      },
    });
  };

  const quoteSend: ToolHandler = async ({ context, payload }) => {
    const input = quoteSendSchema.parse(payload);
    const quote = await prisma.quote.findFirst({
      where: {
        id: input.quoteId,
        orgId: context.orgId,
      },
      include: { lead: true, customer: true },
    });
    if (!quote) {
      throw new Error('Quote not found');
    }

    const token =
      !quote.publicToken || input.regenerateToken
        ? randomUUID().replace(/-/g, '')
        : quote.publicToken;
    const expiresInDays = input.expiresInDays ?? 14;
    const sentAt = new Date();
    const expiresAt = new Date(sentAt.getTime() + expiresInDays * 24 * 60 * 60 * 1000);

    const updated = await prisma.quote.update({
      where: { id: quote.id },
      data: {
        status: 'SENT',
        sentAt,
        publicToken: token,
        publicTokenExpiresAt: expiresAt,
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'quote.sent',
      payload: toInputJson({
        quoteId: updated.id,
        quoteKind: updated.kind,
        leadId: updated.leadId,
        customerId: updated.customerId,
        sentAt: updated.sentAt?.toISOString() ?? null,
        expiresAt: updated.publicTokenExpiresAt?.toISOString() ?? null,
        publicToken: updated.publicToken,
      }),
    });

    return jsonResult({
      quote: {
        id: updated.id,
        status: updated.status,
        kind: updated.kind,
        sentAt: updated.sentAt?.toISOString() ?? null,
        publicToken: updated.publicToken,
        publicTokenExpiresAt: updated.publicTokenExpiresAt?.toISOString() ?? null,
      },
      publicPath: '/public/quotes/' + updated.publicToken,
    });
  };

  const quoteAccept: ToolHandler = async ({ context, payload }) => {
    const input = quoteAcceptSchema.parse(payload);
    const quote = await prisma.quote.findFirst({
      where: {
        orgId: context.orgId,
        publicToken: input.quoteToken,
      },
    });
    if (!quote) {
      throw new Error('Quote token not found');
    }

    const now = new Date();
    const updated = await prisma.quote.update({
      where: { id: quote.id },
      data: {
        status: 'ACCEPTED',
        acceptedAt: quote.acceptedAt ?? now,
        acceptedByName: input.acceptedByName,
        acceptanceNotes: toStringOrNull(input.notes),
        acceptedIpHash: toStringOrNull(input.acceptedIpHash),
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'quote.accepted',
      payload: toInputJson({
        quoteId: updated.id,
        quoteKind: updated.kind,
        acceptedAt: updated.acceptedAt?.toISOString() ?? null,
        acceptedByName: updated.acceptedByName,
      }),
    });

    return jsonResult({
      quote: {
        id: updated.id,
        status: updated.status,
        acceptedAt: updated.acceptedAt?.toISOString() ?? null,
        acceptedByName: updated.acceptedByName,
      },
    });
  };

  const contractClauseCreateDraft: ToolHandler = async ({ context, payload }) => {
    const input = contractClauseCreateDraftSchema.parse(payload);

    const existing = await prisma.contractClause.findFirst({
      where: {
        orgId: context.orgId,
        stableId: input.stableId,
        version: input.version,
      },
    });
    if (existing) {
      return jsonResult({
        clause: existing,
        idempotent: true,
      });
    }

    const created = await prisma.contractClause.create({
      data: {
        orgId: context.orgId,
        stableId: input.stableId,
        version: input.version,
        jurisdiction: input.jurisdiction,
        title: input.title,
        bodyText: input.bodyText,
        placeholders: extractPlaceholders(input.bodyText),
        metadata: toInputJson({
          ...(input.metadata ?? {}),
          requestId: toStringOrNull(input.requestId),
          createdByType: context.actorType,
          createdByUserId: context.actorUserId ?? null,
        }),
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'contract.clause.draft.created',
      payload: toInputJson({
        clauseId: created.id,
        stableId: created.stableId,
        version: created.version,
        jurisdiction: created.jurisdiction,
        requestId: toStringOrNull(input.requestId),
      }),
    });

    return jsonResult({
      clause: created,
      idempotent: false,
    });
  };

  const contractClauseUpdateDraft: ToolHandler = async ({ context, payload }) => {
    const input = contractClauseUpdateDraftSchema.parse(payload);

    const existing = await prisma.contractClause.findFirst({
      where: {
        orgId: context.orgId,
        stableId: input.stableId,
        version: input.version,
      },
    });
    if (!existing) {
      throw new Error('Contract clause version not found');
    }
    if (existing.status !== 'DRAFT') {
      raiseToolError(
        'CONTRACT_CLAUSE_NOT_DRAFT',
        'Only DRAFT clause versions can be updated',
        false,
      );
    }

    const nextBodyText = input.bodyText ?? existing.bodyText;
    const updated = await prisma.contractClause.update({
      where: { id: existing.id },
      data: {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.bodyText === undefined ? {} : { bodyText: input.bodyText }),
        placeholders: extractPlaceholders(nextBodyText),
        ...(input.metadata === undefined
          ? {}
          : {
              metadata: toInputJson({
                ...jsonObject(existing.metadata),
                ...input.metadata,
                requestId: toStringOrNull(input.requestId),
                updatedByType: context.actorType,
                updatedByUserId: context.actorUserId ?? null,
              }),
            }),
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'contract.clause.draft.updated',
      payload: toInputJson({
        clauseId: updated.id,
        stableId: updated.stableId,
        version: updated.version,
        requestId: toStringOrNull(input.requestId),
      }),
    });

    return jsonResult({
      clause: updated,
    });
  };

  const contractClausePublish: ToolHandler = async ({ context, payload }) => {
    const input = contractClausePublishSchema.parse(payload);

    const existing = await prisma.contractClause.findFirst({
      where: {
        orgId: context.orgId,
        stableId: input.stableId,
        version: input.version,
      },
    });
    if (!existing) {
      throw new Error('Contract clause version not found');
    }
    if (existing.status === 'PUBLISHED') {
      return jsonResult({
        clause: existing,
        idempotent: true,
      });
    }
    if (existing.status !== 'DRAFT') {
      raiseToolError(
        'CONTRACT_CLAUSE_NOT_PUBLISHABLE',
        `Clause status ${existing.status} cannot be published`,
        false,
      );
    }

    const published = await prisma.contractClause.update({
      where: { id: existing.id },
      data: {
        status: 'PUBLISHED',
        publishedAt: new Date(),
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'contract.clause.published',
      payload: toInputJson({
        clauseId: published.id,
        stableId: published.stableId,
        version: published.version,
        requestId: toStringOrNull(input.requestId),
      }),
    });

    return jsonResult({
      clause: published,
      idempotent: false,
    });
  };

  const contractClauseDeprecate: ToolHandler = async ({ context, payload }) => {
    const input = contractClauseDeprecateSchema.parse(payload);

    const existing = await prisma.contractClause.findFirst({
      where: {
        orgId: context.orgId,
        stableId: input.stableId,
        version: input.version,
      },
    });
    if (!existing) {
      throw new Error('Contract clause version not found');
    }
    if (existing.status === 'DEPRECATED') {
      return jsonResult({
        clause: existing,
        idempotent: true,
      });
    }

    const deprecated = await prisma.contractClause.update({
      where: { id: existing.id },
      data: {
        status: 'DEPRECATED',
        deprecatedAt: new Date(),
        metadata: toInputJson({
          ...jsonObject(existing.metadata),
          deprecatedReason: toStringOrNull(input.reason),
          deprecatedByType: context.actorType,
          deprecatedByUserId: context.actorUserId ?? null,
          requestId: toStringOrNull(input.requestId),
        }),
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'contract.clause.deprecated',
      payload: toInputJson({
        clauseId: deprecated.id,
        stableId: deprecated.stableId,
        version: deprecated.version,
        reason: toStringOrNull(input.reason),
        requestId: toStringOrNull(input.requestId),
      }),
    });

    return jsonResult({
      clause: deprecated,
      idempotent: false,
    });
  };

  const contractTemplateCreateDraft: ToolHandler = async ({ context, payload }) => {
    const input = contractTemplateCreateDraftSchema.parse(payload);

    const existing = await prisma.contractTemplate.findFirst({
      where: {
        orgId: context.orgId,
        templateStableId: input.templateStableId,
        version: input.version,
      },
    });
    if (existing) {
      return jsonResult({
        template: existing,
        idempotent: true,
      });
    }

    const created = await prisma.contractTemplate.create({
      data: {
        orgId: context.orgId,
        templateStableId: input.templateStableId,
        version: input.version,
        jurisdiction: input.jurisdiction,
        name: input.name,
        bodyText: toStringOrNull(input.bodyText),
        clauseStableIds: [...new Set((input.clauseStableIds ?? []).map((value) => value.trim()))].sort((a, b) => a.localeCompare(b)),
        structureJson: toInputJson(input.structureJson),
        metadata: toInputJson({
          ...(input.metadata ?? {}),
          requestId: toStringOrNull(input.requestId),
          createdByType: context.actorType,
          createdByUserId: context.actorUserId ?? null,
        }),
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'contract.template.draft.created',
      payload: toInputJson({
        templateId: created.id,
        templateStableId: created.templateStableId,
        version: created.version,
        requestId: toStringOrNull(input.requestId),
      }),
    });

    return jsonResult({
      template: created,
      idempotent: false,
    });
  };

  const contractTemplateUpdateStructure: ToolHandler = async ({ context, payload }) => {
    const input = contractTemplateUpdateStructureSchema.parse(payload);

    const existing = await prisma.contractTemplate.findFirst({
      where: {
        orgId: context.orgId,
        templateStableId: input.templateStableId,
        version: input.version,
      },
    });
    if (!existing) {
      throw new Error('Contract template version not found');
    }
    if (existing.status !== 'DRAFT') {
      raiseToolError(
        'CONTRACT_TEMPLATE_NOT_DRAFT',
        'Only DRAFT template versions can be updated',
        false,
      );
    }

    const updated = await prisma.contractTemplate.update({
      where: { id: existing.id },
      data: {
        structureJson: toInputJson(input.structureJson),
        ...(input.bodyText === undefined ? {} : { bodyText: toStringOrNull(input.bodyText) }),
        ...(input.clauseStableIds === undefined
          ? {}
          : {
              clauseStableIds: [...new Set(input.clauseStableIds.map((value) => value.trim()))].sort((a, b) => a.localeCompare(b)),
            }),
        ...(input.metadata === undefined
          ? {}
          : {
              metadata: toInputJson({
                ...jsonObject(existing.metadata),
                ...input.metadata,
                requestId: toStringOrNull(input.requestId),
                updatedByType: context.actorType,
                updatedByUserId: context.actorUserId ?? null,
              }),
            }),
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'contract.template.structure.updated',
      payload: toInputJson({
        templateId: updated.id,
        templateStableId: updated.templateStableId,
        version: updated.version,
        requestId: toStringOrNull(input.requestId),
      }),
    });

    return jsonResult({
      template: updated,
    });
  };

  const contractTemplateUpdateVariableSchema: ToolHandler = async ({ context, payload }) => {
    const input = contractTemplateUpdateVariableSchemaSchema.parse(payload);

    const existing = await prisma.contractTemplate.findFirst({
      where: {
        orgId: context.orgId,
        templateStableId: input.templateStableId,
        version: input.version,
      },
    });
    if (!existing) {
      throw new Error('Contract template version not found');
    }
    if (existing.status !== 'DRAFT') {
      raiseToolError(
        'CONTRACT_TEMPLATE_NOT_DRAFT',
        'Only DRAFT template versions can be updated',
        false,
      );
    }

    const updated = await prisma.contractTemplate.update({
      where: { id: existing.id },
      data: {
        variableSchemaJson: toInputJson(input.variableSchemaJson),
        metadata: toInputJson({
          ...jsonObject(existing.metadata),
          variableSchemaUpdatedAt: new Date().toISOString(),
          requestId: toStringOrNull(input.requestId),
          updatedByType: context.actorType,
          updatedByUserId: context.actorUserId ?? null,
        }),
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'contract.template.variable_schema.updated',
      payload: toInputJson({
        templateId: updated.id,
        templateStableId: updated.templateStableId,
        version: updated.version,
        requestId: toStringOrNull(input.requestId),
      }),
    });

    return jsonResult({
      template: updated,
    });
  };

  const contractTemplatePublish: ToolHandler = async ({ context, payload }) => {
    const input = contractTemplatePublishSchema.parse(payload);

    const existing = await prisma.contractTemplate.findFirst({
      where: {
        orgId: context.orgId,
        templateStableId: input.templateStableId,
        version: input.version,
      },
    });
    if (!existing) {
      throw new Error('Contract template version not found');
    }
    if (existing.status === 'PUBLISHED') {
      return jsonResult({
        template: existing,
        idempotent: true,
      });
    }
    if (existing.status !== 'DRAFT') {
      raiseToolError(
        'CONTRACT_TEMPLATE_NOT_PUBLISHABLE',
        `Template status ${existing.status} cannot be published`,
        false,
      );
    }

    const published = await prisma.contractTemplate.update({
      where: { id: existing.id },
      data: {
        status: 'PUBLISHED',
        publishedAt: new Date(),
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'contract.template.published',
      payload: toInputJson({
        templateId: published.id,
        templateStableId: published.templateStableId,
        version: published.version,
        requestId: toStringOrNull(input.requestId),
      }),
    });

    return jsonResult({
      template: published,
      idempotent: false,
    });
  };

  const contractLegalPackUpsert: ToolHandler = async ({ context, payload }) => {
    const input = contractLegalPackUpsertSchema.parse(payload);

    const upserted = await prisma.legalPack.upsert({
      where: {
        orgId_packStableId_version: {
          orgId: context.orgId,
          packStableId: input.packStableId,
          version: input.version,
        },
      },
      update: {
        jurisdiction: input.jurisdiction,
        sourceRepo: toStringOrNull(input.sourceRepo),
        sourceTag: toStringOrNull(input.sourceTag),
        templateStableIds: [...new Set(input.templateStableIds.map((value) => value.trim()))].sort((a, b) => a.localeCompare(b)),
        legalPackJson: toInputJson(input.legalPackJson),
        metadata: toInputJson({
          ...(input.metadata ?? {}),
          requestId: toStringOrNull(input.requestId),
          updatedByType: context.actorType,
          updatedByUserId: context.actorUserId ?? null,
        }),
      },
      create: {
        orgId: context.orgId,
        packStableId: input.packStableId,
        jurisdiction: input.jurisdiction,
        version: input.version,
        sourceRepo: toStringOrNull(input.sourceRepo),
        sourceTag: toStringOrNull(input.sourceTag),
        templateStableIds: [...new Set(input.templateStableIds.map((value) => value.trim()))].sort((a, b) => a.localeCompare(b)),
        legalPackJson: toInputJson(input.legalPackJson),
        metadata: toInputJson({
          ...(input.metadata ?? {}),
          requestId: toStringOrNull(input.requestId),
          createdByType: context.actorType,
          createdByUserId: context.actorUserId ?? null,
        }),
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'contract.legal_pack.upserted',
      payload: toInputJson({
        legalPackId: upserted.id,
        packStableId: upserted.packStableId,
        version: upserted.version,
        requestId: toStringOrNull(input.requestId),
      }),
    });

    return jsonResult({
      legalPack: upserted,
    });
  };

  const quoteManifestGenerate: ToolHandler = async ({ context, payload }) => {
    const input = quoteManifestGenerateSchema.parse(payload);
    const quote = await prisma.quote.findFirst({
      where: {
        id: input.quoteId,
        orgId: context.orgId,
      },
      include: {
        options: true,
      },
    });
    if (!quote) {
      throw new Error('Quote not found');
    }

    const selectedOption =
      (input.optionKey
        ? quote.options.find((option) => option.optionKey === input.optionKey)
        : quote.options[0]) ?? null;
    const guardrailFlags: string[] = [];
    if (quote.guardrailStatus !== GuardrailStatus.OK) {
      guardrailFlags.push(`quote:${quote.guardrailStatus}`);
    }
    if (selectedOption && selectedOption.guardrailStatus !== GuardrailStatus.OK) {
      guardrailFlags.push(`option:${selectedOption.optionKey}:${selectedOption.guardrailStatus}`);
    }

    const manifest = {
      quoteId: quote.id,
      requestId: toStringOrNull(input.requestId),
      generatedAt: new Date().toISOString(),
      selectedOption: selectedOption
        ? {
            optionId: selectedOption.id,
            optionKey: selectedOption.optionKey,
            label: selectedOption.label,
          }
        : null,
      totalPriceCents:
        selectedOption?.finalSellPriceCents ??
        quote.finalTotalCents ??
        quote.totalCents,
      guardrailFlags,
      readinessToConvert:
        quote.status === 'SENT' ||
        quote.status === 'ACCEPTED',
    };

    const metadata = jsonObject(quote.metadata);
    const existingManifest = unknownObject(metadata.quoteManifest);
    if (
      toStringOrNull(manifest.requestId) &&
      toStringOrNull(existingManifest.requestId) === manifest.requestId
    ) {
      return jsonResult({
        quoteId: quote.id,
        manifest: existingManifest,
        idempotent: true,
      });
    }

    await prisma.quote.update({
      where: { id: quote.id },
      data: {
        metadata: toInputJson({
          ...metadata,
          quoteManifest: manifest,
        }),
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'quote.manifest.generated',
      payload: toInputJson({
        quoteId: quote.id,
        selectedOptionKey: selectedOption?.optionKey ?? null,
        totalPriceCents: manifest.totalPriceCents,
        readinessToConvert: manifest.readinessToConvert,
        requestId: manifest.requestId,
      }),
    });

    return jsonResult({
      quoteId: quote.id,
      manifest,
      idempotent: false,
    });
  };

  const quoteManifestGet: ToolHandler = async ({ context, payload }) => {
    const input = quoteManifestGetSchema.parse(payload);
    const quote = await prisma.quote.findFirst({
      where: {
        id: input.quoteId,
        orgId: context.orgId,
      },
      include: {
        options: true,
      },
    });
    if (!quote) {
      throw new Error('Quote not found');
    }

    const metadata = jsonObject(quote.metadata);
    const manifest = unknownObject(metadata.quoteManifest);
    const fallbackManifest = {
      quoteId: quote.id,
      selectedOption: quote.options[0]
        ? {
            optionId: quote.options[0].id,
            optionKey: quote.options[0].optionKey,
            label: quote.options[0].label,
          }
        : null,
      totalPriceCents:
        quote.options[0]?.finalSellPriceCents ??
        quote.finalTotalCents ??
        quote.totalCents,
      guardrailFlags:
        quote.guardrailStatus === GuardrailStatus.OK
          ? []
          : [`quote:${quote.guardrailStatus}`],
      readinessToConvert:
        quote.status === 'SENT' ||
        quote.status === 'ACCEPTED',
    };

    return jsonResult({
      quoteId: quote.id,
      manifest: Object.keys(manifest).length > 0 ? manifest : fallbackManifest,
    });
  };

  const quoteAcceptWithEvidence: ToolHandler = async ({ context, payload }) => {
    const input = quoteAcceptWithEvidenceSchema.parse(payload);
    const quote = await prisma.quote.findFirst({
      where: {
        id: input.quoteId,
        orgId: context.orgId,
      },
    });
    if (!quote) {
      throw new Error('Quote not found');
    }

    const acceptedAt = toDateOrNull(input.acceptedAt) ?? quote.acceptedAt ?? new Date();
    const metadata = jsonObject(quote.metadata);
    const acceptanceMetadata = unknownObject(metadata.acceptance);
    const mergedEvidence = {
      ...unknownObject(acceptanceMetadata.evidence),
      ...unknownObject(input.evidence),
    };

    const updated = await prisma.quote.update({
      where: { id: quote.id },
      data: {
        status: 'ACCEPTED',
        acceptedAt,
        acceptedByName: input.acceptedByName,
        acceptanceNotes: toStringOrNull(input.notes),
        acceptedIpHash: toStringOrNull(input.acceptedIpHash),
        metadata: toInputJson({
          ...metadata,
          acceptance: {
            acceptedAt: acceptedAt.toISOString(),
            acceptedByName: input.acceptedByName,
            acceptedByType: context.actorType,
            acceptedByUserId: context.actorUserId ?? null,
            notes: toStringOrNull(input.notes),
            evidence: mergedEvidence,
          },
        }),
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'quote.accepted.with_evidence',
      payload: toInputJson({
        quoteId: updated.id,
        acceptedAt: updated.acceptedAt?.toISOString() ?? null,
        acceptedByName: updated.acceptedByName,
        evidenceKeys: Object.keys(mergedEvidence),
      }),
    });

    return jsonResult({
      quote: {
        id: updated.id,
        status: updated.status,
        acceptedAt: updated.acceptedAt?.toISOString() ?? null,
        acceptedByName: updated.acceptedByName,
      },
      evidence: mergedEvidence,
    });
  };

  const contractPreviewFromQuote: ToolHandler = async ({ context, payload }) => {
    const input = contractPreviewFromQuoteSchema.parse(payload);
    const quote = await prisma.quote.findFirst({
      where: {
        id: input.quoteId,
        orgId: context.orgId,
      },
      include: {
        customer: true,
        lead: true,
        lineItems: {
          orderBy: { sortOrder: 'asc' },
        },
        options: true,
      },
    });
    if (!quote) {
      throw new Error('Quote not found');
    }

    const selectedOption =
      (input.optionKey
        ? quote.options.find((option) => option.optionKey === input.optionKey)
        : quote.options[0]) ?? null;
    const signerClassification = quote.customerId ? 'CUSTOMER' : 'LEAD';
    const signerName =
      quote.customer?.fullName ??
      quote.lead?.fullName ??
      'Customer';
    const signerEmail =
      quote.customer?.email ??
      quote.lead?.email ??
      null;

    const preview = {
      quoteId: quote.id,
      quoteKind: quote.kind,
      quoteStatus: quote.status,
      signer: {
        classification: signerClassification,
        name: signerName,
        email: signerEmail,
      },
      selectedOption: selectedOption
        ? {
            optionId: selectedOption.id,
            optionKey: selectedOption.optionKey,
            label: selectedOption.label,
            finalSellPriceCents: selectedOption.finalSellPriceCents,
          }
        : null,
      quoteTotalCents:
        selectedOption?.finalSellPriceCents ??
        quote.finalTotalCents ??
        quote.totalCents,
      lineItems: input.includeLineItems
        ? quote.lineItems.map((line) => ({
            lineItemId: line.id,
            name: line.nameSnapshot,
            qty: line.qty,
            lineTotalCents: line.lineTotalCents,
          }))
        : undefined,
    };

    return jsonResult({
      preview,
    });
  };

  const contractDraftCreateFromQuote: ToolHandler = async ({ context, payload }) => {
    const input = contractDraftCreateFromQuoteSchema.parse(payload);
    const quote = await prisma.quote.findFirst({
      where: {
        id: input.quoteId,
        orgId: context.orgId,
      },
      include: {
        customer: true,
        lead: true,
      },
    });
    if (!quote) {
      throw new Error('Quote not found');
    }

    const metadata = jsonObject(quote.metadata);
    const workflow = unknownObject(metadata.contractWorkflow);
    const drafts = unknownObjectArray(workflow.drafts);
    const requestId = toStringOrNull(input.requestId);
    if (requestId) {
      const existing = drafts.find((draft) => toStringOrNull(draft.requestId) === requestId);
      if (existing) {
        return jsonResult({
          quoteId: quote.id,
          draft: existing,
          idempotent: true,
        });
      }
    }

    const draft = {
      draftId: `draft_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      requestId,
      createdAt: new Date().toISOString(),
      status: 'DRAFT',
      templateId: toStringOrNull(input.templateId) ?? 'standard_contract_v1',
      signerClassification:
        toStringOrNull(input.signerClassification) ??
        (quote.customerId ? 'CUSTOMER' : 'LEAD'),
      signerName:
        quote.customer?.fullName ??
        quote.lead?.fullName ??
        'Customer',
      signerEmail:
        quote.customer?.email ??
        quote.lead?.email ??
        null,
      notes: toStringOrNull(input.notes),
    };

    const updatedWorkflow = {
      ...workflow,
      drafts: [...drafts, draft],
      lastDraftId: draft.draftId,
    };

    await prisma.quote.update({
      where: { id: quote.id },
      data: {
        metadata: toInputJson({
          ...metadata,
          contractWorkflow: updatedWorkflow,
        }),
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'contract.draft.created',
      payload: toInputJson({
        quoteId: quote.id,
        draftId: draft.draftId,
        templateId: draft.templateId,
        requestId,
      }),
    });

    return jsonResult({
      quoteId: quote.id,
      draft,
      idempotent: false,
    });
  };

  const contractDraftGeneratePdf: ToolHandler = async ({ context, payload }) => {
    const input = contractDraftGeneratePdfSchema.parse(payload);
    const quote = await prisma.quote.findFirst({
      where: {
        id: input.quoteId,
        orgId: context.orgId,
      },
    });
    if (!quote) {
      throw new Error('Quote not found');
    }

    const metadata = jsonObject(quote.metadata);
    const workflow = unknownObject(metadata.contractWorkflow);
    const drafts = unknownObjectArray(workflow.drafts);
    const targetDraftId =
      toStringOrNull(input.draftId) ??
      toStringOrNull(workflow.lastDraftId) ??
      toStringOrNull(drafts[drafts.length - 1]?.draftId);
    if (!targetDraftId) {
      throw new Error('No contract draft found for quote');
    }

    const targetIndex = drafts.findIndex((draft) => toStringOrNull(draft.draftId) === targetDraftId);
    if (targetIndex < 0) {
      throw new Error('Contract draft not found');
    }

    const requestId = toStringOrNull(input.requestId);
    const existingDraft = drafts[targetIndex];
    const existingPdfUrl = toStringOrNull(existingDraft.pdfUrl);
    if (
      requestId &&
      toStringOrNull(existingDraft.pdfRequestId) === requestId &&
      existingPdfUrl
    ) {
      return jsonResult({
        quoteId: quote.id,
        draftId: targetDraftId,
        pdfUrl: existingPdfUrl,
        idempotent: true,
      });
    }

    const pdfUrl = `/api/quotes/${quote.id}/print?draftId=${targetDraftId}`;
    const updatedDraft = {
      ...existingDraft,
      pdfUrl,
      pdfGeneratedAt: new Date().toISOString(),
      pdfRequestId: requestId,
    };
    const updatedDrafts = drafts.map((draft, index) =>
      index === targetIndex ? updatedDraft : draft,
    );

    await prisma.quote.update({
      where: { id: quote.id },
      data: {
        metadata: toInputJson({
          ...metadata,
          contractWorkflow: {
            ...workflow,
            drafts: updatedDrafts,
          },
        }),
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'contract.draft.pdf_generated',
      payload: toInputJson({
        quoteId: quote.id,
        draftId: targetDraftId,
        pdfUrl,
        requestId,
      }),
    });

    return jsonResult({
      quoteId: quote.id,
      draftId: targetDraftId,
      pdfUrl,
      idempotent: false,
    });
  };

  const contractSignatureEnvelopeCreateForQuote: ToolHandler = async ({ context, payload }) => {
    const input = contractSignatureEnvelopeCreateSchema.parse(payload);
    const quote = await prisma.quote.findFirst({
      where: {
        id: input.quoteId,
        orgId: context.orgId,
      },
      include: {
        customer: true,
        lead: true,
      },
    });
    if (!quote) {
      throw new Error('Quote not found');
    }

    const metadata = jsonObject(quote.metadata);
    const workflow = unknownObject(metadata.contractWorkflow);
    const drafts = unknownObjectArray(workflow.drafts);
    const envelopes = unknownObjectArray(workflow.envelopes);
    const requestId = toStringOrNull(input.requestId);
    if (requestId) {
      const existing = envelopes.find((envelope) => toStringOrNull(envelope.requestId) === requestId);
      if (existing) {
        return jsonResult({
          quoteId: quote.id,
          envelope: existing,
          idempotent: true,
        });
      }
    }

    const targetDraftId =
      toStringOrNull(input.draftId) ??
      toStringOrNull(workflow.lastDraftId) ??
      toStringOrNull(drafts[drafts.length - 1]?.draftId);
    if (!targetDraftId) {
      throw new Error('No contract draft available for envelope creation');
    }

    const envelope = {
      envelopeId: `env_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      draftId: targetDraftId,
      requestId,
      createdAt: new Date().toISOString(),
      status: 'CREATED',
      channel: input.channel ?? 'EMAIL',
      recipientName:
        toStringOrNull(input.recipientName) ??
        quote.customer?.fullName ??
        quote.lead?.fullName ??
        'Customer',
      recipientEmail:
        toStringOrNull(input.recipientEmail) ??
        quote.customer?.email ??
        quote.lead?.email ??
        null,
    };

    await prisma.quote.update({
      where: { id: quote.id },
      data: {
        metadata: toInputJson({
          ...metadata,
          contractWorkflow: {
            ...workflow,
            envelopes: [...envelopes, envelope],
            lastEnvelopeId: envelope.envelopeId,
          },
        }),
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'contract.signature_envelope.created',
      payload: toInputJson({
        quoteId: quote.id,
        draftId: targetDraftId,
        envelopeId: envelope.envelopeId,
        requestId,
      }),
    });

    return jsonResult({
      quoteId: quote.id,
      envelope,
      idempotent: false,
    });
  };

  const contractEsignSend: ToolHandler = async ({ context, payload }) => {
    const input = contractEsignSendSchema.parse(payload);
    const quote = await prisma.quote.findFirst({
      where: {
        id: input.quoteId,
        orgId: context.orgId,
      },
    });
    if (!quote) {
      throw new Error('Quote not found');
    }

    const metadata = jsonObject(quote.metadata);
    const workflow = unknownObject(metadata.contractWorkflow);
    const envelopes = unknownObjectArray(workflow.envelopes);
    const targetEnvelopeId =
      toStringOrNull(input.envelopeId) ??
      toStringOrNull(workflow.lastEnvelopeId) ??
      toStringOrNull(envelopes[envelopes.length - 1]?.envelopeId);
    if (!targetEnvelopeId) {
      throw new Error('No signature envelope found');
    }

    const targetIndex = envelopes.findIndex((row) => toStringOrNull(row.envelopeId) === targetEnvelopeId);
    if (targetIndex < 0) {
      throw new Error('Signature envelope not found');
    }

    const requestId = toStringOrNull(input.requestId);
    const existingEnvelope = envelopes[targetIndex];
    if (toStringOrNull(existingEnvelope.status) === 'SENT') {
      return jsonResult({
        quoteId: quote.id,
        envelope: existingEnvelope,
        idempotent: true,
      });
    }
    if (
      requestId &&
      toStringOrNull(existingEnvelope.sendRequestId) === requestId
    ) {
      return jsonResult({
        quoteId: quote.id,
        envelope: existingEnvelope,
        idempotent: true,
      });
    }

    const updatedEnvelope = {
      ...existingEnvelope,
      status: 'SENT',
      sentAt: new Date().toISOString(),
      sendRequestId: requestId,
    };
    const updatedEnvelopes = envelopes.map((row, index) =>
      index === targetIndex ? updatedEnvelope : row,
    );

    await prisma.quote.update({
      where: { id: quote.id },
      data: {
        metadata: toInputJson({
          ...metadata,
          contractWorkflow: {
            ...workflow,
            envelopes: updatedEnvelopes,
            lastEnvelopeId: targetEnvelopeId,
          },
        }),
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'contract.esign.sent',
      payload: toInputJson({
        quoteId: quote.id,
        envelopeId: targetEnvelopeId,
        requestId,
      }),
    });

    return jsonResult({
      quoteId: quote.id,
      envelope: updatedEnvelope,
      idempotent: false,
    });
  };

  const contractFinalizeFromQuote: ToolHandler = async ({ context, payload }) => {
    const input = contractFinalizeFromQuoteSchema.parse(payload);
    const quote = await prisma.quote.findFirst({
      where: {
        id: input.quoteId,
        orgId: context.orgId,
      },
    });
    if (!quote) {
      throw new Error('Quote not found');
    }
    if (quote.status !== 'ACCEPTED') {
      raiseToolError(
        'CONTRACT_QUOTE_NOT_ACCEPTED',
        'Quote must be ACCEPTED before finalizing a contract',
        true,
      );
    }

    const metadata = jsonObject(quote.metadata);
    const workflow = unknownObject(metadata.contractWorkflow);
    const existingFinalized = unknownObject(workflow.finalized);
    const requestId = toStringOrNull(input.requestId);
    if (
      toStringOrNull(existingFinalized.contractId) &&
      (!requestId || toStringOrNull(existingFinalized.requestId) === requestId)
    ) {
      return jsonResult({
        quoteId: quote.id,
        contract: existingFinalized,
        idempotent: true,
      });
    }

    const contract = {
      contractId: toStringOrNull(existingFinalized.contractId) ?? `ctr_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      quoteId: quote.id,
      envelopeId: toStringOrNull(input.envelopeId) ?? toStringOrNull(workflow.lastEnvelopeId),
      finalizedAt: new Date().toISOString(),
      finalizedByType: context.actorType,
      finalizedByUserId: context.actorUserId ?? null,
      requestId,
      notes: toStringOrNull(input.notes),
    };

    await prisma.quote.update({
      where: { id: quote.id },
      data: {
        metadata: toInputJson({
          ...metadata,
          contractWorkflow: {
            ...workflow,
            finalized: contract,
          },
        }),
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'contract.finalized',
      payload: toInputJson({
        contractId: contract.contractId,
        quoteId: quote.id,
        envelopeId: contract.envelopeId,
        requestId,
      }),
    });

    return jsonResult({
      quoteId: quote.id,
      contract,
      idempotent: false,
    });
  };

  const contractRedlineGenerate: ToolHandler = async ({ context, payload }) => {
    const input = contractRedlineGenerateSchema.parse(payload);
    let baselineText = input.baselineText ?? '';
    let proposedText = input.proposedText ?? '';

    if (input.quoteId && (!baselineText || !proposedText)) {
      const quote = await prisma.quote.findFirst({
        where: {
          id: input.quoteId,
          orgId: context.orgId,
        },
        include: {
          lineItems: {
            orderBy: { sortOrder: 'asc' },
          },
          options: {
            orderBy: { createdAt: 'asc' },
          },
        },
      });
      if (!quote) {
        throw new Error('Quote not found');
      }

      if (!baselineText) {
        baselineText = quote.lineItems
          .map((item) => `${item.nameSnapshot}: ${item.lineTotalCents}`)
          .join('\n');
      }
      if (!proposedText) {
        const selected = quote.options[0];
        proposedText = selected
          ? `Option ${selected.optionKey}: ${selected.finalSellPriceCents}\n${selected.label ?? ''}`
          : baselineText;
      }
    }

    const baselineLines = baselineText.split(/\r?\n/).map((line) => line.trim());
    const proposedLines = proposedText.split(/\r?\n/).map((line) => line.trim());
    const maxLength = Math.max(baselineLines.length, proposedLines.length);
    const sectionChanges: Array<{
      lineNumber: number;
      before: string | null;
      after: string | null;
    }> = [];

    for (let index = 0; index < maxLength; index += 1) {
      const before = baselineLines[index] ?? null;
      const after = proposedLines[index] ?? null;
      if (before === after) {
        continue;
      }
      sectionChanges.push({
        lineNumber: index + 1,
        before,
        after,
      });
    }

    const changedText = sectionChanges
      .map((row) => `${row.before ?? ''} ${row.after ?? ''}`.trim())
      .join(' ')
      .toLowerCase();
    const riskTags: string[] = [];
    if (changedText.includes('payment')) riskTags.push('PAYMENT_TERMS');
    if (changedText.includes('liability')) riskTags.push('LIABILITY');
    if (changedText.includes('termination')) riskTags.push('TERMINATION');
    if (changedText.includes('warranty')) riskTags.push('WARRANTY');

    return jsonResult({
      requestId: toStringOrNull(input.requestId),
      diffSummary: `Detected ${sectionChanges.length} changed line${sectionChanges.length === 1 ? '' : 's'}.`,
      sectionChanges,
      riskTags,
      references: parseContractReferences(proposedText),
    });
  };

  const contractReferencesExtract: ToolHandler = async ({ context, payload }) => {
    const input = contractReferencesExtractSchema.parse(payload);
    let text = input.text ?? '';

    if (!text && input.quoteId) {
      const quote = await prisma.quote.findFirst({
        where: {
          id: input.quoteId,
          orgId: context.orgId,
        },
        include: {
          lineItems: {
            orderBy: { sortOrder: 'asc' },
          },
        },
      });
      if (!quote) {
        throw new Error('Quote not found');
      }
      text = quote.lineItems
        .map((line) => `${line.nameSnapshot} ${line.descriptionSnapshot ?? ''}`)
        .join('\n');
    }

    const references = parseContractReferences(text);
    return jsonResult({
      references,
      count: references.length,
    });
  };

  const createJobFromQuoteTx = async (args: {
    tx: Prisma.TransactionClient;
    orgId: string;
    quoteId: string;
    title?: string | null;
    scheduledAt?: Date | null;
    addressLine1?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
  }) => {
    const quote = await args.tx.quote.findFirst({
      where: {
        id: args.quoteId,
        orgId: args.orgId,
      },
      include: {
        lead: true,
      },
    });
    if (!quote) {
      throw new Error('Quote not found');
    }

    const existingJob = await args.tx.job.findFirst({
      where: {
        orgId: args.orgId,
        quoteId: quote.id,
      },
    });
    if (existingJob) {
      return {
        quote,
        job: existingJob,
        customerId: existingJob.customerId ?? quote.customerId,
        created: false,
      };
    }

    let customerId = quote.customerId;
    if (!customerId && quote.lead) {
      const matchedCustomer = await args.tx.customer.findFirst({
        where: {
          orgId: args.orgId,
          OR: [
            ...(quote.lead.email ? [{ email: quote.lead.email }] : []),
            ...(quote.lead.phone ? [{ phone: quote.lead.phone }] : []),
            { fullName: quote.lead.fullName },
          ],
        },
        orderBy: { createdAt: 'asc' },
      });
      if (matchedCustomer) {
        customerId = matchedCustomer.id;
      } else {
        const createdCustomer = await args.tx.customer.create({
          data: {
            orgId: args.orgId,
            fullName: quote.lead.fullName,
            email: quote.lead.email,
            phone: quote.lead.phone,
            addressLine1: args.addressLine1,
            city: args.city,
            state: args.state,
            postalCode: args.postalCode,
          },
        });
        customerId = createdCustomer.id;
      }

      await args.tx.quote.update({
        where: { id: quote.id },
        data: { customerId },
      });
    }

    const title =
      toStringOrNull(args.title) ??
      ((quote.kind === QuoteKind.INSTALL ? 'Install' : 'Service') + ' quote ' + quote.id.slice(-6));

    const createdJob = await args.tx.job.create({
      data: {
        orgId: args.orgId,
        quoteId: quote.id,
        customerId,
        title,
        status: 'OPEN',
        scheduledAt: args.scheduledAt ?? null,
      },
    });

    return {
      quote,
      job: createdJob,
      customerId,
      created: true,
    };
  };

  const jobCreateFromQuote: ToolHandler = async ({ context, payload }) => {
    const input = jobCreateFromQuoteSchema.parse(payload);
    const scheduledAt = toDateOrNull(input.scheduledAt);

    const result = await prisma.$transaction((tx) =>
      createJobFromQuoteTx({
        tx,
        orgId: context.orgId,
        quoteId: input.quoteId,
        title: toStringOrNull(input.title),
        scheduledAt,
        addressLine1: toStringOrNull(input.addressLine1),
        city: toStringOrNull(input.city),
        state: toStringOrNull(input.state),
        postalCode: toStringOrNull(input.postalCode),
      }),
    );

    const jobGeo = await ensureJobGeoForJob({
      orgId: context.orgId,
      jobId: result.job.id,
      customerId: result.customerId ?? undefined,
      addressLine1: toStringOrNull(input.addressLine1),
      city: toStringOrNull(input.city),
      state: toStringOrNull(input.state),
      postalCode: toStringOrNull(input.postalCode),
    });

    await prisma.job.update({
      where: { id: result.job.id },
      data: {
        jobLatitude: jobGeo.lat,
        jobLongitude: jobGeo.lng,
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'job.created',
      payload: toInputJson({
        quoteId: result.quote.id,
        jobId: result.job.id,
        customerId: result.customerId,
      }),
    });

    return jsonResult({
      quoteId: result.quote.id,
      job: result.job,
      created: result.created,
      jobGeo,
    });
  };

  const schedulingSettingsUpdate: ToolHandler = async ({ context, payload }) => {
    const input = schedulingSettingsUpdateSchema.parse(payload);
    await ensureSchedulingBootstrap(context.orgId);

    const updated = await prisma.orgSchedulingSettings.update({
      where: { orgId: context.orgId },
      data: {
        ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
        ...(input.defaultServiceCapacityPerBlock === undefined ? {} : { defaultServiceCapacityPerBlock: input.defaultServiceCapacityPerBlock }),
        ...(input.defaultInstallCapacityPerBlock === undefined ? {} : { defaultInstallCapacityPerBlock: input.defaultInstallCapacityPerBlock }),
        ...(input.throttleServiceCapacityPerBlock === undefined ? {} : { throttleServiceCapacityPerBlock: input.throttleServiceCapacityPerBlock }),
        ...(input.throttleInstallCapacityPerBlock === undefined ? {} : { throttleInstallCapacityPerBlock: input.throttleInstallCapacityPerBlock }),
        ...(input.throttleServiceEnabled === undefined ? {} : { throttleServiceEnabled: input.throttleServiceEnabled }),
        ...(input.throttleInstallEnabled === undefined ? {} : { throttleInstallEnabled: input.throttleInstallEnabled }),
        ...(input.serviceBookingAllowedAt === undefined ? {} : { serviceBookingAllowedAt: input.serviceBookingAllowedAt as QuoteBookingTriggerStatus }),
        ...(input.installBookingAllowedAt === undefined ? {} : { installBookingAllowedAt: input.installBookingAllowedAt as QuoteBookingTriggerStatus }),
      },
    });

    return jsonResult({ settings: updated });
  };

  const schedulingBlocksListAvailability: ToolHandler = async ({ context, payload }) => {
    const input = schedulingListAvailabilitySchema.parse(payload);
    const startDate = parseDateOnly(input.startDate);
    const endDate = parseDateOnly(input.endDate);
    if (endDate.getTime() < startDate.getTime()) {
      throw new Error('endDate must be >= startDate');
    }

    const daySpan = Math.floor((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)) + 1;
    if (daySpan > 60) {
      throw new Error('dateRange cannot exceed 60 days');
    }

    const settings = await ensureSchedulingBootstrap(context.orgId);
    const [blocks, businessHours, blackoutDates, reservations] = await Promise.all([
      prisma.timeBlockTemplate.findMany({
        where: { orgId: context.orgId, active: true },
        orderBy: { startTime: 'asc' },
      }),
      prisma.businessHours.findMany({
        where: { orgId: context.orgId },
      }),
      prisma.blackoutDate.findMany({
        where: {
          orgId: context.orgId,
          startAt: { lte: new Date(endDate.getTime() + 24 * 60 * 60 * 1000 - 1) },
          endAt: { gte: startDate },
        },
      }),
      prisma.appointmentReservation.findMany({
        where: {
          orgId: context.orgId,
          type: input.type as AppointmentType,
          date: {
            gte: startDate,
            lte: endDate,
          },
        },
      }),
    ]);

    const hoursByDay = new Map<number, (typeof businessHours)[number]>();
    for (const row of businessHours) {
      hoursByDay.set(row.dayOfWeek, row);
    }

    const reservationByKey = new Map<string, (typeof reservations)[number]>();
    for (const row of reservations) {
      reservationByKey.set(toDateKey(row.date) + '|' + row.timeBlockCode, row);
    }

    const targetType = input.type as AppointmentType;
    const capacity = resolveCapacity(settings, targetType);
    const days = listDateRange(startDate, endDate).map((date) => {
      const dateKey = toDateKey(date);
      const dayOfWeek = date.getUTCDay();
      const hours = hoursByDay.get(dayOfWeek);
      const isClosed = !hours || hours.isClosed;

      const overlapsBlackout = blackoutDates.some((blackout) =>
        blackout.startAt.getTime() <= date.getTime() + 24 * 60 * 60 * 1000 - 1 && blackout.endAt.getTime() >= date.getTime(),
      );

      const blockRows = blocks.map((block) => {
        const withinHours = !isClosed && Boolean(hours) && block.startTime >= hours!.openTime && block.endTime <= hours!.closeTime;
        const key = dateKey + '|' + block.code;
        const reserved = reservationByKey.get(key);
        const booked = reserved?.reservedCount ?? 0;
        const limit = reserved?.capacity ?? capacity;
        const remaining = Math.max(limit - booked, 0);
        const available = withinHours && !overlapsBlackout && remaining > 0;
        return {
          code: block.code,
          startTime: block.startTime,
          endTime: block.endTime,
          capacity: limit,
          booked,
          remaining,
          available,
          reason: !withinHours
            ? 'Outside business hours'
            : overlapsBlackout
              ? 'Blackout date'
              : remaining === 0
                ? 'At capacity'
                : null,
        };
      });

      return {
        date: dateKey,
        closed: isClosed,
        blackout: overlapsBlackout,
        blocks: blockRows,
      };
    });

    return jsonResult({
      type: targetType,
      settings: {
        timezone: settings.timezone,
        throttleServiceEnabled: settings.throttleServiceEnabled,
        throttleInstallEnabled: settings.throttleInstallEnabled,
      },
      days,
    });
  };

  const schedulingAppointmentBookFromToken: ToolHandler = async ({ context, payload }) => {
    const input = schedulingBookFromTokenSchema.parse(payload);
    const bookingDate = parseDateOnly(input.date);
    const settings = await ensureSchedulingBootstrap(context.orgId);

    const quote = await prisma.quote.findFirst({
      where: {
        orgId: context.orgId,
        publicToken: input.quoteToken,
      },
      include: {
        lead: true,
      },
    });
    if (!quote) {
      throw new Error('Quote token not found');
    }

    const requiredStatus = bookingTriggerForQuoteKind(settings, quote.kind);
    if (!isQuoteStatusEligibleForBooking(quote.status, requiredStatus)) {
      throw new Error(buildBookingValidationError(requiredStatus, quote.status, quote.kind));
    }

    const appointmentType =
      quote.kind === QuoteKind.INSTALL
        ? AppointmentType.INSTALL
        : ((input.type as AppointmentType | undefined) ?? AppointmentType.SERVICE_ESTIMATE);

    if (quote.kind === QuoteKind.INSTALL && appointmentType !== AppointmentType.INSTALL) {
      throw new Error('Install quotes can only book INSTALL appointment type');
    }

    const block = await prisma.timeBlockTemplate.findFirst({
      where: {
        orgId: context.orgId,
        code: input.timeBlockCode as TimeBlockCode,
        active: true,
      },
    });
    if (!block) {
      throw new Error('Requested time block is not active');
    }

    const dayHours = await prisma.businessHours.findFirst({
      where: {
        orgId: context.orgId,
        dayOfWeek: bookingDate.getUTCDay(),
      },
    });
    const withinHours =
      Boolean(dayHours) && !dayHours!.isClosed && block.startTime >= dayHours!.openTime && block.endTime <= dayHours!.closeTime;
    if (!withinHours) {
      throw new Error('Requested block is outside business hours');
    }

    const blackout = await prisma.blackoutDate.findFirst({
      where: {
        orgId: context.orgId,
        startAt: { lte: new Date(bookingDate.getTime() + 24 * 60 * 60 * 1000 - 1) },
        endAt: { gte: bookingDate },
      },
    });
    if (blackout) {
      throw new Error('Requested date is blocked by blackout');
    }

    const capacity = resolveCapacity(settings, appointmentType);
    const scheduledAt = toScheduledAtForBlock(bookingDate, block.startTime);

    const created = await prisma.$transaction(async (tx) => {
      const jobResult = await createJobFromQuoteTx({
        tx,
        orgId: context.orgId,
        quoteId: quote.id,
        scheduledAt,
      });

      const reservation = await tx.appointmentReservation.upsert({
        where: {
          orgId_date_timeBlockCode_type: {
            orgId: context.orgId,
            date: bookingDate,
            timeBlockCode: input.timeBlockCode as TimeBlockCode,
            type: appointmentType,
          },
        },
        update: {
          capacity,
        },
        create: {
          orgId: context.orgId,
          date: bookingDate,
          timeBlockCode: input.timeBlockCode as TimeBlockCode,
          type: appointmentType,
          capacity,
          reservedCount: 0,
        },
      });

      const increment = await tx.appointmentReservation.updateMany({
        where: {
          id: reservation.id,
          reservedCount: { lt: capacity },
        },
        data: {
          reservedCount: { increment: 1 },
          capacity,
        },
      });
      if (increment.count === 0) {
        throw new Error('Requested block is already at capacity');
      }

      const appointment = await tx.appointment.create({
        data: {
          orgId: context.orgId,
          quoteId: quote.id,
          jobId: jobResult.job.id,
          customerId: jobResult.customerId,
          type: appointmentType,
          date: bookingDate,
          timeBlockCode: input.timeBlockCode as TimeBlockCode,
          status: AppointmentStatus.BOOKED,
          notes: toStringOrNull(input.notes),
        },
      });

      const job = await tx.job.update({
        where: { id: jobResult.job.id },
        data: {
          status: 'BOOKED',
          scheduledAt,
        },
      });

      return { appointment, job, customerId: jobResult.customerId };
    });

    const jobGeo = await ensureJobGeoForJob({
      orgId: context.orgId,
      jobId: created.job.id,
      customerId: created.customerId ?? undefined,
    });
    await prisma.job.update({
      where: { id: created.job.id },
      data: {
        jobLatitude: jobGeo.lat,
        jobLongitude: jobGeo.lng,
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'appointment.booked',
      payload: toInputJson({
        appointmentId: created.appointment.id,
        quoteId: quote.id,
        jobId: created.job.id,
        date: toDateKey(bookingDate),
        timeBlockCode: input.timeBlockCode,
        type: appointmentType,
      }),
    });

    return jsonResult({
      appointment: created.appointment,
      job: created.job,
      jobGeo,
    });
  };

  const schedulingAppointmentReschedule: ToolHandler = async ({ context, payload }) => {
    const input = appointmentRescheduleSchema.parse(payload);
    const bookingDate = parseDateOnly(input.date);
    const settings = await ensureSchedulingBootstrap(context.orgId);

    const appointment = await prisma.appointment.findFirst({
      where: {
        id: input.appointmentId,
        orgId: context.orgId,
      },
    });
    if (!appointment) {
      throw new Error('Appointment not found');
    }
    if (appointment.status === AppointmentStatus.CANCELED) {
      throw new Error('Cannot reschedule a canceled appointment');
    }

    const block = await prisma.timeBlockTemplate.findFirst({
      where: {
        orgId: context.orgId,
        code: input.timeBlockCode as TimeBlockCode,
        active: true,
      },
    });
    if (!block) {
      throw new Error('Requested time block is not active');
    }

    const dayHours = await prisma.businessHours.findFirst({
      where: {
        orgId: context.orgId,
        dayOfWeek: bookingDate.getUTCDay(),
      },
    });
    const withinHours =
      Boolean(dayHours) && !dayHours!.isClosed && block.startTime >= dayHours!.openTime && block.endTime <= dayHours!.closeTime;
    if (!withinHours) {
      throw new Error('Requested block is outside business hours');
    }

    const blackout = await prisma.blackoutDate.findFirst({
      where: {
        orgId: context.orgId,
        startAt: { lte: new Date(bookingDate.getTime() + 24 * 60 * 60 * 1000 - 1) },
        endAt: { gte: bookingDate },
      },
    });
    if (blackout) {
      throw new Error('Requested date is blocked by blackout');
    }

    const capacity = resolveCapacity(settings, appointment.type);
    const scheduledAt = toScheduledAtForBlock(bookingDate, block.startTime);

    const updated = await prisma.$transaction(async (tx) => {
      if (appointment.status === AppointmentStatus.BOOKED || appointment.status === AppointmentStatus.TENTATIVE) {
        await tx.appointmentReservation.updateMany({
          where: {
            orgId: context.orgId,
            date: appointment.date,
            timeBlockCode: appointment.timeBlockCode,
            type: appointment.type,
            reservedCount: { gt: 0 },
          },
          data: { reservedCount: { decrement: 1 } },
        });
      }

      const reservation = await tx.appointmentReservation.upsert({
        where: {
          orgId_date_timeBlockCode_type: {
            orgId: context.orgId,
            date: bookingDate,
            timeBlockCode: input.timeBlockCode as TimeBlockCode,
            type: appointment.type,
          },
        },
        update: { capacity },
        create: {
          orgId: context.orgId,
          date: bookingDate,
          timeBlockCode: input.timeBlockCode as TimeBlockCode,
          type: appointment.type,
          capacity,
          reservedCount: 0,
        },
      });

      const increment = await tx.appointmentReservation.updateMany({
        where: { id: reservation.id, reservedCount: { lt: capacity } },
        data: { reservedCount: { increment: 1 }, capacity },
      });
      if (increment.count === 0) {
        throw new Error('Requested block is already at capacity');
      }

      const rescheduled = await tx.appointment.update({
        where: { id: appointment.id },
        data: {
          date: bookingDate,
          timeBlockCode: input.timeBlockCode as TimeBlockCode,
          status: AppointmentStatus.BOOKED,
          notes: toStringOrNull(input.notes) ?? appointment.notes,
        },
      });

      const job = appointment.jobId
        ? await tx.job.update({
            where: { id: appointment.jobId },
            data: {
              scheduledAt,
              status: 'BOOKED',
            },
          })
        : null;

      return { rescheduled, job };
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'appointment.rescheduled',
      payload: toInputJson({
        appointmentId: updated.rescheduled.id,
        date: toDateKey(updated.rescheduled.date),
        timeBlockCode: updated.rescheduled.timeBlockCode,
        jobId: updated.rescheduled.jobId,
      }),
    });

    return jsonResult({
      appointment: updated.rescheduled,
      job: updated.job,
    });
  };

  const schedulingAppointmentCancel: ToolHandler = async ({ context, payload }) => {
    const input = appointmentCancelSchema.parse(payload);
    const appointment = await prisma.appointment.findFirst({
      where: {
        id: input.appointmentId,
        orgId: context.orgId,
      },
    });
    if (!appointment) {
      throw new Error('Appointment not found');
    }

    const updated = await prisma.$transaction(async (tx) => {
      const canceled = await tx.appointment.update({
        where: { id: appointment.id },
        data: {
          status: AppointmentStatus.CANCELED,
          notes:
            toStringOrNull(input.reason)
              ? ((appointment.notes ?? '') + (appointment.notes ? '\n' : '') + 'Canceled: ' + String(input.reason))
              : appointment.notes,
        },
      });

      await tx.appointmentReservation.updateMany({
        where: {
          orgId: context.orgId,
          date: appointment.date,
          timeBlockCode: appointment.timeBlockCode,
          type: appointment.type,
          reservedCount: { gt: 0 },
        },
        data: { reservedCount: { decrement: 1 } },
      });

      const job = appointment.jobId
        ? await tx.job.update({
            where: { id: appointment.jobId },
            data: {
              status: 'OPEN',
              scheduledAt: null,
            },
          })
        : null;

      return { canceled, job };
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'appointment.canceled',
      payload: toInputJson({
        appointmentId: updated.canceled.id,
        jobId: updated.canceled.jobId,
        reason: toStringOrNull(input.reason),
      }),
    });

    return jsonResult({
      appointment: updated.canceled,
      job: updated.job,
    });
  };

  const schedulingAppointmentListForDay: ToolHandler = async ({ context, payload }) => {
    const input = schedulingListForDaySchema.parse(payload);
    const targetDate = parseDateOnly(input.date);
    const targetDateKey = toDateKey(targetDate);
    const settings = await ensureSchedulingBootstrap(context.orgId);

    const [blocks, reservations, appointments] = await Promise.all([
      prisma.timeBlockTemplate.findMany({
        where: { orgId: context.orgId, active: true },
        orderBy: { startTime: 'asc' },
      }),
      prisma.appointmentReservation.findMany({
        where: {
          orgId: context.orgId,
          date: targetDate,
        },
      }),
      prisma.appointment.findMany({
        where: {
          orgId: context.orgId,
          date: targetDate,
          status: {
            not: AppointmentStatus.CANCELED,
          },
        },
        include: {
          quote: {
            select: {
              id: true,
              kind: true,
              status: true,
            },
          },
          customer: {
            select: {
              id: true,
              fullName: true,
              email: true,
              phone: true,
              addressLine1: true,
              city: true,
              state: true,
              postalCode: true,
            },
          },
          job: {
            select: {
              id: true,
              title: true,
              status: true,
              assignedToUserId: true,
            },
          },
          assignedTech: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
        orderBy: [{ timeBlockCode: 'asc' }, { createdAt: 'asc' }],
      }),
    ]);

    const reservationByTypeAndBlock = new Map<string, (typeof reservations)[number]>();
    for (const reservation of reservations) {
      reservationByTypeAndBlock.set(`${reservation.type}|${reservation.timeBlockCode}`, reservation);
    }

    const appointmentsByBlock = new Map<string, (typeof appointments)>();
    for (const appointment of appointments) {
      const key = appointment.timeBlockCode;
      const existing = appointmentsByBlock.get(key) ?? [];
      existing.push(appointment);
      appointmentsByBlock.set(key, existing);
    }

    const installCapacity = resolveCapacity(settings, AppointmentType.INSTALL);
    const serviceCapacity = resolveCapacity(settings, AppointmentType.SERVICE_ESTIMATE);

    const blockRows = blocks.map((block) => {
      const installReservation = reservationByTypeAndBlock.get(`${AppointmentType.INSTALL}|${block.code}`);
      const serviceReservation = reservationByTypeAndBlock.get(`${AppointmentType.SERVICE_ESTIMATE}|${block.code}`);

      const installBooked = installReservation?.reservedCount ?? 0;
      const serviceBooked = serviceReservation?.reservedCount ?? 0;
      const installLimit = installReservation?.capacity ?? installCapacity;
      const serviceLimit = serviceReservation?.capacity ?? serviceCapacity;

      const blockAppointments = appointmentsByBlock.get(block.code) ?? [];
      const installAppointments = blockAppointments.filter((appointment) => appointment.type === AppointmentType.INSTALL);
      const serviceAppointments = blockAppointments.filter((appointment) => appointment.type === AppointmentType.SERVICE_ESTIMATE);

      return {
        code: block.code,
        startTime: block.startTime,
        endTime: block.endTime,
        install: {
          capacity: installLimit,
          reservedCount: installBooked,
          remaining: Math.max(installLimit - installBooked, 0),
          appointments: installAppointments,
        },
        serviceEstimate: {
          capacity: serviceLimit,
          reservedCount: serviceBooked,
          remaining: Math.max(serviceLimit - serviceBooked, 0),
          appointments: serviceAppointments,
        },
      };
    });

    return jsonResult({
      date: targetDateKey,
      settings: {
        timezone: settings.timezone,
        defaultServiceCapacityPerBlock: settings.defaultServiceCapacityPerBlock,
        defaultInstallCapacityPerBlock: settings.defaultInstallCapacityPerBlock,
        throttleServiceCapacityPerBlock: settings.throttleServiceCapacityPerBlock,
        throttleInstallCapacityPerBlock: settings.throttleInstallCapacityPerBlock,
        throttleServiceEnabled: settings.throttleServiceEnabled,
        throttleInstallEnabled: settings.throttleInstallEnabled,
      },
      blocks: blockRows,
    });
  };

  const schedulingAppointmentAssignTech: ToolHandler = async ({ context, payload }) => {
    const input = appointmentAssignTechSchema.parse(payload);

    const [appointment, tech] = await Promise.all([
      prisma.appointment.findFirst({
        where: {
          id: input.appointmentId,
          orgId: context.orgId,
        },
      }),
      prisma.user.findFirst({
        where: {
          id: input.techUserId,
          orgId: context.orgId,
          isActive: true,
        },
        select: {
          id: true,
          name: true,
          email: true,
        },
      }),
    ]);

    if (!appointment) {
      throw new Error('Appointment not found');
    }
    if (!tech) {
      throw new Error('Technician user not found');
    }

    const updated = await prisma.$transaction(async (tx) => {
      const nextAppointment = await tx.appointment.update({
        where: { id: appointment.id },
        data: {
          assignedTechId: tech.id,
        },
      });

      const nextJob = appointment.jobId
        ? await tx.job.update({
            where: { id: appointment.jobId },
            data: {
              assignedToUserId: tech.id,
              status: 'ASSIGNED',
            },
          })
        : null;

      return {
        appointment: nextAppointment,
        job: nextJob,
      };
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'appointment.assigned_tech',
      payload: toInputJson({
        appointmentId: updated.appointment.id,
        jobId: updated.appointment.jobId,
        techUserId: tech.id,
      }),
    });

    return jsonResult({
      appointment: updated.appointment,
      job: updated.job,
      tech,
    });
  };

  const timeClockIn: ToolHandler = async ({ context, payload }) => {
    const input = timeClockInSchema.parse(payload);
    const actorUserId = await resolveActorUserId(context.orgId, context.actorUserId);
    const now = new Date();

    const openShifts = await prisma.timeEntry.findMany({
      where: {
        orgId: context.orgId,
        userId: actorUserId,
        type: TimeEntryType.SHIFT,
        status: TimeEntryStatus.OPEN,
      },
      orderBy: { startedAt: 'desc' },
      take: 2,
    });

    if (openShifts.length > 1) {
      raiseToolError(
        'TIME_MULTIPLE_OPEN_SHIFTS',
        'Multiple open shifts detected. Contact dispatch/admin to fix time records.',
        false,
      );
    }

    const openShift = openShifts[0];
    if (openShift) {
      return jsonResult({
        timeEntry: openShift,
        alreadyOpen: true,
      });
    }

    const created = await prisma.timeEntry.create({
      data: {
        orgId: context.orgId,
        userId: actorUserId,
        type: TimeEntryType.SHIFT,
        startedAt: now,
        startedAtLocal: toStringOrNull(input.startedAtLocal),
        timezoneOffsetMinutes:
          typeof input.timezoneOffsetMinutes === 'number'
            ? input.timezoneOffsetMinutes
            : null,
        notes: toStringOrNull(input.notes),
        status: TimeEntryStatus.OPEN,
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'time.clocked_in',
      payload: toInputJson({
        timeEntryId: created.id,
        userId: actorUserId,
        startedAt: created.startedAt.toISOString(),
      }),
    });

    return jsonResult({
      timeEntry: created,
      alreadyOpen: false,
    });
  };

  const timeClockOut: ToolHandler = async ({ context, payload }) => {
    const input = timeClockOutSchema.parse(payload);
    const actorUserId = await resolveActorUserId(context.orgId, context.actorUserId);
    const now = new Date();

    const closed = await prisma.$transaction(async (tx) => {
      const openShifts = await tx.timeEntry.findMany({
        where: {
          orgId: context.orgId,
          userId: actorUserId,
          type: TimeEntryType.SHIFT,
          status: TimeEntryStatus.OPEN,
        },
        orderBy: { startedAt: 'desc' },
        take: 2,
      });
      if (openShifts.length === 0) {
        raiseToolError(
          'TIME_NO_OPEN_SHIFT',
          'No open shift found to clock out.',
          true,
        );
      }
      if (openShifts.length > 1) {
        raiseToolError(
          'TIME_MULTIPLE_OPEN_SHIFTS',
          'Multiple open shifts detected. Contact dispatch/admin to fix time records.',
          false,
        );
      }
      const openShift = openShifts[0];

      const [openJobs, openBreaks] = await Promise.all([
        tx.timeEntry.findMany({
          where: {
            orgId: context.orgId,
            userId: actorUserId,
            type: TimeEntryType.JOB,
            status: TimeEntryStatus.OPEN,
          },
          orderBy: { startedAt: 'asc' },
        }),
        tx.timeEntry.findMany({
          where: {
            orgId: context.orgId,
            userId: actorUserId,
            type: TimeEntryType.BREAK,
            status: TimeEntryStatus.OPEN,
          },
          orderBy: { startedAt: 'asc' },
        }),
      ]);

      const autoStoppedJobs: string[] = [];
      for (const entry of openJobs) {
        const updated = await tx.timeEntry.update({
          where: { id: entry.id },
          data: {
            endedAt: now,
            endedAtLocal: toStringOrNull(input.endedAtLocal),
            timezoneOffsetMinutes:
              typeof input.timezoneOffsetMinutes === 'number'
                ? input.timezoneOffsetMinutes
                : entry.timezoneOffsetMinutes,
            notes: entry.notes,
            status: TimeEntryStatus.CLOSED,
          },
        });
        autoStoppedJobs.push(updated.id);

        await tx.auditLog.create({
          data: {
            orgId: context.orgId,
            actorType: context.actorType,
            actorUserId: actorUserId,
            action: 'TIME_AUTO_STOP_JOB_ON_CLOCK_OUT',
            entityType: 'TimeEntry',
            entityId: updated.id,
            metadata: toInputJson({
              userId: actorUserId,
              jobId: updated.jobId,
              startedAt: updated.startedAt.toISOString(),
              endedAt: now.toISOString(),
              reason: 'Auto-stopped open job during shift clock-out',
            }),
          },
        });

        await enqueueOutbox(tx, {
          orgId: context.orgId,
          eventType: 'time.job.autostopped',
          payload: toInputJson({
            timeEntryId: updated.id,
            userId: actorUserId,
            jobId: updated.jobId,
            endedAt: now.toISOString(),
            source: 'time.clockOut',
          }),
        });
      }

      const autoStoppedBreaks: string[] = [];
      for (const entry of openBreaks) {
        const updated = await tx.timeEntry.update({
          where: { id: entry.id },
          data: {
            endedAt: now,
            endedAtLocal: toStringOrNull(input.endedAtLocal),
            timezoneOffsetMinutes:
              typeof input.timezoneOffsetMinutes === 'number'
                ? input.timezoneOffsetMinutes
                : entry.timezoneOffsetMinutes,
            notes: entry.notes,
            status: TimeEntryStatus.CLOSED,
          },
        });
        autoStoppedBreaks.push(updated.id);

        await tx.auditLog.create({
          data: {
            orgId: context.orgId,
            actorType: context.actorType,
            actorUserId: actorUserId,
            action: 'TIME_AUTO_STOP_BREAK_ON_CLOCK_OUT',
            entityType: 'TimeEntry',
            entityId: updated.id,
            metadata: toInputJson({
              userId: actorUserId,
              startedAt: updated.startedAt.toISOString(),
              endedAt: now.toISOString(),
              reason: 'Auto-stopped open break during shift clock-out',
            }),
          },
        });

        await enqueueOutbox(tx, {
          orgId: context.orgId,
          eventType: 'time.break.autostopped',
          payload: toInputJson({
            timeEntryId: updated.id,
            userId: actorUserId,
            endedAt: now.toISOString(),
            source: 'time.clockOut',
          }),
        });
      }

      const nextNotes = [
        openShift.notes,
        toStringOrNull(input.notes),
      ]
        .filter((value): value is string => Boolean(value))
        .join('\n')
        .trim();

      const shift = await tx.timeEntry.update({
        where: { id: openShift.id },
        data: {
          endedAt: now,
          endedAtLocal: toStringOrNull(input.endedAtLocal),
          timezoneOffsetMinutes:
            typeof input.timezoneOffsetMinutes === 'number'
              ? input.timezoneOffsetMinutes
              : openShift.timezoneOffsetMinutes,
          notes: nextNotes.length > 0 ? nextNotes : null,
          status: TimeEntryStatus.CLOSED,
        },
      });

      return {
        shift,
        closedJobs: autoStoppedJobs.length,
        closedBreaks: autoStoppedBreaks.length,
        autoStoppedJobEntryIds: autoStoppedJobs,
        autoStoppedBreakEntryIds: autoStoppedBreaks,
      };
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'time.clocked_out',
      payload: toInputJson({
        timeEntryId: closed.shift.id,
        userId: actorUserId,
        endedAt: closed.shift.endedAt?.toISOString() ?? null,
        closedJobs: closed.closedJobs,
        closedBreaks: closed.closedBreaks,
        autoStoppedJobEntryIds: closed.autoStoppedJobEntryIds,
        autoStoppedBreakEntryIds: closed.autoStoppedBreakEntryIds,
      }),
    });

    return jsonResult(closed);
  };

  const timeBreakStart: ToolHandler = async ({ context, payload }) => {
    const input = timeBreakStartSchema.parse(payload);
    const actorUserId = await resolveActorUserId(context.orgId, context.actorUserId);
    const now = new Date();

    const created = await prisma.$transaction(async (tx) => {
      const openShift = await tx.timeEntry.findFirst({
        where: {
          orgId: context.orgId,
          userId: actorUserId,
          type: TimeEntryType.SHIFT,
          status: TimeEntryStatus.OPEN,
        },
      });
      if (!openShift) {
        raiseToolError(
          'TIME_NO_OPEN_SHIFT',
          'Cannot start break without an open shift.',
          true,
        );
      }

      const existingBreak = await tx.timeEntry.findFirst({
        where: {
          orgId: context.orgId,
          userId: actorUserId,
          type: TimeEntryType.BREAK,
          status: TimeEntryStatus.OPEN,
        },
      });
      if (existingBreak) {
        raiseToolError(
          'TIME_BREAK_ALREADY_OPEN',
          'Break already in progress.',
          true,
        );
      }

      const openJob = await tx.timeEntry.findFirst({
        where: {
          orgId: context.orgId,
          userId: actorUserId,
          type: TimeEntryType.JOB,
          status: TimeEntryStatus.OPEN,
        },
      });
      if (openJob) {
        raiseToolError(
          'TIME_BREAK_JOB_CONFLICT',
          'Stop the active job timer before starting a break.',
          true,
        );
      }

      const breakEntry = await tx.timeEntry.create({
        data: {
          orgId: context.orgId,
          userId: actorUserId,
          type: TimeEntryType.BREAK,
          startedAt: now,
          startedAtLocal: toStringOrNull(input.startedAtLocal),
          timezoneOffsetMinutes:
            typeof input.timezoneOffsetMinutes === 'number'
              ? input.timezoneOffsetMinutes
              : null,
          notes: toStringOrNull(input.notes),
          status: TimeEntryStatus.OPEN,
        },
      });

      return {
        breakEntry,
      };
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'time.break.started',
      payload: toInputJson({
        timeEntryId: created.breakEntry.id,
        userId: actorUserId,
        startedAt: created.breakEntry.startedAt.toISOString(),
      }),
    });

    return jsonResult(created);
  };

  const timeBreakEnd: ToolHandler = async ({ context, payload }) => {
    const input = timeBreakEndSchema.parse(payload);
    const actorUserId = await resolveActorUserId(context.orgId, context.actorUserId);
    const now = new Date();

    const openBreak = await prisma.timeEntry.findFirst({
      where: {
        orgId: context.orgId,
        userId: actorUserId,
        type: TimeEntryType.BREAK,
        status: TimeEntryStatus.OPEN,
      },
      orderBy: { startedAt: 'desc' },
    });
    if (!openBreak) {
      raiseToolError(
        'TIME_NO_OPEN_BREAK',
        'No open break found to end.',
        true,
      );
    }

    const nextNotes = [openBreak.notes, toStringOrNull(input.notes)]
      .filter((value): value is string => Boolean(value))
      .join('\n')
      .trim();

    const updated = await prisma.timeEntry.update({
      where: { id: openBreak.id },
      data: {
        endedAt: now,
        endedAtLocal: toStringOrNull(input.endedAtLocal),
        timezoneOffsetMinutes:
          typeof input.timezoneOffsetMinutes === 'number'
            ? input.timezoneOffsetMinutes
            : openBreak.timezoneOffsetMinutes,
        notes: nextNotes.length > 0 ? nextNotes : null,
        status: TimeEntryStatus.CLOSED,
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'time.break.ended',
      payload: toInputJson({
        timeEntryId: updated.id,
        userId: actorUserId,
        endedAt: updated.endedAt?.toISOString() ?? null,
      }),
    });

    return jsonResult({
      breakEntry: updated,
    });
  };

  const timeJobStart: ToolHandler = async ({ context, payload }) => {
    const input = timeJobStartSchema.parse(payload);
    const actorUserId = await resolveActorUserId(context.orgId, context.actorUserId);
    const now = new Date();

    const result = await prisma.$transaction(async (tx) => {
      const [job, openShift, openBreak, openJob] = await Promise.all([
        tx.job.findFirst({
          where: {
            id: input.jobId,
            orgId: context.orgId,
          },
          select: { id: true, status: true },
        }),
        tx.timeEntry.findFirst({
          where: {
            orgId: context.orgId,
            userId: actorUserId,
            type: TimeEntryType.SHIFT,
            status: TimeEntryStatus.OPEN,
          },
          select: { id: true },
        }),
        tx.timeEntry.findFirst({
          where: {
            orgId: context.orgId,
            userId: actorUserId,
            type: TimeEntryType.BREAK,
            status: TimeEntryStatus.OPEN,
          },
          select: { id: true },
        }),
        tx.timeEntry.findFirst({
          where: {
            orgId: context.orgId,
            userId: actorUserId,
            type: TimeEntryType.JOB,
            status: TimeEntryStatus.OPEN,
          },
          select: { id: true, jobId: true },
        }),
      ]);

      if (!job) {
        raiseToolError('TIME_JOB_NOT_FOUND', 'Job not found.', false);
      }
      if (!openShift) {
        raiseToolError(
          'TIME_NO_OPEN_SHIFT',
          'Cannot start a job timer without an open shift.',
          true,
        );
      }
      if (openBreak) {
        raiseToolError(
          'TIME_BREAK_OPEN',
          'Cannot start a job timer while a break is open.',
          true,
        );
      }
      if (openJob) {
        raiseToolError(
          'TIME_JOB_ALREADY_OPEN',
          `A job timer is already open (${openJob.jobId ?? openJob.id}). Stop it first.`,
          true,
        );
      }

      const entry = await tx.timeEntry.create({
        data: {
          orgId: context.orgId,
          userId: actorUserId,
          type: TimeEntryType.JOB,
          jobId: input.jobId,
          startedAt: now,
          startedAtLocal: toStringOrNull(input.startedAtLocal),
          timezoneOffsetMinutes:
            typeof input.timezoneOffsetMinutes === 'number'
              ? input.timezoneOffsetMinutes
              : null,
          notes: toStringOrNull(input.notes),
          status: TimeEntryStatus.OPEN,
        },
      });

      await tx.job.update({
        where: { id: input.jobId },
        data: {
          status: 'IN_PROGRESS',
        },
      });

      return {
        timeEntry: entry,
      };
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'time.job.started',
      payload: toInputJson({
        timeEntryId: result.timeEntry.id,
        jobId: result.timeEntry.jobId,
        userId: actorUserId,
        startedAt: result.timeEntry.startedAt.toISOString(),
      }),
    });

    return jsonResult(result);
  };

  const timeJobStop: ToolHandler = async ({ context, payload }) => {
    const input = timeJobStopSchema.parse(payload);
    const actorUserId = await resolveActorUserId(context.orgId, context.actorUserId);
    const now = new Date();

    const openJob = await prisma.timeEntry.findFirst({
      where: {
        orgId: context.orgId,
        userId: actorUserId,
        type: TimeEntryType.JOB,
        status: TimeEntryStatus.OPEN,
        ...(toStringOrNull(input.jobId) ? { jobId: toStringOrNull(input.jobId) } : {}),
      },
      orderBy: { startedAt: 'desc' },
    });
    if (!openJob) {
      raiseToolError(
        'TIME_NO_OPEN_JOB',
        'No open job timer found to stop.',
        true,
      );
    }

    const nextNotes = [openJob.notes, toStringOrNull(input.notes)]
      .filter((value): value is string => Boolean(value))
      .join('\n')
      .trim();

    const updated = await prisma.timeEntry.update({
      where: { id: openJob.id },
      data: {
        endedAt: now,
        endedAtLocal: toStringOrNull(input.endedAtLocal),
        timezoneOffsetMinutes:
          typeof input.timezoneOffsetMinutes === 'number'
            ? input.timezoneOffsetMinutes
            : openJob.timezoneOffsetMinutes,
        notes: nextNotes.length > 0 ? nextNotes : null,
        status: TimeEntryStatus.CLOSED,
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'time.job.stopped',
      payload: toInputJson({
        timeEntryId: updated.id,
        jobId: updated.jobId,
        userId: actorUserId,
        endedAt: updated.endedAt?.toISOString() ?? null,
      }),
    });

    return jsonResult({
      timeEntry: updated,
    });
  };

  const timeEditRequest: ToolHandler = async ({ context, payload }) => {
    const input = timeEditRequestSchema.parse(payload);
    const actorUserId = await resolveActorUserId(context.orgId, context.actorUserId);

    const entry = await prisma.timeEntry.findFirst({
      where: {
        id: input.timeEntryId,
        orgId: context.orgId,
      },
      select: {
        id: true,
        userId: true,
      },
    });
    if (!entry) {
      throw new Error('Time entry not found');
    }
    if (entry.userId !== actorUserId) {
      throw new Error('You can only request edits for your own time entries');
    }

    const request = await prisma.timeEditRequest.create({
      data: {
        orgId: context.orgId,
        userId: actorUserId,
        timeEntryId: entry.id,
        requestedChangesJson: toInputJson(input.requestedChanges),
        reason: input.reason,
        status: TimeEditRequestStatus.PENDING,
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'time.edit.requested',
      payload: toInputJson({
        timeEditRequestId: request.id,
        timeEntryId: request.timeEntryId,
        userId: request.userId,
      }),
    });

    return jsonResult({
      timeEditRequest: request,
    });
  };

  const timeEditReview: ToolHandler = async ({ context, payload }) => {
    const input = timeEditReviewSchema.parse(payload);
    const actorUserId = await resolveActorUserId(context.orgId, context.actorUserId);

    const result = await prisma.$transaction(async (tx) => {
      const request = await tx.timeEditRequest.findFirst({
        where: {
          id: input.timeEditRequestId,
          orgId: context.orgId,
        },
        include: {
          timeEntry: true,
        },
      });
      if (!request) {
        throw new Error('Time edit request not found');
      }
      if (request.status !== TimeEditRequestStatus.PENDING) {
        throw new Error('Time edit request is no longer pending');
      }

      if (input.decision === 'REJECT') {
        const rejected = await tx.timeEditRequest.update({
          where: { id: request.id },
          data: {
            status: TimeEditRequestStatus.REJECTED,
            reviewedByUserId: actorUserId,
            reviewedAt: new Date(),
            reviewNote: toStringOrNull(input.reviewNote),
          },
        });

        return {
          request: rejected,
          timeEntry: request.timeEntry,
          before: null,
          after: null,
        };
      }

      const requestedChanges = jsonObject(request.requestedChangesJson);
      const requestedStartedAt =
        typeof requestedChanges.startedAt === 'string'
          ? toDateOrNull(requestedChanges.startedAt)
          : null;
      const requestedEndedAt =
        typeof requestedChanges.endedAt === 'string'
          ? toDateOrNull(requestedChanges.endedAt)
          : null;

      if (
        typeof requestedChanges.startedAt === 'string' &&
        !requestedStartedAt
      ) {
        throw new Error('Invalid requestedChanges.startedAt value');
      }
      if (
        typeof requestedChanges.endedAt === 'string' &&
        !requestedEndedAt
      ) {
        throw new Error('Invalid requestedChanges.endedAt value');
      }

      const beforeSnapshot = {
        startedAt: request.timeEntry.startedAt.toISOString(),
        endedAt: request.timeEntry.endedAt?.toISOString() ?? null,
        startedAtLocal: request.timeEntry.startedAtLocal,
        endedAtLocal: request.timeEntry.endedAtLocal,
        timezoneOffsetMinutes: request.timeEntry.timezoneOffsetMinutes,
        notes: request.timeEntry.notes,
        status: request.timeEntry.status,
      };

      const updatedEntry = await tx.timeEntry.update({
        where: { id: request.timeEntry.id },
        data: {
          startedAt:
            typeof requestedChanges.startedAt === 'string'
              ? (requestedStartedAt ?? request.timeEntry.startedAt)
              : request.timeEntry.startedAt,
          endedAt:
            typeof requestedChanges.endedAt === 'string'
              ? (requestedEndedAt ?? request.timeEntry.endedAt)
              : request.timeEntry.endedAt,
          startedAtLocal:
            typeof requestedChanges.startedAtLocal === 'string'
              ? requestedChanges.startedAtLocal
              : request.timeEntry.startedAtLocal,
          endedAtLocal:
            typeof requestedChanges.endedAtLocal === 'string'
              ? requestedChanges.endedAtLocal
              : request.timeEntry.endedAtLocal,
          timezoneOffsetMinutes:
            typeof requestedChanges.timezoneOffsetMinutes === 'number'
              ? requestedChanges.timezoneOffsetMinutes
              : request.timeEntry.timezoneOffsetMinutes,
          notes:
            typeof requestedChanges.notes === 'string'
              ? requestedChanges.notes
              : request.timeEntry.notes,
          status:
            typeof requestedChanges.endedAt === 'string'
              ? TimeEntryStatus.CLOSED
              : request.timeEntry.status,
        },
      });

      const approvedRequest = await tx.timeEditRequest.update({
        where: { id: request.id },
        data: {
          status: TimeEditRequestStatus.APPROVED,
          reviewedByUserId: actorUserId,
          reviewedAt: new Date(),
          reviewNote: toStringOrNull(input.reviewNote),
        },
      });

      const afterSnapshot = {
        startedAt: updatedEntry.startedAt.toISOString(),
        endedAt: updatedEntry.endedAt?.toISOString() ?? null,
        startedAtLocal: updatedEntry.startedAtLocal,
        endedAtLocal: updatedEntry.endedAtLocal,
        timezoneOffsetMinutes: updatedEntry.timezoneOffsetMinutes,
        notes: updatedEntry.notes,
        status: updatedEntry.status,
      };

      await tx.auditLog.create({
        data: {
          orgId: context.orgId,
          actorType: context.actorType,
          actorUserId,
          action: 'time.edit.applied',
          entityType: 'TimeEntry',
          entityId: updatedEntry.id,
          metadata: toInputJson({
            timeEditRequestId: approvedRequest.id,
            before: beforeSnapshot,
            after: afterSnapshot,
            reviewNote: toStringOrNull(input.reviewNote),
          }),
        },
      });

      return {
        request: approvedRequest,
        timeEntry: updatedEntry,
        before: beforeSnapshot,
        after: afterSnapshot,
      };
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'time.edit.reviewed',
      payload: toInputJson({
        timeEditRequestId: result.request.id,
        timeEntryId: result.request.timeEntryId,
        decision: result.request.status,
        reviewedByUserId: result.request.reviewedByUserId,
      }),
    });

    return jsonResult({
      timeEditRequest: result.request,
      timeEntry: result.timeEntry,
      before: result.before,
      after: result.after,
    });
  };

  const mobilePinSet: ToolHandler = async ({ context, payload }) => {
    const input = mobilePinSetSchema.parse(payload);
    const actorUserId = await resolveActorUserId(context.orgId, context.actorUserId);
    const now = new Date();

    const target = await prisma.user.findFirst({
      where: {
        id: input.userId,
        orgId: context.orgId,
        isActive: true,
      },
      select: { id: true },
    });
    if (!target) {
      raiseToolError('AUTH_USER_NOT_FOUND', 'User not found for PIN update.', false);
    }

    const pinHash = await bcrypt.hash(input.newPin, 12);
    const updated = await prisma.user.update({
      where: { id: target.id },
      data: {
        mobilePinHash: pinHash,
        mobilePinUpdatedAt: now,
        mobilePinFailedAttempts: 0,
        mobilePinLockedUntil: null,
        mobilePinResetRequired: false,
      },
      select: {
        id: true,
        mobilePinUpdatedAt: true,
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'auth.mobile.pin.set',
      payload: toInputJson({
        userId: updated.id,
        updatedByUserId: actorUserId,
        mobilePinUpdatedAt: updated.mobilePinUpdatedAt?.toISOString() ?? null,
      }),
    });

    return jsonResult({
      userId: updated.id,
      mobilePinUpdatedAt: updated.mobilePinUpdatedAt?.toISOString() ?? null,
    });
  };

  const mobilePinReset: ToolHandler = async ({ context, payload }) => {
    const input = mobilePinResetSchema.parse(payload);
    const actorUserId = await resolveActorUserId(context.orgId, context.actorUserId);
    const now = new Date();

    const target = await prisma.user.findFirst({
      where: {
        id: input.userId,
        orgId: context.orgId,
        isActive: true,
      },
      select: { id: true },
    });
    if (!target) {
      raiseToolError('AUTH_USER_NOT_FOUND', 'User not found for PIN reset.', false);
    }

    const temporaryPin =
      input.temporaryPin ??
      String(Math.floor(100000 + Math.random() * 900000));
    const pinHash = await bcrypt.hash(temporaryPin, 12);

    await prisma.user.update({
      where: { id: target.id },
      data: {
        mobilePinHash: pinHash,
        mobilePinUpdatedAt: now,
        mobilePinFailedAttempts: 0,
        mobilePinLockedUntil: null,
        mobilePinResetRequired: true,
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'auth.mobile.pin.reset',
      payload: toInputJson({
        userId: target.id,
        resetByUserId: actorUserId,
        mobilePinUpdatedAt: now.toISOString(),
      }),
    });

    return jsonResult({
      userId: target.id,
      temporaryPin,
      mobilePinResetRequired: true,
    });
  };

  const mobilePinLogin: ToolHandler = async ({ context, payload }) => {
    const input = mobilePinLoginSchema.parse(payload);
    const now = new Date();
    const normalizedIdentifier = input.identifier.trim();
    const normalizedDigits = normalizedIdentifier.replace(/\D/g, '');

    const org = await prisma.organization.findUnique({
      where: { id: context.orgId },
      select: { id: true, slug: true, name: true },
    });
    if (!org) {
      raiseToolError('AUTH_ORG_NOT_FOUND', 'Organization not found for login.', false);
    }
    if (org.slug !== input.orgSlug) {
      raiseToolError('AUTH_ORG_MISMATCH', 'Organization slug does not match login context.', false);
    }

    const userByEmailOrCode = await prisma.user.findFirst({
      where: {
        orgId: context.orgId,
        isActive: true,
        OR: [
          {
            email: {
              equals: normalizedIdentifier,
              mode: 'insensitive',
            },
          },
          {
            employeeCode: {
              equals: normalizedIdentifier,
              mode: 'insensitive',
            },
          },
        ],
      },
    });

    const userByPhone = !userByEmailOrCode && normalizedDigits.length >= 7
      ? (await prisma.user.findMany({
          where: {
            orgId: context.orgId,
            isActive: true,
            NOT: { phone: null },
          },
        })).find((candidate) => {
          const candidateDigits = (candidate.phone ?? '').replace(/\D/g, '');
          return candidateDigits.length > 0 && candidateDigits === normalizedDigits;
        }) ?? null
      : null;

    const user = userByEmailOrCode ?? userByPhone;

    if (!user) {
      await prisma.auditLog.create({
        data: {
          orgId: context.orgId,
          actorType: context.actorType,
          actorUserId: null,
          action: 'AUTH_MOBILE_PIN_LOGIN_FAILED',
          entityType: 'User',
          entityId: null,
          metadata: toInputJson({
            reason: 'identifier_not_found',
            identifier: normalizedIdentifier,
            deviceId: input.deviceId,
          }),
        },
      });

      return jsonResult({
        authenticated: false,
        code: 'AUTH_INVALID_CREDENTIALS',
        message: 'Invalid identifier or PIN.',
        recoverable: true,
      });
    }

    if (user.mobilePinLockedUntil && user.mobilePinLockedUntil > now) {
      await prisma.auditLog.create({
        data: {
          orgId: context.orgId,
          actorType: context.actorType,
          actorUserId: user.id,
          action: 'AUTH_MOBILE_PIN_LOGIN_FAILED',
          entityType: 'User',
          entityId: user.id,
          metadata: toInputJson({
            reason: 'locked',
            lockedUntil: user.mobilePinLockedUntil.toISOString(),
            deviceId: input.deviceId,
          }),
        },
      });

      return jsonResult({
        authenticated: false,
        code: 'AUTH_PIN_LOCKED',
        message: 'PIN login is temporarily locked due to repeated failed attempts.',
        recoverable: true,
        lockedUntil: user.mobilePinLockedUntil.toISOString(),
      });
    }

    if (!user.mobilePinHash) {
      await prisma.auditLog.create({
        data: {
          orgId: context.orgId,
          actorType: context.actorType,
          actorUserId: user.id,
          action: 'AUTH_MOBILE_PIN_LOGIN_FAILED',
          entityType: 'User',
          entityId: user.id,
          metadata: toInputJson({
            reason: 'pin_not_set',
            deviceId: input.deviceId,
          }),
        },
      });

      return jsonResult({
        authenticated: false,
        code: 'AUTH_PIN_NOT_SET',
        message: 'PIN is not set for this account. Contact an admin.',
        recoverable: false,
      });
    }

    const pinMatches = await bcrypt.compare(input.pin, user.mobilePinHash);
    if (!pinMatches) {
      const failedAttempts = user.mobilePinFailedAttempts + 1;
      const shouldLock = failedAttempts >= 5;
      const lockedUntil = shouldLock
        ? new Date(now.getTime() + 15 * 60 * 1000)
        : null;

      await prisma.user.update({
        where: { id: user.id },
        data: {
          mobilePinFailedAttempts: failedAttempts,
          mobilePinLockedUntil: lockedUntil,
        },
      });

      await prisma.auditLog.create({
        data: {
          orgId: context.orgId,
          actorType: context.actorType,
          actorUserId: user.id,
          action: 'AUTH_MOBILE_PIN_LOGIN_FAILED',
          entityType: 'User',
          entityId: user.id,
          metadata: toInputJson({
            reason: 'invalid_pin',
            failedAttempts,
            lockedUntil: lockedUntil?.toISOString() ?? null,
            deviceId: input.deviceId,
          }),
        },
      });

      await enqueueOutbox(prisma, {
        orgId: context.orgId,
        eventType: 'auth.mobile.pin.login.failed',
        payload: toInputJson({
          userId: user.id,
          failedAttempts,
          lockedUntil: lockedUntil?.toISOString() ?? null,
          deviceId: input.deviceId,
        }),
      });

      return jsonResult({
        authenticated: false,
        code: shouldLock ? 'AUTH_PIN_LOCKED' : 'AUTH_PIN_INVALID',
        message: shouldLock
          ? 'PIN login locked after repeated failed attempts.'
          : 'Invalid identifier or PIN.',
        recoverable: true,
        failedAttempts,
        lockedUntil: lockedUntil?.toISOString() ?? null,
      });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        mobilePinFailedAttempts: 0,
        mobilePinLockedUntil: null,
      },
    });

    const roleLinks = await prisma.userRole.findMany({
      where: { userId: user.id },
      include: {
        role: {
          include: {
            rolePermissions: {
              include: {
                permission: true,
              },
            },
          },
        },
      },
    });

    const roles = roleLinks.map((link) => link.role.name.toLowerCase());
    const permissions = [...new Set(
      roleLinks.flatMap((link) => link.role.rolePermissions.map((rp) => rp.permission.key)),
    )].sort();

    await prisma.mobileClient.upsert({
      where: {
        orgId_userId_deviceId: {
          orgId: context.orgId,
          userId: user.id,
          deviceId: input.deviceId,
        },
      },
      update: {
        deviceName: toStringOrNull(input.deviceName),
        lastSeenAt: now,
      },
      create: {
        orgId: context.orgId,
        userId: user.id,
        deviceId: input.deviceId,
        deviceName: toStringOrNull(input.deviceName),
        lastSeenAt: now,
      },
    });

    await prisma.auditLog.create({
      data: {
        orgId: context.orgId,
        actorType: context.actorType,
        actorUserId: user.id,
        action: 'AUTH_MOBILE_PIN_LOGIN_SUCCEEDED',
        entityType: 'User',
        entityId: user.id,
        metadata: toInputJson({
          deviceId: input.deviceId,
          deviceName: toStringOrNull(input.deviceName),
        }),
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'auth.mobile.pin.login.succeeded',
      payload: toInputJson({
        userId: user.id,
        deviceId: input.deviceId,
        deviceName: toStringOrNull(input.deviceName),
      }),
    });

    return jsonResult({
      authenticated: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        actorType: user.actorType,
        mobilePinResetRequired: user.mobilePinResetRequired,
        mobilePinUpdatedAt: user.mobilePinUpdatedAt?.toISOString() ?? null,
      },
      roles,
      permissions,
      org: {
        id: org.id,
        slug: org.slug,
        name: org.name,
      },
      deviceId: input.deviceId,
    });
  };

  const mediaPhotoUpload: ToolHandler = async ({ context, payload }) => {
    const input = mediaPhotoUploadSchema.parse(payload);
    const actorUserId = await resolveActorUserId(context.orgId, context.actorUserId);

    const existingAttachment = await prisma.attachment.findUnique({
      where: { id: input.attachmentId },
    });
    if (existingAttachment) {
      if (existingAttachment.orgId !== context.orgId) {
        raiseToolError(
          'MEDIA_ATTACHMENT_ID_CONFLICT',
          'attachmentId already exists for a different organization',
          false,
        );
      }

      return jsonResult({
        attachment: existingAttachment,
        idempotent: true,
      });
    }

    if (input.ownerType === 'QUOTE') {
      const quote = await prisma.quote.findFirst({
        where: {
          id: input.ownerId,
          orgId: context.orgId,
        },
        select: { id: true },
      });
      if (!quote) {
        throw new Error('Quote not found for ownerId');
      }
    } else {
      const job = await prisma.job.findFirst({
        where: {
          id: input.ownerId,
          orgId: context.orgId,
        },
        select: { id: true },
      });
      if (!job) {
        throw new Error('Job not found for ownerId');
      }
    }

    const expectedKind =
      input.ownerType === 'QUOTE' ? AttachmentKind.QUOTE_PHOTO : AttachmentKind.JOB_PHOTO;
    if (input.kind !== expectedKind) {
      throw new Error(`kind must be ${expectedKind} for ownerType ${input.ownerType}`);
    }

    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 365 * 24 * 60 * 60 * 1000);

    const attachment = await prisma.attachment.create({
      data: {
        id: input.attachmentId,
        orgId: context.orgId,
        kind: input.kind as AttachmentKind,
        storageProvider: AttachmentStorageProvider.S3,
        bucket: input.bucket,
        objectKey: input.objectKey,
        displayObjectKey: input.displayObjectKey,
        thumbObjectKey: input.thumbObjectKey,
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        width: input.width,
        height: input.height,
        checksumSha256: input.checksumSha256,
        uploadedByUserId: actorUserId,
        ownerType: input.ownerType as AttachmentOwnerType,
        ownerId: input.ownerId,
        tag: input.tag as AttachmentTag,
        caption: toStringOrNull(input.caption),
        expiresAt,
        isPublic: false,
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'media.uploaded',
      payload: toInputJson({
        attachmentId: attachment.id,
        ownerType: attachment.ownerType,
        ownerId: attachment.ownerId,
        tag: attachment.tag,
        isPublic: attachment.isPublic,
      }),
      correlationId: context.correlationId,
    });

    return jsonResult({
      attachment,
    });
  };

  const mediaUploadSessionStart: ToolHandler = async ({ context, payload }) => {
    const input = mediaUploadSessionStartSchema.parse(payload);
    const actorUserId = await resolveActorUserId(context.orgId, context.actorUserId);
    const now = new Date();
    const ttlMinutes =
      Number.parseInt(process.env.MEDIA_UPLOAD_SESSION_TTL_MINUTES ?? '1440', 10) || 1440;
    const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);

    if (input.ownerType === 'QUOTE') {
      const quote = await prisma.quote.findFirst({
        where: { id: input.ownerId, orgId: context.orgId },
        select: { id: true },
      });
      if (!quote) {
        raiseToolError('MEDIA_OWNER_NOT_FOUND', 'Quote not found for ownerId', true);
      }
    } else {
      const job = await prisma.job.findFirst({
        where: { id: input.ownerId, orgId: context.orgId },
        select: { id: true },
      });
      if (!job) {
        raiseToolError('MEDIA_OWNER_NOT_FOUND', 'Job not found for ownerId', true);
      }
    }

    const existing = await prisma.mediaUploadSession.findUnique({
      where: {
        orgId_sessionKey: {
          orgId: context.orgId,
          sessionKey: input.sessionKey,
        },
      },
    });

    if (existing) {
      if (existing.ownerType !== input.ownerType || existing.ownerId !== input.ownerId) {
        raiseToolError(
          'MEDIA_SESSION_OWNER_MISMATCH',
          'Session key is already bound to a different owner',
          false,
        );
      }

      if (
        existing.expiresAt &&
        existing.expiresAt.getTime() < now.getTime() &&
        existing.status !== MediaUploadSessionStatus.COMPLETED
      ) {
        await prisma.mediaUploadSession.update({
          where: { id: existing.id },
          data: {
            status: MediaUploadSessionStatus.EXPIRED,
            errorMessage: 'Upload session expired by TTL.',
          },
        });
        raiseToolError(
          'MEDIA_SESSION_EXPIRED',
          'Upload session expired. Create a new session.',
          true,
        );
      }

      if (existing.status === MediaUploadSessionStatus.EXPIRED) {
        raiseToolError(
          'MEDIA_SESSION_EXPIRED',
          'Upload session expired. Create a new session.',
          true,
        );
      }

      const refreshed = await prisma.mediaUploadSession.update({
        where: { id: existing.id },
        data: {
          tag: input.tag ?? existing.tag,
          caption: toStringOrNull(input.caption) ?? existing.caption,
          fileName: input.fileName,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes ?? existing.sizeBytes,
          checksumSha256: toStringOrNull(input.checksumSha256) ?? existing.checksumSha256,
          expiresAt,
          metadata: input.metadata
            ? toInputJson(input.metadata)
            : (existing.metadata ?? Prisma.JsonNull),
          errorMessage:
            existing.status === MediaUploadSessionStatus.FAILED
              ? null
              : existing.errorMessage,
          status:
            existing.status === MediaUploadSessionStatus.FAILED
              ? MediaUploadSessionStatus.INITIATED
              : existing.status,
        },
      });

      await enqueueOutbox(prisma, {
        orgId: context.orgId,
        eventType: 'media.upload.session.started',
        payload: toInputJson({
          sessionId: refreshed.id,
          sessionKey: refreshed.sessionKey,
          status: refreshed.status,
          ownerType: refreshed.ownerType,
          ownerId: refreshed.ownerId,
          attachmentId: refreshed.attachmentId,
          idempotent: true,
        }),
      });

      return jsonResult({
        session: refreshed,
        idempotent: true,
      });
    }

    const created = await prisma.mediaUploadSession.create({
      data: {
        orgId: context.orgId,
        sessionKey: input.sessionKey,
        status: MediaUploadSessionStatus.INITIATED,
        ownerType: input.ownerType as AttachmentOwnerType,
        ownerId: input.ownerId,
        tag: (input.tag ?? 'OTHER') as AttachmentTag,
        caption: toStringOrNull(input.caption),
        attachmentId: randomUUID(),
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        checksumSha256: toStringOrNull(input.checksumSha256),
        createdByUserId: actorUserId,
        expiresAt,
        metadata: input.metadata ? toInputJson(input.metadata) : undefined,
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'media.upload.session.started',
      payload: toInputJson({
        sessionId: created.id,
        sessionKey: created.sessionKey,
        status: created.status,
        ownerType: created.ownerType,
        ownerId: created.ownerId,
        attachmentId: created.attachmentId,
        idempotent: false,
      }),
    });

    return jsonResult({
      session: created,
      idempotent: false,
    });
  };

  const mediaUploadSessionComplete: ToolHandler = async ({ context, payload }) => {
    const input = mediaUploadSessionCompleteSchema.parse(payload);
    const now = new Date();

    const session = await prisma.mediaUploadSession.findUnique({
      where: {
        orgId_sessionKey: {
          orgId: context.orgId,
          sessionKey: input.sessionKey,
        },
      },
    });

    if (!session) {
      raiseToolError(
        'MEDIA_SESSION_NOT_FOUND',
        'Upload session not found. Start a new upload session.',
        true,
      );
    }

    if (
      session.expiresAt &&
      session.expiresAt.getTime() < now.getTime() &&
      session.status !== MediaUploadSessionStatus.COMPLETED
    ) {
      await prisma.mediaUploadSession.update({
        where: { id: session.id },
        data: {
          status: MediaUploadSessionStatus.EXPIRED,
          errorMessage: 'Upload session expired by TTL.',
        },
      });
      raiseToolError(
        'MEDIA_SESSION_EXPIRED',
        'Upload session expired. Create a new session.',
        true,
      );
    }

    if (session.status === MediaUploadSessionStatus.COMPLETED) {
      return jsonResult({
        session,
        idempotent: true,
      });
    }

    if (session.status === MediaUploadSessionStatus.EXPIRED) {
      raiseToolError(
        'MEDIA_SESSION_EXPIRED',
        'Upload session expired. Create a new session.',
        true,
      );
    }

    const attachmentId = input.attachmentId ?? session.attachmentId;
    if (!attachmentId) {
      raiseToolError(
        'MEDIA_SESSION_ATTACHMENT_MISSING',
        'Upload session has no attachmentId allocated',
        false,
      );
    }

    const updated = await prisma.mediaUploadSession.update({
      where: { id: session.id },
      data: {
        status: MediaUploadSessionStatus.COMPLETED,
        attachmentId,
        bucket: input.bucket,
        objectKey: input.objectKey,
        displayObjectKey: input.displayObjectKey,
        thumbObjectKey: input.thumbObjectKey,
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        checksumSha256: input.checksumSha256,
        width: input.width,
        height: input.height,
        completedAt: now,
        errorMessage: null,
        attemptCount: {
          increment: 1,
        },
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'media.upload.session.completed',
      payload: toInputJson({
        sessionId: updated.id,
        sessionKey: updated.sessionKey,
        attachmentId: updated.attachmentId,
        ownerType: updated.ownerType,
        ownerId: updated.ownerId,
      }),
    });

    return jsonResult({
      session: updated,
      idempotent: false,
    });
  };

  const mediaUploadSessionFail: ToolHandler = async ({ context, payload }) => {
    const input = mediaUploadSessionFailSchema.parse(payload);
    const now = new Date();

    const session = await prisma.mediaUploadSession.findUnique({
      where: {
        orgId_sessionKey: {
          orgId: context.orgId,
          sessionKey: input.sessionKey,
        },
      },
    });

    if (!session) {
      raiseToolError(
        'MEDIA_SESSION_NOT_FOUND',
        'Upload session not found. Start a new upload session.',
        true,
      );
    }

    if (
      session.expiresAt &&
      session.expiresAt.getTime() < now.getTime() &&
      session.status !== MediaUploadSessionStatus.COMPLETED
    ) {
      await prisma.mediaUploadSession.update({
        where: { id: session.id },
        data: {
          status: MediaUploadSessionStatus.EXPIRED,
          errorMessage: 'Upload session expired by TTL.',
        },
      });
      raiseToolError(
        'MEDIA_SESSION_EXPIRED',
        'Upload session expired. Create a new session.',
        true,
      );
    }

    if (session.status === MediaUploadSessionStatus.COMPLETED) {
      return jsonResult({
        session,
        idempotent: true,
      });
    }

    const updated = await prisma.mediaUploadSession.update({
      where: { id: session.id },
      data: {
        status: MediaUploadSessionStatus.FAILED,
        errorMessage: input.errorMessage,
        attemptCount: {
          increment: 1,
        },
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'media.upload.session.failed',
      payload: toInputJson({
        sessionId: updated.id,
        sessionKey: updated.sessionKey,
        errorMessage: updated.errorMessage,
        ownerType: updated.ownerType,
        ownerId: updated.ownerId,
      }),
    });

    return jsonResult({
      session: updated,
      idempotent: false,
    });
  };

  const mediaList: ToolHandler = async ({ context, payload }) => {
    const input = mediaListSchema.parse(payload);

    const attachments = await prisma.attachment.findMany({
      where: {
        orgId: context.orgId,
        ownerType: input.ownerType as AttachmentOwnerType,
        ownerId: input.ownerId,
        ...(input.includeDeleted ? {} : { deletedAt: null }),
      },
      orderBy: { createdAt: 'desc' },
    });

    return jsonResult({
      attachments,
    });
  };

  const mediaSetPublic: ToolHandler = async ({ context, payload }) => {
    const input = mediaSetPublicSchema.parse(payload);

    const existing = await prisma.attachment.findFirst({
      where: {
        id: input.attachmentId,
        orgId: context.orgId,
      },
    });

    if (!existing) {
      throw new Error('Attachment not found');
    }

    if (existing.ownerType !== AttachmentOwnerType.QUOTE && input.isPublic) {
      throw new Error('Only quote-owned photos can be made public');
    }

    const updated = await prisma.attachment.update({
      where: { id: existing.id },
      data: {
        isPublic: input.isPublic,
        publicToken: input.isPublic ? existing.publicToken ?? randomUUID() : null,
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'media.visibility.updated',
      payload: toInputJson({
        attachmentId: updated.id,
        ownerType: updated.ownerType,
        ownerId: updated.ownerId,
        isPublic: updated.isPublic,
      }),
    });

    return jsonResult({
      attachment: updated,
    });
  };

  const mediaDelete: ToolHandler = async ({ context, payload }) => {
    const input = mediaDeleteSchema.parse(payload);

    const existing = await prisma.attachment.findFirst({
      where: {
        id: input.attachmentId,
        orgId: context.orgId,
      },
    });

    if (!existing) {
      throw new Error('Attachment not found');
    }

    if (!existing.deletedAt) {
      const objectKeys = [existing.objectKey, existing.displayObjectKey, existing.thumbObjectKey].filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0,
      );

      for (const objectKey of objectKeys) {
        try {
          await deleteObject({
            bucket: existing.bucket,
            objectKey,
          });
        } catch {
          // Soft-delete should still proceed even if object is already absent.
        }
      }
    }

    const updated = await prisma.attachment.update({
      where: { id: existing.id },
      data: {
        deletedAt: existing.deletedAt ?? new Date(),
        isPublic: false,
        publicToken: null,
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'media.deleted',
      payload: toInputJson({
        attachmentId: updated.id,
        reason: toStringOrNull(input.reason),
      }),
    });

    return jsonResult({
      attachment: updated,
    });
  };

  const adminMediaPurgeExpired: ToolHandler = async ({ context, payload }) => {
    const input = mediaPurgeExpiredSchema.parse(payload);
    const now = new Date();
    const limit = input.limit ?? 200;

    const expired = await prisma.attachment.findMany({
      where: {
        orgId: context.orgId,
        deletedAt: null,
        expiresAt: {
          lt: now,
        },
      },
      orderBy: { expiresAt: 'asc' },
      take: limit,
    });

    const purgedAttachmentIds: string[] = [];
    const expiredSessionIds: string[] = [];

    for (const attachment of expired) {
      const objectKeys = [attachment.objectKey, attachment.displayObjectKey, attachment.thumbObjectKey].filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0,
      );

      for (const objectKey of objectKeys) {
        try {
          await deleteObject({
            bucket: attachment.bucket,
            objectKey,
          });
        } catch {
          // Continue purge even when object is already missing.
        }
      }

      await prisma.attachment.update({
        where: { id: attachment.id },
        data: {
          deletedAt: now,
          isPublic: false,
          publicToken: null,
        },
      });

      purgedAttachmentIds.push(attachment.id);
    }

    const staleSessions = await prisma.mediaUploadSession.findMany({
      where: {
        orgId: context.orgId,
        status: {
          in: [MediaUploadSessionStatus.INITIATED, MediaUploadSessionStatus.FAILED],
        },
        expiresAt: {
          lt: now,
        },
      },
      orderBy: { expiresAt: 'asc' },
      take: limit,
      select: { id: true, sessionKey: true },
    });

    if (staleSessions.length > 0) {
      const staleSessionIds = staleSessions.map((session) => session.id);
      await prisma.mediaUploadSession.updateMany({
        where: {
          orgId: context.orgId,
          id: {
            in: staleSessionIds,
          },
        },
        data: {
          status: MediaUploadSessionStatus.EXPIRED,
          errorMessage: 'Upload session expired by retention purge.',
        },
      });
      expiredSessionIds.push(...staleSessionIds);

      await enqueueOutbox(prisma, {
        orgId: context.orgId,
        eventType: 'media.upload.session.expired',
        payload: toInputJson({
          expiredCount: staleSessions.length,
          sessionIds: staleSessionIds,
          sessionKeys: staleSessions.map((session) => session.sessionKey),
        }),
        correlationId: context.correlationId,
      });
    }

    if (purgedAttachmentIds.length > 0) {
      await enqueueOutbox(prisma, {
        orgId: context.orgId,
        eventType: 'media.purged',
        payload: toInputJson({
          purgedCount: purgedAttachmentIds.length,
          attachmentIds: purgedAttachmentIds,
        }),
        correlationId: context.correlationId,
      });
    }

    return jsonResult({
      purgedCount: purgedAttachmentIds.length,
      attachmentIds: purgedAttachmentIds,
      expiredSessionCount: expiredSessionIds.length,
      expiredSessionIds,
    });
  };

  const jobCreate: ToolHandler = async ({ context, payload }) => {
    const customerId =
      typeof payload.customerId === 'string' ? payload.customerId : null;
    const scheduledAt = toDateOrNull(payload.scheduledAt);
    const job = await prisma.job.create({
      data: {
        orgId: context.orgId,
        customerId,
        title: String(payload.title),
        status: 'OPEN',
        scheduledAt,
      },
    });

    const jobGeo = await ensureJobGeoForJob({
      orgId: context.orgId,
      jobId: job.id,
      customerId: customerId ?? undefined,
      addressLine1: toStringOrNull(payload.addressLine1),
      city: toStringOrNull(payload.city),
      state: toStringOrNull(payload.state),
      postalCode: toStringOrNull(payload.postalCode),
    });

    return jsonResult({ job, jobGeo });
  };

  const jobGeoEnsure: ToolHandler = async ({ context, payload }) => {
    const jobId = toStringOrNull(payload.jobId);
    if (!jobId) {
      throw new Error('jobId is required');
    }

    const job = await prisma.job.findFirst({
      where: {
        id: jobId,
        orgId: context.orgId,
      },
      select: {
        id: true,
        customerId: true,
      },
    });
    if (!job) {
      throw new Error('Job not found');
    }

    const jobGeo = await ensureJobGeoForJob({
      orgId: context.orgId,
      jobId: job.id,
      customerId: job.customerId ?? undefined,
      addressLine1: toStringOrNull(payload.addressLine1),
      city: toStringOrNull(payload.city),
      state: toStringOrNull(payload.state),
      postalCode: toStringOrNull(payload.postalCode),
    });

    return jsonResult({
      jobId: job.id,
      jobGeo,
    });
  };

  const scheduleChange: ToolHandler = async ({ context, payload }) => {
    const jobId = toStringOrNull(payload.jobId);
    const scheduledAt = toDateOrNull(payload.scheduledAt);
    if (!jobId || !scheduledAt) {
      throw new Error('jobId and scheduledAt are required');
    }

    const status = toStringOrNull(payload.status)?.toUpperCase();
    const nextStatus = status && status.length > 0 ? status : undefined;

    const job = await prisma.job.update({
      where: { id: jobId },
      data: {
        scheduledAt,
        ...(nextStatus ? { status: nextStatus } : {}),
      },
    });

    const jobGeo = await ensureJobGeoForJob({
      orgId: context.orgId,
      jobId: job.id,
      customerId: job.customerId ?? undefined,
      addressLine1: toStringOrNull(payload.addressLine1),
      city: toStringOrNull(payload.city),
      state: toStringOrNull(payload.state),
      postalCode: toStringOrNull(payload.postalCode),
    });

    if (job.status.toUpperCase() === 'COMPLETED') {
      await enqueueOutbox(prisma, {
        orgId: context.orgId,
        eventType: 'job.completed',
        payload: {
          jobId: job.id,
          customerId: job.customerId,
          channel: toStringOrNull(payload.reviewChannel),
          reviewUrl: toStringOrNull(payload.reviewUrl),
          queueSend: toBoolean(payload.queueSend),
        },
      });
    }

    return jsonResult({
      job,
      jobGeo,
    });
  };

  const dispatchAssign: ToolHandler = async ({ context, payload }) => {
    const job = await prisma.job.update({
      where: { id: String(payload.jobId) },
      data: {
        assignedToUserId: String(payload.userId),
        status: 'ASSIGNED',
      },
    });

    const jobGeo = await ensureJobGeoForJob({
      orgId: context.orgId,
      jobId: job.id,
      customerId: job.customerId ?? undefined,
      addressLine1: toStringOrNull(payload.addressLine1),
      city: toStringOrNull(payload.city),
      state: toStringOrNull(payload.state),
      postalCode: toStringOrNull(payload.postalCode),
    });

    return jsonResult({
      assigned: true,
      orgId: context.orgId,
      job,
      jobGeo,
    });
  };

  const invoiceCreate: ToolHandler = async ({ context, payload }) => {
    const invoice = await prisma.invoice.create({
      data: {
        orgId: context.orgId,
        customerId: String(payload.customerId),
        amountCents: Number(payload.amountCents),
        status: 'DRAFT',
      },
    });

    return jsonResult({ invoice });
  };

  const invoiceIssue: ToolHandler = async ({ payload }) => {
    const invoice = await prisma.invoice.update({
      where: { id: String(payload.invoiceId) },
      data: {
        status: 'ISSUED',
        externalRef: `inv_${Date.now()}`,
      },
    });

    return jsonResult({ invoice });
  };

  const resolveCustomerIdFromImport = async (
    orgId: string,
    payload: Record<string, unknown>,
  ): Promise<string | null> => {
    const explicitCustomerId = toStringOrNull(payload.customerId);
    if (explicitCustomerId) {
      return explicitCustomerId;
    }

    const customerEmail = toStringOrNull(payload.customerEmail) ?? toStringOrNull(payload.email);
    const customerName = toStringOrNull(payload.customerName) ?? toStringOrNull(payload.fullName);

    if (customerEmail) {
      const byEmail = await prisma.customer.findFirst({
        where: { orgId, email: customerEmail },
        select: { id: true },
      });
      if (byEmail) {
        return byEmail.id;
      }
    }

    if (customerName) {
      const byName = await prisma.customer.findFirst({
        where: { orgId, fullName: customerName },
        select: { id: true },
      });
      if (byName) {
        return byName.id;
      }
    }

    if (!customerName && !customerEmail) {
      return null;
    }

    const created = await prisma.customer.create({
      data: {
        orgId,
        fullName: customerName ?? customerEmail ?? 'Imported Customer',
        email: customerEmail,
      },
      select: { id: true },
    });
    return created.id;
  };

  const customerUpsertFromJobberCsv: ToolHandler = async ({ context, payload }) => {
    const fullName = toStringOrNull(payload.fullName) ?? 'Imported Customer';
    const email = toStringOrNull(payload.email);
    const phone = toStringOrNull(payload.phone);
    const addressLine1 = toStringOrNull(payload.addressLine1);
    const city = toStringOrNull(payload.city);
    const state = toStringOrNull(payload.state);
    const postalCode = toStringOrNull(payload.postalCode);

    const existing = await prisma.customer.findFirst({
      where: {
        orgId: context.orgId,
        OR: [
          ...(email ? [{ email }] : []),
          ...(phone ? [{ phone }] : []),
          { fullName },
        ],
      },
      orderBy: { createdAt: 'asc' },
    });

    const customer = existing
      ? await prisma.customer.update({
          where: { id: existing.id },
          data: {
            fullName,
            ...(email ? { email } : {}),
            ...(phone ? { phone } : {}),
            ...(addressLine1 ? { addressLine1 } : {}),
            ...(city ? { city } : {}),
            ...(state ? { state } : {}),
            ...(postalCode ? { postalCode } : {}),
          },
        })
      : await prisma.customer.create({
          data: {
            orgId: context.orgId,
            fullName,
            email,
            phone,
            addressLine1,
            city,
            state,
            postalCode,
          },
        });

    return jsonResult({
      action: existing ? 'updated' : 'created',
      customer: {
        id: customer.id,
        fullName: customer.fullName,
        email: customer.email,
        phone: customer.phone,
      },
    });
  };

  const pricingItemUpsertFromJobberCsv: ToolHandler = async ({ context, payload }) => {
    const name = toStringOrNull(payload.name) ?? 'Imported Item';
    const sku = toStringOrNull(payload.sku);
    const description = toStringOrNull(payload.description);
    const unitPriceCents = toNumberOrNull(payload.unitPriceCents);

    const existing = await prisma.pricingItem.findFirst({
      where: {
        orgId: context.orgId,
        ...(sku ? { sku } : { name }),
      },
      orderBy: { createdAt: 'asc' },
    });

    const metadata = {
      importSource: 'jobber_csv',
      sourceId: toStringOrNull(payload.sourceId),
      rawRow: payload.rawRow ?? null,
      inputMetadata: payload.metadata ?? null,
    } as Prisma.InputJsonValue;

    const item = existing
      ? await prisma.pricingItem.update({
          where: { id: existing.id },
          data: {
            name,
            sku,
            description,
            unitPriceCents: unitPriceCents === null ? undefined : Math.round(unitPriceCents),
            metadata,
          },
        })
      : await prisma.pricingItem.create({
          data: {
            orgId: context.orgId,
            name,
            sku,
            description,
            unitPriceCents: unitPriceCents === null ? null : Math.round(unitPriceCents),
            metadata,
          },
        });

    return jsonResult({
      action: existing ? 'updated' : 'created',
      item: {
        id: item.id,
        name: item.name,
        sku: item.sku,
        unitPriceCents: item.unitPriceCents,
      },
    });
  };

  const quoteImportFromJobberCsv: ToolHandler = async ({ context, payload }) => {
    const existingMbsId = toStringOrNull(payload.existingMbsId);
    const externalRef =
      toStringOrNull(payload.quoteNumber) ?? toStringOrNull(payload.sourceId);
    const status = toStringOrNull(payload.status) ?? 'IMPORTED';
    const totalCents = toNumberOrNull(payload.totalCents);
    const issuedAt = toDateOrNull(payload.issuedAt);
    const expiresAt = toDateOrNull(payload.expiresAt);
    const customerId = await resolveCustomerIdFromImport(context.orgId, payload);

    const existing = existingMbsId
      ? await prisma.quote.findFirst({
          where: { id: existingMbsId, orgId: context.orgId },
        })
      : externalRef
        ? await prisma.quote.findFirst({
            where: { orgId: context.orgId, externalRef },
            orderBy: { createdAt: 'asc' },
          })
        : null;

    const metadata = {
      importSource: 'jobber_csv',
      sourceId: toStringOrNull(payload.sourceId),
      sourceType: toStringOrNull(payload.sourceType),
      rawRow: payload.rawRow ?? null,
      lineItems: payload.lineItems ?? [],
      lineItemsText: payload.lineItemsText ?? null,
      lineItemsParsed: payload.lineItemsParsed ?? null,
      rawLineItemsText:
        payload.lineItemsParsed === false
          ? payload.lineItemsText ?? null
          : null,
      inputMetadata: payload.metadata ?? null,
    } as Prisma.InputJsonValue;

    const quote = existing
      ? await prisma.quote.update({
          where: { id: existing.id },
          data: {
            customerId,
            status,
            totalCents: totalCents === null ? existing.totalCents : Math.round(totalCents),
            externalRef,
            issuedAt: issuedAt ?? undefined,
            expiresAt: expiresAt ?? undefined,
            metadata,
          },
        })
      : await prisma.quote.create({
          data: {
            orgId: context.orgId,
            customerId,
            status,
            totalCents: totalCents === null ? 0 : Math.round(totalCents),
            externalRef,
            issuedAt,
            expiresAt,
            metadata,
          },
        });

    return jsonResult({
      action: existing ? 'updated' : 'created',
      quote: {
        id: quote.id,
        externalRef: quote.externalRef,
        status: quote.status,
        totalCents: quote.totalCents,
      },
    });
  };

  const invoiceImportFromJobberCsv: ToolHandler = async ({ context, payload }) => {
    const existingMbsId = toStringOrNull(payload.existingMbsId);
    const externalRef =
      toStringOrNull(payload.invoiceNumber) ?? toStringOrNull(payload.sourceId);
    const status = toStringOrNull(payload.status) ?? 'IMPORTED';
    const totalCents = toNumberOrNull(payload.totalCents);
    const customerId = await resolveCustomerIdFromImport(context.orgId, payload);

    const existing = existingMbsId
      ? await prisma.invoice.findFirst({
          where: { id: existingMbsId, orgId: context.orgId },
        })
      : externalRef
        ? await prisma.invoice.findFirst({
            where: { orgId: context.orgId, externalRef },
            orderBy: { createdAt: 'asc' },
          })
        : null;

    const metadata = {
      importSource: 'jobber_csv',
      sourceId: toStringOrNull(payload.sourceId),
      sourceType: toStringOrNull(payload.sourceType),
      rawRow: payload.rawRow ?? null,
      lineItems: payload.lineItems ?? [],
      lineItemsText: payload.lineItemsText ?? null,
      lineItemsParsed: payload.lineItemsParsed ?? null,
      rawLineItemsText:
        payload.lineItemsParsed === false
          ? payload.lineItemsText ?? null
          : null,
      balanceCents: toNumberOrNull(payload.balanceCents),
      dueAt: toStringOrNull(payload.dueAt),
      issuedAt: toStringOrNull(payload.issuedAt),
      inputMetadata: payload.metadata ?? null,
    } as Prisma.InputJsonValue;

    const invoice = existing
      ? await prisma.invoice.update({
          where: { id: existing.id },
          data: {
            customerId,
            status,
            amountCents: totalCents === null ? existing.amountCents : Math.round(totalCents),
            externalRef,
            metadata,
          },
        })
      : await prisma.invoice.create({
          data: {
            orgId: context.orgId,
            customerId,
            status,
            amountCents: totalCents === null ? 0 : Math.round(totalCents),
            externalRef,
            metadata,
          },
        });

    return jsonResult({
      action: existing ? 'updated' : 'created',
      invoice: {
        id: invoice.id,
        externalRef: invoice.externalRef,
        status: invoice.status,
        amountCents: invoice.amountCents,
      },
    });
  };

  const equipmentCatalogImportCsv: ToolHandler = async ({ context, payload }) => {
    const input = equipmentCatalogImportSchema.parse(payload);
    const attachmentRefId = toStringOrNull(input.attachmentRefId);

    if (attachmentRefId) {
      const attachmentRef = await prisma.attachmentRef.findFirst({
        where: {
          id: attachmentRefId,
          orgId: context.orgId,
        },
        select: { id: true },
      });
      if (!attachmentRef) {
        throw new Error('attachmentRefId not found for this organization');
      }
    }

    const mapping: EquipmentCatalogMapping = {
      skuColumn: toStringOrNull(input.mapping?.skuColumn) ?? undefined,
      manufacturerColumn: toStringOrNull(input.mapping?.manufacturerColumn) ?? undefined,
      systemTypeColumn: toStringOrNull(input.mapping?.systemTypeColumn) ?? undefined,
      textColumns: input.mapping?.textColumns?.map((value) => value.trim()).filter(Boolean),
    };

    const source = await prisma.equipmentCatalogSource.create({
      data: {
        orgId: context.orgId,
        name: input.sourceName,
        status: EquipmentCatalogSourceStatus.PROCESSING,
        attachmentRefId,
        mappingJson: toInputJson({
          mapping,
          metadata: input.metadata ?? null,
        }),
      },
      select: { id: true },
    });

    try {
      const extracted = extractEquipmentCatalogRows(input.csvContent, mapping);
      const batchSize = 500;

      for (let i = 0; i < extracted.rows.length; i += batchSize) {
        const batch = extracted.rows.slice(i, i + batchSize);
        await prisma.equipmentCatalogEntry.createMany({
          data: batch.map((row) => ({
            orgId: context.orgId,
            sourceId: source.id,
            rawSku: row.rawSku,
            rawText: row.rawText,
            manufacturer: row.manufacturer,
            systemTypeHint: row.systemTypeHint,
            rawJson: row.rawJson as Prisma.InputJsonValue,
          })),
        });
      }

      await prisma.equipmentCatalogSource.update({
        where: { id: source.id },
        data: {
          status: EquipmentCatalogSourceStatus.READY,
          mappingJson: toInputJson({
            mapping,
            metadata: input.metadata ?? null,
            acceptedRows: extracted.acceptedRows,
            skippedRows: extracted.skippedRows,
            importedRows: extracted.rows.length,
            importedAt: new Date().toISOString(),
          }),
        },
      });

      return jsonResult({
        sourceId: source.id,
        status: EquipmentCatalogSourceStatus.READY,
        acceptedRows: extracted.acceptedRows,
        importedRows: extracted.rows.length,
        skippedRows: extracted.skippedRows,
        attachmentRefId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown import error';
      await prisma.equipmentCatalogSource
        .update({
          where: { id: source.id },
          data: {
            status: EquipmentCatalogSourceStatus.FAILED,
            mappingJson: toInputJson({
              mapping,
              metadata: input.metadata ?? null,
              error: message,
              failedAt: new Date().toISOString(),
            }),
          },
        })
        .catch(() => undefined);
      throw error;
    }
  };

  const equipmentCatalogLookup: ToolHandler = async ({ context, payload }) => {
    const input = equipmentLookupSchema.parse(payload);
    const query = input.query.trim();
    const manufacturerFilter = toStringOrNull(input.manufacturer)?.toLowerCase();
    const systemTypeFilter = toStringOrNull(input.systemType)?.toLowerCase();
    const limit = input.limit ?? 8;
    const likePattern = `%${query.replace(/[%_]/g, '')}%`;

    const whereConditions: Prisma.Sql[] = [
      Prisma.sql`"orgId" = ${context.orgId}`,
      Prisma.sql`("rawSku" ILIKE ${likePattern} OR "rawText" ILIKE ${likePattern} OR similarity("rawSku", ${query}) > 0.2 OR similarity("rawText", ${query}) > 0.2)`,
    ];

    if (manufacturerFilter) {
      whereConditions.push(
        Prisma.sql`LOWER(COALESCE("manufacturer", '')) LIKE ${`%${manufacturerFilter}%`}`,
      );
    }
    if (systemTypeFilter) {
      whereConditions.push(
        Prisma.sql`LOWER(COALESCE("systemTypeHint", '')) LIKE ${`%${systemTypeFilter}%`}`,
      );
    }

    const entries = await prisma.$queryRaw<EquipmentCatalogEntryRow[]>(
      Prisma.sql`
        SELECT
          "id",
          "rawSku",
          "rawText",
          "manufacturer",
          "systemTypeHint",
          "rawJson",
          GREATEST(similarity("rawSku", ${query}), similarity("rawText", ${query})) AS "fuzzyScore"
        FROM "EquipmentCatalogEntry"
        WHERE ${Prisma.join(whereConditions, ' AND ')}
        ORDER BY "fuzzyScore" DESC, "createdAt" DESC
        LIMIT ${limit}
      `,
    );

    const candidates = entries.map((entry) => toLookupCandidate(entry));
    const maxConfidence =
      candidates.length > 0
        ? Math.max(...candidates.map((candidate) => candidate.confidence))
        : 0;
    const requiresVerification = maxConfidence < 0.7;

    return jsonResult({
      query,
      candidates,
      requiresVerification,
      warning: requiresVerification
        ? 'Unable to confidently identify equipment. Verify model/serial or call supply house before finalizing options.'
        : null,
    });
  };

  const equipmentSpecSelectForAssessment: ToolHandler = async ({ context, payload }) => {
    const input = equipmentSpecSelectSchema.parse(payload);

    const assessment = await prisma.systemAssessment.findFirst({
      where: {
        id: input.assessmentId,
        orgId: context.orgId,
      },
      select: { id: true },
    });
    if (!assessment) {
      throw new Error('SystemAssessment not found');
    }

    let selectedPayload: Record<string, unknown> | null = null;
    if (input.selected) {
      selectedPayload = input.selected as Record<string, unknown>;
    } else if (
      Array.isArray(input.results) &&
      typeof input.selectedCandidateIndex === 'number' &&
      input.selectedCandidateIndex >= 0 &&
      input.selectedCandidateIndex < input.results.length
    ) {
      selectedPayload = input.results[input.selectedCandidateIndex] as Record<string, unknown>;
    } else if (Array.isArray(input.results) && input.selectedEntryId) {
      const matched = input.results.find((candidate) => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
          return false;
        }
        return (candidate as Record<string, unknown>).entryId === input.selectedEntryId;
      });
      if (matched && typeof matched === 'object' && !Array.isArray(matched)) {
        selectedPayload = matched as Record<string, unknown>;
      }
    }

    const selectedEntryId =
      toStringOrNull(input.selectedEntryId) ??
      toStringOrNull(selectedPayload?.entryId);

    let selectedModel = toStringOrNull(selectedPayload?.model);
    let selectedManufacturer = toStringOrNull(selectedPayload?.manufacturer);
    let selectedSystemType = toStringOrNull(selectedPayload?.systemType);
    let selectedTonnage = toNumberOrNull(selectedPayload?.tonnage);
    let selectedBtu = toNumberOrNull(selectedPayload?.btu);
    let selectedSeer = toNumberOrNull(selectedPayload?.seer);
    let selectedAfue = toNumberOrNull(selectedPayload?.afue);
    let selectedStages = toNumberOrNull(selectedPayload?.stages);
    let selectedRefrigerant = toStringOrNull(selectedPayload?.refrigerant);
    let selectedConfidence = toNumberOrNull(selectedPayload?.confidence);
    let selectedEvidence = jsonObject(
      (selectedPayload?.evidence as Prisma.JsonValue | null | undefined) ?? undefined,
    );

    if (selectedEntryId) {
      const entry = await prisma.equipmentCatalogEntry.findFirst({
        where: {
          id: selectedEntryId,
          orgId: context.orgId,
        },
      });
      if (!entry) {
        throw new Error('Selected equipment catalog entry not found');
      }
      const derived = toLookupCandidate({
        id: entry.id,
        rawSku: entry.rawSku,
        rawText: entry.rawText,
        manufacturer: entry.manufacturer,
        systemTypeHint: entry.systemTypeHint,
        rawJson: entry.rawJson,
        fuzzyScore: 0,
      });
      selectedModel = selectedModel ?? derived.model;
      selectedManufacturer = selectedManufacturer ?? derived.manufacturer;
      selectedSystemType = selectedSystemType ?? derived.systemType;
      selectedTonnage = selectedTonnage ?? derived.tonnage;
      selectedBtu = selectedBtu ?? derived.btu;
      selectedSeer = selectedSeer ?? derived.seer;
      selectedAfue = selectedAfue ?? derived.afue;
      selectedStages = selectedStages ?? derived.stages;
      selectedRefrigerant = selectedRefrigerant ?? derived.refrigerant;
      selectedConfidence = selectedConfidence ?? derived.confidence;
      selectedEvidence = {
        ...derived.evidence,
        ...selectedEvidence,
      };
    }

    if (!selectedModel) {
      throw new Error('Selected equipment model is required');
    }

    const manufacturerValue = selectedManufacturer ?? 'UNKNOWN';
    const systemTypeValue = selectedSystemType ?? 'UNKNOWN';
    const confidenceValue = clampConfidence(selectedConfidence ?? 0.5);

    const existingSpec = await prisma.equipmentSpecNormalized.findFirst({
      where: {
        orgId: context.orgId,
        manufacturer: manufacturerValue,
        model: selectedModel,
        systemType: systemTypeValue,
      },
      orderBy: { createdAt: 'asc' },
    });

    const spec = existingSpec
      ? await prisma.equipmentSpecNormalized.update({
          where: { id: existingSpec.id },
          data: {
            tonnage: selectedTonnage ?? undefined,
            btu: selectedBtu === null ? undefined : Math.round(selectedBtu),
            seer: selectedSeer ?? undefined,
            afue: selectedAfue ?? undefined,
            stages:
              selectedStages === null
                ? undefined
                : Math.max(1, Math.round(selectedStages)),
            refrigerant: selectedRefrigerant ?? undefined,
            confidence: confidenceValue,
            evidence: toInputJson(selectedEvidence),
          },
        })
      : await prisma.equipmentSpecNormalized.create({
          data: {
            orgId: context.orgId,
            manufacturer: manufacturerValue,
            model: selectedModel,
            systemType: systemTypeValue,
            tonnage: selectedTonnage,
            btu: selectedBtu === null ? null : Math.round(selectedBtu),
            seer: selectedSeer,
            afue: selectedAfue,
            stages:
              selectedStages === null
                ? null
                : Math.max(1, Math.round(selectedStages)),
            refrigerant: selectedRefrigerant,
            confidence: confidenceValue,
            evidence: toInputJson(selectedEvidence),
          },
        });

    const updatedAssessment = await prisma.systemAssessment.update({
      where: { id: assessment.id },
      data: {
        existingManufacturer: spec.manufacturer,
        existingModel: spec.model,
        existingSystemType: spec.systemType,
        existingTonnage: spec.tonnage,
        existingFurnaceBtu: spec.btu,
        existingSeer: spec.seer,
        existingAfue: spec.afue,
      },
    });

    const lookupRun = await prisma.equipmentLookupRun.create({
      data: {
        orgId: context.orgId,
        assessmentId: assessment.id,
        query: toStringOrNull(input.query) ?? selectedModel,
        results: toInputJson(input.results ?? (selectedPayload ? [selectedPayload] : [])),
        selectedSpecId: spec.id,
      },
    });

    return jsonResult({
      assessmentId: updatedAssessment.id,
      selectedSpecId: spec.id,
      lookupRunId: lookupRun.id,
      spec: {
        id: spec.id,
        manufacturer: spec.manufacturer,
        model: spec.model,
        systemType: spec.systemType,
        tonnage: spec.tonnage,
        btu: spec.btu,
        seer: spec.seer,
        afue: spec.afue,
        confidence: spec.confidence,
      },
    });
  };

  const assessmentCreate: ToolHandler = async ({ context, payload }) => {
    const input = assessmentCreateSchema.parse(payload);

    const assessment = await prisma.systemAssessment.create({
      data: {
        orgId: context.orgId,
        existingManufacturer: toStringOrNull(input.existingManufacturer),
        existingModel: toStringOrNull(input.existingModel),
        existingSystemType: toStringOrNull(input.existingSystemType),
        existingTonnage: toNumberOrNull(input.existingTonnage),
        existingFurnaceBtu:
          typeof input.existingFurnaceBtu === 'number'
            ? Math.round(input.existingFurnaceBtu)
            : null,
        existingSeer: toNumberOrNull(input.existingSeer),
        existingAfue: toNumberOrNull(input.existingAfue),
      },
    });

    return jsonResult({
      assessmentId: assessment.id,
      assessment: {
        id: assessment.id,
        existingManufacturer: assessment.existingManufacturer,
        existingModel: assessment.existingModel,
        existingSystemType: assessment.existingSystemType,
        existingTonnage: assessment.existingTonnage,
        existingFurnaceBtu: assessment.existingFurnaceBtu,
      },
      metadata: input.metadata ?? null,
    });
  };

  const assessmentAttachmentAdd: ToolHandler = async ({ context, payload }) => {
    const input = assessmentAttachmentAddSchema.parse(payload);

    const [assessment, attachmentRef] = await Promise.all([
      prisma.systemAssessment.findFirst({
        where: {
          id: input.assessmentId,
          orgId: context.orgId,
        },
        select: { id: true },
      }),
      prisma.attachmentRef.findFirst({
        where: {
          id: input.attachmentRefId,
          orgId: context.orgId,
        },
        select: { id: true },
      }),
    ]);

    if (!assessment) {
      throw new Error('SystemAssessment not found');
    }
    if (!attachmentRef) {
      throw new Error('AttachmentRef not found');
    }

    const kind =
      input.kind === 'NAMEPLATE_PHOTO'
        ? AssessmentAttachmentKind.NAMEPLATE_PHOTO
        : AssessmentAttachmentKind.NAMEPLATE_PHOTO;

    const assessmentAttachment = await prisma.assessmentAttachment.upsert({
      where: {
        assessmentId_attachmentRefId: {
          assessmentId: assessment.id,
          attachmentRefId: attachmentRef.id,
        },
      },
      update: {
        kind,
      },
      create: {
        orgId: context.orgId,
        assessmentId: assessment.id,
        attachmentRefId: attachmentRef.id,
        kind,
      },
    });

    return jsonResult({
      assessmentAttachmentId: assessmentAttachment.id,
      assessmentId: assessmentAttachment.assessmentId,
      attachmentRefId: assessmentAttachment.attachmentRefId,
      kind: assessmentAttachment.kind,
      createdAt: assessmentAttachment.createdAt.toISOString(),
    });
  };

  const assessmentUpdate: ToolHandler = async ({ context, payload }) => {
    const input = assessmentUpdateSchema.parse(payload);

    const existing = await prisma.systemAssessment.findFirst({
      where: {
        id: input.assessmentId,
        orgId: context.orgId,
      },
    });
    if (!existing) {
      throw new Error('SystemAssessment not found');
    }

    const updated = await prisma.systemAssessment.update({
      where: { id: existing.id },
      data: {
        ...(input.existingManufacturer !== undefined
          ? { existingManufacturer: toStringOrNull(input.existingManufacturer) }
          : {}),
        ...(input.existingModel !== undefined
          ? { existingModel: toStringOrNull(input.existingModel) }
          : {}),
        ...(input.existingSystemType !== undefined
          ? { existingSystemType: toStringOrNull(input.existingSystemType) }
          : {}),
        ...(input.existingTonnage !== undefined
          ? { existingTonnage: toNumberOrNull(input.existingTonnage) }
          : {}),
        ...(input.existingFurnaceBtu !== undefined
          ? {
              existingFurnaceBtu:
                input.existingFurnaceBtu === null
                  ? null
                  : Math.round(input.existingFurnaceBtu),
            }
          : {}),
        ...(input.existingSeer !== undefined
          ? { existingSeer: toNumberOrNull(input.existingSeer) }
          : {}),
        ...(input.existingAfue !== undefined
          ? { existingAfue: toNumberOrNull(input.existingAfue) }
          : {}),
        ...(input.verifiedBySupplyHouse !== undefined
          ? { verifiedBySupplyHouse: input.verifiedBySupplyHouse }
          : {}),
        ...(input.supplyHouseNotes !== undefined
          ? { supplyHouseNotes: toStringOrNull(input.supplyHouseNotes) }
          : {}),
      },
    });

    return jsonResult({
      assessment: {
        id: updated.id,
        existingManufacturer: updated.existingManufacturer,
        existingModel: updated.existingModel,
        existingSystemType: updated.existingSystemType,
        existingTonnage: updated.existingTonnage,
        existingFurnaceBtu: updated.existingFurnaceBtu,
        existingSeer: updated.existingSeer,
        existingAfue: updated.existingAfue,
        verifiedBySupplyHouse: updated.verifiedBySupplyHouse,
        supplyHouseNotes: updated.supplyHouseNotes,
        updatedAt: updated.updatedAt.toISOString(),
      },
      metadata: input.metadata ?? null,
    });
  };

  const assessmentUpdateInstallPricingInputs: ToolHandler = async ({
    context,
    payload,
  }) => {
    const input = assessmentInstallPricingInputsSchema.parse(payload);
    const existing = await prisma.systemAssessment.findFirst({
      where: {
        id: input.assessmentId,
        orgId: context.orgId,
      },
    });
    if (!existing) {
      throw new Error('SystemAssessment not found');
    }

    const manualAdjustment = Math.round(input.manualLaborAdjustmentCents);
    const manualReason = toStringOrNull(input.manualLaborReason);
    if (manualAdjustment !== 0 && !manualReason) {
      throw new Error(
        'manualLaborReason is required when manualLaborAdjustmentCents is non-zero',
      );
    }

    const updated = await prisma.systemAssessment.update({
      where: { id: existing.id },
      data: {
        installType: input.installType as InstallType,
        accessType: input.accessType as InstallAccessType,
        baseLaborCostCents: Math.round(input.baseLaborCostCents),
        manualLaborAdjustmentCents: manualAdjustment,
        manualLaborReason: manualAdjustment === 0 ? null : manualReason,
        permitCostCents: Math.round(input.permitCostCents ?? 0),
      },
    });

    return jsonResult({
      assessment: {
        id: updated.id,
        installType: updated.installType,
        accessType: updated.accessType,
        baseLaborCostCents: updated.baseLaborCostCents,
        manualLaborAdjustmentCents: updated.manualLaborAdjustmentCents,
        manualLaborReason: updated.manualLaborReason,
        permitCostCents: updated.permitCostCents,
        equipmentCostCents: updated.equipmentCostCents,
        materialsCostCents: updated.materialsCostCents,
        updatedAt: updated.updatedAt.toISOString(),
      },
    });
  };

  const quoteGenerateInstallOptions: ToolHandler = async ({ context, payload }) => {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const finalizePendingQuoteId = toStringOrNull(
        (payload as Record<string, unknown>).finalizePendingQuoteId,
      );
      if (context.approvedExecution && finalizePendingQuoteId) {
        const existingQuote = await prisma.quote.findFirst({
          where: {
            id: finalizePendingQuoteId,
            orgId: context.orgId,
          },
          select: {
            id: true,
            metadata: true,
          },
        });
        if (!existingQuote) {
          throw new Error('Pending quote for approval finalization was not found');
        }

        const finalized = await prisma.quote.update({
          where: { id: existingQuote.id },
          data: {
            status: 'DRAFT',
            metadata: toInputJson({
              ...jsonObject(existingQuote.metadata),
              pricingApproval: {
                finalizedAt: new Date().toISOString(),
                finalizedByUserId: context.actorUserId ?? null,
              },
            }),
          },
          include: {
            options: true,
          },
        });

        return jsonResult({
          quote: {
            id: finalized.id,
            status: finalized.status,
            totalCents: finalized.totalCents,
          },
          options: finalized.options.map((option) => ({
            id: option.id,
            optionKey: option.optionKey,
            finalSellPriceCents: option.finalSellPriceCents,
            guardrailStatus: option.guardrailStatus,
          })),
        });
      }
    }

    const input = quoteGenerateInstallOptionsSchema.parse(payload);

    const [lead, assessment] = await Promise.all([
      prisma.lead.findFirst({
        where: {
          id: input.leadId,
          orgId: context.orgId,
        },
      }),
      prisma.systemAssessment.findFirst({
        where: {
          id: input.assessmentId,
          orgId: context.orgId,
        },
      }),
    ]);

    if (!lead) {
      throw new Error('Lead not found');
    }
    if (!assessment) {
      throw new Error('SystemAssessment not found');
    }

    const tierKeys = ['GOOD', 'BETTER', 'BEST'] as const;
    const optionRows = tierKeys.map((tierKey) => {
      const tier = input.tierSelections[tierKey];
      const equipmentCostCents = tier.equipment.reduce(
        (sum, row) => sum + Math.round(row.costCents),
        0,
      );
      const materialsCostCents = tier.materials.reduce(
        (sum, row) => sum + Math.round(row.costCents),
        0,
      );

      const breakdown = computeInstallPriceBreakdown({
        installType: assessment.installType as InstallType,
        accessType: assessment.accessType as InstallAccessType,
        equipmentCostCents,
        materialsCostCents,
        baseLaborCostCents: assessment.baseLaborCostCents,
        manualLaborAdjustmentCents: assessment.manualLaborAdjustmentCents,
        manualLaborReason: assessment.manualLaborReason,
        permitCostCents: assessment.permitCostCents,
      });

      return {
        tierKey,
        tier,
        equipmentCostCents,
        materialsCostCents,
        breakdown,
      };
    });

    const blockedRows = optionRows.filter(
      (row) => row.breakdown.guardrailStatus === 'BLOCK',
    );
    if (blockedRows.length > 0) {
      const reason = `Pricing guardrail BLOCK for ${blockedRows
        .map((row) => row.tierKey)
        .join(', ')}`;
      return handlerGovernanceDirective({
        status: 'BLOCKED',
        reason,
        decision: {
          decision: 'BLOCKED',
          stage: 'PRICING_GUARDRAIL',
          reason,
          details: {
            policyPath: 'pricing.guardrails.block',
            blockedTiers: blockedRows.map((row) => ({
              tier: row.tierKey,
              effectiveMarginBps: row.breakdown.effectiveMarginBps,
              reasons: row.breakdown.guardrailReasons,
            })),
          },
        },
      });
    }

    const requiresApproval = optionRows.some(
      (row) => row.breakdown.guardrailStatus === 'REQUIRE_APPROVAL',
    );
    const quoteStatus = requiresApproval ? 'PENDING_APPROVAL' : 'DRAFT';
    const maxTotal = optionRows.reduce(
      (max, row) => Math.max(max, row.breakdown.finalSellPriceCents),
      0,
    );

    const quote = await prisma.quote.create({
      data: {
        orgId: context.orgId,
        leadId: lead.id,
        assessmentId: assessment.id,
        status: quoteStatus,
        totalCents: maxTotal,
        metadata: toInputJson({
          pricingMode:
            QuotePricingMode.INSTALL_CUSHION20_FLOOR_ACCESS500_SALES5_DISCOUNT,
        }),
      },
    });

    await prisma.quoteOption.createMany({
      data: optionRows.map((row) => ({
        orgId: context.orgId,
        quoteId: quote.id,
        optionKey: row.tierKey,
        label: row.tierKey,
        pricingMode:
          QuotePricingMode.INSTALL_CUSHION20_FLOOR_ACCESS500_SALES5_DISCOUNT,
        cushionPct: row.breakdown.cushionPct,
        equipmentAdjustedCents: row.breakdown.equipmentAdjustedCents,
        materialsAdjustedCents: row.breakdown.materialsAdjustedCents,
        laborTotalCents: row.breakdown.laborTotalCents,
        adjustedCostCents: row.breakdown.adjustedCostCents,
        profitFloorCents: row.breakdown.profitFloorCents,
        accessAddOnCents: row.breakdown.accessAddOnCents,
        basePriceCents: row.breakdown.basePriceCents,
        salesCushionPct: row.breakdown.salesCushionPct,
        priceBeforeDiscountCents: row.breakdown.priceBeforeDiscountCents,
        discountPctBps: 0,
        discountCents: 0,
        discountTotalCents: 0,
        discountReason: null,
        finalSellPriceCents: row.breakdown.finalSellPriceCents,
        rawCostTotalCents: row.breakdown.rawCostTotalCents,
        effectiveProfitCents: row.breakdown.effectiveProfitCents,
        effectiveMarginBps: row.breakdown.effectiveMarginBps,
        guardrailStatus: row.breakdown.guardrailStatus as GuardrailStatus,
        guardrailReasons: toInputJson(row.breakdown.guardrailReasons),
        equipmentSelection: toInputJson(row.tier.equipment),
        materialsSelection: toInputJson(row.tier.materials),
        metadata: toInputJson({
          tier: row.tierKey,
          equipmentCostCents: row.equipmentCostCents,
          materialsCostCents: row.materialsCostCents,
          installType: assessment.installType,
          accessType: assessment.accessType,
          baseLaborCostCents: assessment.baseLaborCostCents,
          manualLaborAdjustmentCents: assessment.manualLaborAdjustmentCents,
          permitCostCents: assessment.permitCostCents,
        }),
      })),
    });

    await prisma.systemAssessment.update({
      where: { id: assessment.id },
      data: {
        equipmentCostCents: optionRows[0]?.equipmentCostCents ?? 0,
        materialsCostCents: optionRows[0]?.materialsCostCents ?? 0,
      },
    });

    const savedOptions = await prisma.quoteOption.findMany({
      where: {
        orgId: context.orgId,
        quoteId: quote.id,
      },
      orderBy: { optionKey: 'asc' },
    });

    if (requiresApproval && !context.approvedExecution) {
      const reason =
        'One or more options fall below the 15% effective margin threshold and require approval.';
      return handlerGovernanceDirective({
        status: 'QUEUED_APPROVAL',
        reason,
        requiredApprovals: 1,
        approvalPayload: {
          finalizePendingQuoteId: quote.id,
        },
        decision: {
          decision: 'QUEUED_APPROVAL',
          stage: 'PRICING_GUARDRAIL',
          reason,
          details: {
            policyPath: 'pricing.guardrails.require_approval',
            quoteId: quote.id,
            tiers: optionRows.map((row) => ({
              tier: row.tierKey,
              status: row.breakdown.guardrailStatus,
              effectiveMarginBps: row.breakdown.effectiveMarginBps,
            })),
          },
        },
        output: {
          quote: {
            id: quote.id,
            status: quote.status,
            totalCents: quote.totalCents,
          },
          options: savedOptions.map((option) => ({
            id: option.id,
            optionKey: option.optionKey,
            finalSellPriceCents: option.finalSellPriceCents,
            guardrailStatus: option.guardrailStatus,
          })),
        } as Prisma.JsonValue,
      });
    }

    return jsonResult({
      quote: {
        id: quote.id,
        status: quote.status,
        totalCents: quote.totalCents,
      },
      options: savedOptions.map((option) => ({
        id: option.id,
        optionKey: option.optionKey,
        label: option.label,
        finalSellPriceCents: option.finalSellPriceCents,
        priceBeforeDiscountCents: option.priceBeforeDiscountCents,
        discountTotalCents: option.discountTotalCents,
        guardrailStatus: option.guardrailStatus,
      })),
    });
  };

  const quoteApplyDiscount: ToolHandler = async ({ context, payload }) => {
    const input = quoteApplyDiscountSchema.parse(payload);
    const quoteOption = await prisma.quoteOption.findFirst({
      where: {
        id: input.quoteOptionId,
        orgId: context.orgId,
      },
      include: {
        quote: true,
      },
    });
    if (!quoteOption) {
      throw new Error('Quote option not found');
    }

    const discountPctBps = Math.round(input.discountPctBps ?? 0);
    const discountCents = Math.round(input.discountCents ?? 0);
    const reason = toStringOrNull(input.reason);
    const hasDiscount = discountPctBps > 0 || discountCents > 0;
    if (hasDiscount && !reason) {
      throw new Error('Discount reason is required');
    }

    const access = await resolveActorAccess({
      orgId: context.orgId,
      actorUserId: context.actorUserId,
    });
    if (discountPctBps > 0 && !actorHasPermission(access.permissions, 'pricing:discount:apply_pct')) {
      throw new Error('Missing permission: pricing:discount:apply_pct');
    }
    if (discountCents > 0 && !actorHasPermission(access.permissions, 'pricing:discount:apply_cents')) {
      throw new Error('Missing permission: pricing:discount:apply_cents');
    }

    const discountTotalCents = computeDiscountAmount(
      quoteOption.priceBeforeDiscountCents,
      discountPctBps,
      discountCents,
    );
    const finalSellPriceCents = Math.max(
      0,
      quoteOption.priceBeforeDiscountCents - discountTotalCents,
    );
    const guardrail = evaluateInstallGuardrail(
      quoteOption.rawCostTotalCents,
      finalSellPriceCents,
    );

    const roleTier = resolveDiscountTier(access.roles);
    const limitCents = discountLimitForTier(
      roleTier,
      quoteOption.priceBeforeDiscountCents,
    );
    const hasOverrideLimitsPermission = actorHasPermission(
      access.permissions,
      'pricing:discount:override_limits',
    );
    const exceedsLimit =
      Number.isFinite(limitCents) &&
      discountTotalCents > limitCents &&
      !hasOverrideLimitsPermission;

    if (guardrail.status === 'BLOCK') {
      const reasonText =
        'Discount drives this option below the 12% effective margin block threshold.';
      const blockedOption = await prisma.quoteOption.update({
        where: { id: quoteOption.id },
        data: {
          discountPctBps,
          discountCents,
          discountTotalCents,
          discountReason: hasDiscount ? reason : null,
          finalSellPriceCents,
          effectiveProfitCents: guardrail.effectiveProfitCents,
          effectiveMarginBps: guardrail.effectiveMarginBps,
          guardrailStatus: GuardrailStatus.BLOCK,
          guardrailReasons: toInputJson(guardrail.reasons),
        },
      });

      const allOptions = await prisma.quoteOption.findMany({
        where: {
          orgId: context.orgId,
          quoteId: quoteOption.quoteId,
        },
        select: {
          finalSellPriceCents: true,
        },
      });
      const maxTotal = allOptions.reduce(
        (max, row) => Math.max(max, row.finalSellPriceCents),
        0,
      );
      await prisma.quote.update({
        where: { id: quoteOption.quoteId },
        data: {
          totalCents: maxTotal,
        },
      });

      return handlerGovernanceDirective({
        status: 'BLOCKED',
        reason: reasonText,
        decision: {
          decision: 'BLOCKED',
          stage: 'PRICING_GUARDRAIL',
          reason: reasonText,
          details: {
            policyPath: 'pricing.guardrails.block',
            quoteOptionId: quoteOption.id,
            effectiveMarginBps: guardrail.effectiveMarginBps,
            reasons: guardrail.reasons,
            blockedOptionId: blockedOption.id,
          },
        },
      });
    }

    if (exceedsLimit && !context.approvedExecution) {
      const reasonText =
        'Requested discount exceeds actor limit and requires approval.';
      return handlerGovernanceDirective({
        status: 'QUEUED_APPROVAL',
        reason: reasonText,
        requiredApprovals: 1,
        approvalPayload: {
          quoteOptionId: quoteOption.id,
          discountPctBps,
          discountCents,
          reason,
        },
        decision: {
          decision: 'QUEUED_APPROVAL',
          stage: 'PRICING_DISCOUNT_LIMIT',
          reason: reasonText,
          details: {
            policyPath: `pricing.discountLimits.${roleTier.toLowerCase()}`,
            quoteOptionId: quoteOption.id,
            roleTier,
            limitCents,
            requestedDiscountCents: discountTotalCents,
            hasOverrideLimitsPermission,
          },
        },
      });
    }

    if (guardrail.status === 'REQUIRE_APPROVAL' && !context.approvedExecution) {
      const reasonText =
        'Discount lowers effective margin below 15% and requires approval.';
      return handlerGovernanceDirective({
        status: 'QUEUED_APPROVAL',
        reason: reasonText,
        requiredApprovals: 1,
        approvalPayload: {
          quoteOptionId: quoteOption.id,
          discountPctBps,
          discountCents,
          reason,
        },
        decision: {
          decision: 'QUEUED_APPROVAL',
          stage: 'PRICING_GUARDRAIL',
          reason: reasonText,
          details: {
            policyPath: 'pricing.guardrails.require_approval',
            quoteOptionId: quoteOption.id,
            effectiveMarginBps: guardrail.effectiveMarginBps,
            reasons: guardrail.reasons,
          },
        },
      });
    }

    const updated = await prisma.quoteOption.update({
      where: {
        id: quoteOption.id,
      },
      data: {
        discountPctBps,
        discountCents,
        discountTotalCents,
        discountReason: hasDiscount ? reason : null,
        finalSellPriceCents,
        effectiveProfitCents: guardrail.effectiveProfitCents,
        effectiveMarginBps: guardrail.effectiveMarginBps,
        guardrailStatus: guardrail.status as GuardrailStatus,
        guardrailReasons: toInputJson(guardrail.reasons),
      },
    });

    const allOptions = await prisma.quoteOption.findMany({
      where: {
        orgId: context.orgId,
        quoteId: quoteOption.quoteId,
      },
      select: {
        finalSellPriceCents: true,
      },
    });
    const maxTotal = allOptions.reduce(
      (max, row) => Math.max(max, row.finalSellPriceCents),
      0,
    );
    await prisma.quote.update({
      where: { id: quoteOption.quoteId },
      data: {
        totalCents: maxTotal,
      },
    });

    return jsonResult({
      quoteOption: {
        id: updated.id,
        quoteId: updated.quoteId,
        optionKey: updated.optionKey,
        priceBeforeDiscountCents: updated.priceBeforeDiscountCents,
        discountPctBps: updated.discountPctBps,
        discountCents: updated.discountCents,
        discountTotalCents: updated.discountTotalCents,
        finalSellPriceCents: updated.finalSellPriceCents,
        effectiveMarginBps: updated.effectiveMarginBps,
        guardrailStatus: updated.guardrailStatus,
      },
    });
  };

  const serviceQuoteCreateFromBundle: ToolHandler = async ({ context, payload }) => {
    const input = serviceQuoteCreateFromBundleSchema.parse(payload);

    return prisma.$transaction(async (tx) => {
      const [lead, customer, bundle] = await Promise.all([
        tx.lead.findFirst({
          where: {
            id: input.leadId,
            orgId: context.orgId,
          },
          select: { id: true },
        }),
        input.customerId
          ? tx.customer.findFirst({
              where: {
                id: input.customerId,
                orgId: context.orgId,
              },
              select: { id: true },
            })
          : Promise.resolve(null),
        tx.serviceBundleTemplate.findFirst({
          where: {
            id: input.bundleTemplateId,
            orgId: context.orgId,
            active: true,
          },
        }),
      ]);

      if (!lead) {
        throw new Error('Lead not found');
      }
      if (input.customerId && !customer) {
        throw new Error('Customer not found');
      }
      if (!bundle) {
        throw new Error('Service bundle template not found');
      }

      const now = new Date();
      const membership = input.customerId
        ? await tx.customerMembership.findFirst({
            where: {
              orgId: context.orgId,
              customerId: input.customerId,
              status: MembershipStatus.ACTIVE,
              startAt: { lte: now },
              OR: [{ endAt: null }, { endAt: { gte: now } }],
            },
            orderBy: [{ startAt: 'desc' }],
            select: {
              id: true,
              planId: true,
            },
          })
        : null;
      const isMember = Boolean(membership);

      const baseItemIds = extractStringArray(bundle.baseItemIds);
      const recommendedAddOnItemIds = extractStringArray(
        bundle.recommendedAddOnItemIds,
      );

      const diagnosticItem = bundle.includeDiagnostic
        ? await resolveDiagnosticPricebookItem(tx, context.orgId)
        : null;
      const diagnosticItemId = diagnosticItem?.id ?? null;

      const desiredBaseIds = [...baseItemIds];
      if (bundle.includeDiagnostic && diagnosticItemId) {
        desiredBaseIds.unshift(diagnosticItemId);
      }
      const uniqueBaseIds = [...new Set(desiredBaseIds)];

      const baseItems = await tx.pricebookItem.findMany({
        where: {
          orgId: context.orgId,
          id: { in: uniqueBaseIds },
          active: true,
        },
        include: {
          category: true,
        },
      });

      const baseItemById = new Map(baseItems.map((item) => [item.id, item]));
      const quote = await tx.quote.create({
        data: {
          orgId: context.orgId,
          leadId: lead.id,
          customerId: customer?.id ?? null,
          kind: QuoteKind.SERVICE,
          status: 'DRAFT',
          timing: input.timing as ServiceTiming,
          isMember,
          laborHours: bundle.defaultLaborHours,
          metadata: toInputJson({
            servicePricing: {
              sourceBundleTemplateId: bundle.id,
              diagnosticItemId,
              recommendedAddOnItemIds,
              membershipSnapshotId: membership?.id ?? null,
            },
          }),
        },
      });

      let sortOrder = 1;
      for (const itemId of uniqueBaseIds) {
        const item = baseItemById.get(itemId);
        if (!item) {
          continue;
        }
        await tx.quoteLineItem.create({
          data: {
            orgId: context.orgId,
            quoteId: quote.id,
            itemType: QuoteLineItemType.PRICEBOOK_ITEM,
            pricebookItemId: item.id,
            categorySlugSnapshot: item.category.slug,
            kindSnapshot: item.kind,
            nameSnapshot: item.name,
            descriptionSnapshot: item.description,
            qty: 1,
            unitPriceCents: item.defaultSellCents,
            lineTotalCents: item.defaultSellCents,
            sortOrder,
            meta: toInputJson({
              sourceBundleId: bundle.id,
              isDiagnosticFee: diagnosticItemId === item.id,
            }),
          },
        });
        sortOrder += 1;
      }

      const { quote: updatedQuote, lineItems, computed } =
        await persistServiceQuoteComputedState({
          tx,
          quote,
          lineItems: await tx.quoteLineItem.findMany({
            where: { orgId: context.orgId, quoteId: quote.id },
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          }),
        });

      const recommendedAddOnItems = recommendedAddOnItemIds.length
        ? await tx.pricebookItem.findMany({
            where: {
              orgId: context.orgId,
              id: { in: recommendedAddOnItemIds },
              active: true,
            },
            include: {
              category: true,
            },
            orderBy: { name: 'asc' },
          })
        : [];

      return jsonResult({
        quote: {
          id: updatedQuote.id,
          kind: updatedQuote.kind,
          status: updatedQuote.status,
          timing: updatedQuote.timing,
          isMember: updatedQuote.isMember,
          laborHours: updatedQuote.laborHours,
          laborHoursRounded: updatedQuote.laborHoursRounded,
          laborRateCents: updatedQuote.laborRateCents,
          subtotalCents: updatedQuote.subtotalCents,
          laborTotalCents: updatedQuote.laborTotalCents,
          totalBeforeDiscountCents: updatedQuote.totalBeforeDiscountCents,
          discountTotalCents: updatedQuote.discountTotalCents,
          finalTotalCents: updatedQuote.finalTotalCents,
          guardrailStatus: updatedQuote.guardrailStatus,
        },
        lineItems: lineItems.map((line) => ({
          id: line.id,
          nameSnapshot: line.nameSnapshot,
          qty: line.qty,
          unitPriceCents: line.unitPriceCents,
          lineTotalCents: line.lineTotalCents,
          meta: line.meta,
        })),
        recommendedAddOnItems: recommendedAddOnItems.map((item) => ({
          id: item.id,
          name: item.name,
          defaultSellCents: item.defaultSellCents,
          categorySlug: item.category.slug,
          kind: item.kind,
        })),
        computed: {
          diagnosticFeeCents: computed.diagnosticFeeCents,
          repairSubtotalCents: computed.repairSubtotalCents,
          diagnosticCreditCents: computed.diagnosticCreditCents,
        },
      });
    });
  };

  const serviceQuoteAddLineItem: ToolHandler = async ({ context, payload }) => {
    const input = serviceQuoteAddLineItemSchema.parse(payload);
    if (!input.pricebookItemId && !input.custom) {
      throw new Error('Either pricebookItemId or custom line item must be provided');
    }
    if (input.pricebookItemId && input.custom) {
      throw new Error('Provide either pricebookItemId or custom, not both');
    }

    return prisma.$transaction(async (tx) => {
      const { quote, lineItems } = await resolveServiceQuoteContext(
        tx,
        context.orgId,
        input.quoteId,
      );

      const maxSortOrder = lineItems.reduce(
        (max, line) => Math.max(max, line.sortOrder),
        0,
      );
      const sortOrder =
        typeof input.sortOrder === 'number' ? input.sortOrder : maxSortOrder + 1;
      const qty = Math.max(1, input.qty ?? 1);

      let diagnosticItemId = toStringOrNull(
        jsonObject(jsonObject(quote.metadata).servicePricing as Prisma.JsonValue)
          .diagnosticItemId,
      );
      const diagnosticItem =
        diagnosticItemId !== null
          ? await tx.pricebookItem.findFirst({
              where: {
                id: diagnosticItemId,
                orgId: context.orgId,
              },
              include: { category: true },
            })
          : await resolveDiagnosticPricebookItem(tx, context.orgId);
      if (!diagnosticItemId && diagnosticItem) {
        diagnosticItemId = diagnosticItem.id;
      }

      if (input.pricebookItemId) {
        const item = await tx.pricebookItem.findFirst({
          where: {
            id: input.pricebookItemId,
            orgId: context.orgId,
            active: true,
          },
          include: {
            category: true,
          },
        });
        if (!item) {
          throw new Error('Pricebook item not found');
        }

        if (
          diagnosticItemId &&
          item.id === diagnosticItemId &&
          lineItems.some(
            (line) =>
              !isServiceDiagnosticCreditMeta(line.meta) &&
              line.pricebookItemId === diagnosticItemId,
          )
        ) {
          throw new Error('Only one diagnostic fee line is allowed per quote');
        }

        await tx.quoteLineItem.create({
          data: {
            orgId: context.orgId,
            quoteId: quote.id,
            itemType: QuoteLineItemType.PRICEBOOK_ITEM,
            pricebookItemId: item.id,
            categorySlugSnapshot: item.category.slug,
            kindSnapshot: item.kind,
            nameSnapshot: item.name,
            descriptionSnapshot: item.description,
            qty,
            unitPriceCents: item.defaultSellCents,
            lineTotalCents: item.defaultSellCents * qty,
            sortOrder,
            meta: toInputJson({
              isDiagnosticFee: diagnosticItemId === item.id,
            }),
          },
        });

        if (diagnosticItemId === item.id) {
          await tx.quote.update({
            where: { id: quote.id },
            data: {
              metadata: toInputJson({
                ...jsonObject(quote.metadata),
                servicePricing: {
                  ...jsonObject(
                    jsonObject(quote.metadata).servicePricing as Prisma.JsonValue,
                  ),
                  diagnosticItemId,
                },
              }),
            },
          });
        }
      } else if (input.custom) {
        await tx.quoteLineItem.create({
          data: {
            orgId: context.orgId,
            quoteId: quote.id,
            itemType: QuoteLineItemType.CUSTOM,
            pricebookItemId: null,
            categorySlugSnapshot: toStringOrNull(input.custom.categorySlug),
            kindSnapshot: toStringOrNull(input.custom.kindSnapshot),
            nameSnapshot: input.custom.name.trim(),
            descriptionSnapshot: toStringOrNull(input.custom.description),
            qty,
            unitPriceCents: Math.round(input.custom.unitPriceCents),
            lineTotalCents: Math.round(input.custom.unitPriceCents) * qty,
            sortOrder,
            meta: toInputJson(input.custom.meta ?? {}),
          },
        });
      }

      const refreshedContext = await resolveServiceQuoteContext(
        tx,
        context.orgId,
        quote.id,
      );
      const recomputed = await persistServiceQuoteComputedState({
        tx,
        quote: refreshedContext.quote,
        lineItems: refreshedContext.lineItems,
      });

      return jsonResult({
        quote: {
          id: recomputed.quote.id,
          finalTotalCents: recomputed.quote.finalTotalCents,
          totalBeforeDiscountCents: recomputed.quote.totalBeforeDiscountCents,
          laborHoursRounded: recomputed.quote.laborHoursRounded,
          laborRateCents: recomputed.quote.laborRateCents,
          guardrailStatus: recomputed.quote.guardrailStatus,
        },
        lineItems: recomputed.lineItems.map((line) => ({
          id: line.id,
          nameSnapshot: line.nameSnapshot,
          qty: line.qty,
          unitPriceCents: line.unitPriceCents,
          lineTotalCents: line.lineTotalCents,
          meta: line.meta,
        })),
      });
    });
  };

  const serviceQuoteRemoveLineItem: ToolHandler = async ({ context, payload }) => {
    const input = serviceQuoteRemoveLineItemSchema.parse(payload);

    return prisma.$transaction(async (tx) => {
      const lineItem = await tx.quoteLineItem.findFirst({
        where: {
          id: input.quoteLineItemId,
          orgId: context.orgId,
        },
        include: {
          quote: true,
        },
      });
      if (!lineItem) {
        throw new Error('Quote line item not found');
      }
      if (lineItem.quote.kind !== QuoteKind.SERVICE) {
        throw new Error('Line item does not belong to a service quote');
      }

      await tx.quoteLineItem.delete({
        where: { id: lineItem.id },
      });

      const refreshedContext = await resolveServiceQuoteContext(
        tx,
        context.orgId,
        lineItem.quoteId,
      );
      const recomputed = await persistServiceQuoteComputedState({
        tx,
        quote: refreshedContext.quote,
        lineItems: refreshedContext.lineItems,
      });

      return jsonResult({
        quote: {
          id: recomputed.quote.id,
          finalTotalCents: recomputed.quote.finalTotalCents,
          subtotalCents: recomputed.quote.subtotalCents,
          laborTotalCents: recomputed.quote.laborTotalCents,
          guardrailStatus: recomputed.quote.guardrailStatus,
        },
        removedLineItemId: lineItem.id,
      });
    });
  };

  const serviceQuoteSetLaborHours: ToolHandler = async ({ context, payload }) => {
    const input = serviceQuoteSetLaborHoursSchema.parse(payload);
    return prisma.$transaction(async (tx) => {
      const { quote } = await resolveServiceQuoteContext(tx, context.orgId, input.quoteId);

      await tx.quote.update({
        where: { id: quote.id },
        data: {
          laborHours: input.laborHours,
        },
      });

      const refreshedContext = await resolveServiceQuoteContext(
        tx,
        context.orgId,
        quote.id,
      );
      const recomputed = await persistServiceQuoteComputedState({
        tx,
        quote: refreshedContext.quote,
        lineItems: refreshedContext.lineItems,
      });

      return jsonResult({
        quote: {
          id: recomputed.quote.id,
          laborHours: recomputed.quote.laborHours,
          laborHoursRounded: recomputed.quote.laborHoursRounded,
          laborRateCents: recomputed.quote.laborRateCents,
          laborTotalCents: recomputed.quote.laborTotalCents,
          finalTotalCents: recomputed.quote.finalTotalCents,
          roundedNotice: `Rounded to nearest 0.5 hour: ${roundToNearestHalfHour(
            input.laborHours,
          ).toFixed(1)} hours`,
        },
      });
    });
  };

  const serviceQuoteSetTiming: ToolHandler = async ({ context, payload }) => {
    const input = serviceQuoteSetTimingSchema.parse(payload);
    return prisma.$transaction(async (tx) => {
      const { quote } = await resolveServiceQuoteContext(tx, context.orgId, input.quoteId);
      await tx.quote.update({
        where: { id: quote.id },
        data: {
          timing: input.timing as ServiceTiming,
        },
      });

      const refreshedContext = await resolveServiceQuoteContext(
        tx,
        context.orgId,
        quote.id,
      );
      const recomputed = await persistServiceQuoteComputedState({
        tx,
        quote: refreshedContext.quote,
        lineItems: refreshedContext.lineItems,
      });

      return jsonResult({
        quote: {
          id: recomputed.quote.id,
          timing: recomputed.quote.timing,
          isMember: recomputed.quote.isMember,
          laborRateCents: recomputed.quote.laborRateCents,
          laborTotalCents: recomputed.quote.laborTotalCents,
          finalTotalCents: recomputed.quote.finalTotalCents,
        },
      });
    });
  };

  const serviceQuoteApplyDiscount: ToolHandler = async ({ context, payload }) => {
    const input = serviceQuoteApplyDiscountSchema.parse(payload);
    const discountPctBps = Math.round(input.discountPctBps ?? 0);
    const discountCents = Math.round(input.discountCents ?? 0);
    const reason = toStringOrNull(input.reason);
    const hasDiscount = discountPctBps > 0 || discountCents > 0;

    if (hasDiscount && !reason) {
      throw new Error('Discount reason is required');
    }

    const access = await resolveActorAccess({
      orgId: context.orgId,
      actorUserId: context.actorUserId,
    });
    if (discountPctBps > 0 && !actorHasPermission(access.permissions, 'pricing:discount:apply_pct')) {
      throw new Error('Missing permission: pricing:discount:apply_pct');
    }
    if (discountCents > 0 && !actorHasPermission(access.permissions, 'pricing:discount:apply_cents')) {
      throw new Error('Missing permission: pricing:discount:apply_cents');
    }

    return prisma.$transaction(async (tx) => {
      const { quote, lineItems } = await resolveServiceQuoteContext(
        tx,
        context.orgId,
        input.quoteId,
      );

      const diagnosticItemId = toStringOrNull(
        jsonObject(jsonObject(quote.metadata).servicePricing as Prisma.JsonValue)
          .diagnosticItemId,
      );
      const computed = computeServiceQuoteTotals({
        timing: quote.timing as ServiceTiming,
        isMember: quote.isMember,
        laborHours: quote.laborHours,
        discountPctBps,
        discountCents,
        diagnosticItemId,
        repairCategorySlug: 'repair',
        maintenanceCategorySlug: 'maintenance',
        lineItems: lineItems
          .filter((line) => !isServiceDiagnosticCreditMeta(line.meta))
          .map((line) => ({
            itemType: line.itemType as 'PRICEBOOK_ITEM' | 'CUSTOM',
            pricebookItemId: line.pricebookItemId,
            categorySlugSnapshot: line.categorySlugSnapshot,
            kindSnapshot: line.kindSnapshot,
            nameSnapshot: line.nameSnapshot,
            descriptionSnapshot: line.descriptionSnapshot,
            qty: line.qty,
            unitPriceCents: line.unitPriceCents,
            lineTotalCents: line.lineTotalCents,
            sortOrder: line.sortOrder,
            meta: jsonObject(line.meta),
          })),
      });

      const roleTier = resolveDiscountTier(access.roles);
      const limitCents = discountLimitForTier(roleTier, computed.totalBeforeDiscountCents);
      const hasOverrideLimitsPermission = actorHasPermission(
        access.permissions,
        'pricing:discount:override_limits',
      );
      const exceedsLimit =
        Number.isFinite(limitCents) &&
        computed.discountTotalCents > limitCents &&
        !hasOverrideLimitsPermission;

      if (computed.guardrailStatus === 'BLOCK') {
        const recomputed = await persistServiceQuoteComputedState({
          tx,
          quote,
          lineItems,
          discountPctBps,
          discountCents,
        });
        await tx.quote.update({
          where: { id: quote.id },
          data: {
            discountReason: hasDiscount ? reason : null,
          },
        });

        const reasonText = 'Service quote total is below floor after discount and is blocked.';
        return handlerGovernanceDirective({
          status: 'BLOCKED',
          reason: reasonText,
          decision: {
            decision: 'BLOCKED',
            stage: 'PRICING_GUARDRAIL',
            reason: reasonText,
            details: {
              policyPath: 'servicePricing.floor.block',
              quoteId: quote.id,
              finalTotalCents: recomputed.quote.finalTotalCents,
              floorCents: computed.floorCents,
              maintenanceOnly: computed.maintenanceOnly,
            },
          },
        });
      }

      if (exceedsLimit && !context.approvedExecution) {
        const reasonText =
          'Requested discount exceeds actor limit and requires approval.';
        await tx.quote.update({
          where: { id: quote.id },
          data: {
            guardrailStatus: GuardrailStatus.REQUIRE_APPROVAL,
            guardrailReasons: toInputJson([
              {
                code: 'DISCOUNT_LIMIT_APPROVAL_REQUIRED',
                reason: reasonText,
                roleTier,
                limitCents,
                requestedDiscountCents: computed.discountTotalCents,
              },
            ]),
          },
        });
        return handlerGovernanceDirective({
          status: 'QUEUED_APPROVAL',
          reason: reasonText,
          requiredApprovals: 1,
          approvalPayload: {
            quoteId: quote.id,
            discountPctBps,
            discountCents,
            reason,
          },
          decision: {
            decision: 'QUEUED_APPROVAL',
            stage: 'PRICING_DISCOUNT_LIMIT',
            reason: reasonText,
            details: {
              policyPath: `pricing.discountLimits.${roleTier.toLowerCase()}`,
              quoteId: quote.id,
              roleTier,
              limitCents,
              requestedDiscountCents: computed.discountTotalCents,
              hasOverrideLimitsPermission,
            },
          },
        });
      }

      const recomputed = await persistServiceQuoteComputedState({
        tx,
        quote,
        lineItems,
        discountPctBps,
        discountCents,
      });
      const updatedQuote = await tx.quote.update({
        where: { id: quote.id },
        data: {
          discountReason: hasDiscount ? reason : null,
        },
      });

      return jsonResult({
        quote: {
          id: updatedQuote.id,
          discountPctBps: updatedQuote.discountPctBps,
          discountCents: updatedQuote.discountCents,
          discountTotalCents: updatedQuote.discountTotalCents,
          totalBeforeDiscountCents: updatedQuote.totalBeforeDiscountCents,
          finalTotalCents: updatedQuote.finalTotalCents,
          guardrailStatus: updatedQuote.guardrailStatus,
          laborHoursRounded: updatedQuote.laborHoursRounded,
          laborRateCents: updatedQuote.laborRateCents,
        },
        lineItems: recomputed.lineItems.map((line) => ({
          id: line.id,
          nameSnapshot: line.nameSnapshot,
          lineTotalCents: line.lineTotalCents,
          meta: line.meta,
        })),
      });
    });
  };

  const adminBundleTemplateUpsert: ToolHandler = async ({ context, payload }) => {
    const input = adminBundleTemplateUpsertSchema.parse(payload);

    const existing = input.id
      ? await prisma.serviceBundleTemplate.findFirst({
          where: {
            id: input.id,
            orgId: context.orgId,
          },
        })
      : await prisma.serviceBundleTemplate.findFirst({
          where: {
            orgId: context.orgId,
            name: input.name,
          },
          orderBy: { createdAt: 'asc' },
        });

    const record = existing
      ? await prisma.serviceBundleTemplate.update({
          where: { id: existing.id },
          data: {
            name: input.name,
            active: input.active ?? true,
            includeDiagnostic: input.includeDiagnostic ?? true,
            defaultLaborHours: input.defaultLaborHours ?? 0,
            baseItemIds: toInputJson(input.baseItemIds ?? []),
            recommendedAddOnItemIds: toInputJson(
              input.recommendedAddOnItemIds ?? [],
            ),
          },
        })
      : await prisma.serviceBundleTemplate.create({
          data: {
            orgId: context.orgId,
            name: input.name,
            active: input.active ?? true,
            includeDiagnostic: input.includeDiagnostic ?? true,
            defaultLaborHours: input.defaultLaborHours ?? 0,
            baseItemIds: toInputJson(input.baseItemIds ?? []),
            recommendedAddOnItemIds: toInputJson(
              input.recommendedAddOnItemIds ?? [],
            ),
          },
        });

    return jsonResult({
      bundleTemplate: {
        id: record.id,
        name: record.name,
        active: record.active,
        includeDiagnostic: record.includeDiagnostic,
        defaultLaborHours: record.defaultLaborHours,
        baseItemIds: record.baseItemIds,
        recommendedAddOnItemIds: record.recommendedAddOnItemIds,
      },
      action: existing ? 'updated' : 'created',
    });
  };

  const adminPricebookCategoryUpsert: ToolHandler = async ({ context, payload }) => {
    const input = adminPricebookCategoryUpsertSchema.parse(payload);

    const existing = input.id
      ? await prisma.pricebookCategory.findFirst({
          where: {
            id: input.id,
            orgId: context.orgId,
          },
        })
      : await prisma.pricebookCategory.findFirst({
          where: {
            orgId: context.orgId,
            slug: input.slug.trim().toLowerCase(),
          },
          orderBy: { createdAt: 'asc' },
        });

    const record = existing
      ? await prisma.pricebookCategory.update({
          where: { id: existing.id },
          data: {
            name: input.name,
            slug: input.slug.trim().toLowerCase(),
          },
        })
      : await prisma.pricebookCategory.create({
          data: {
            orgId: context.orgId,
            name: input.name,
            slug: input.slug.trim().toLowerCase(),
          },
        });

    return jsonResult({
      category: {
        id: record.id,
        name: record.name,
        slug: record.slug,
      },
      action: existing ? 'updated' : 'created',
    });
  };

  const adminPricebookItemUpsert: ToolHandler = async ({ context, payload }) => {
    const input = adminPricebookItemUpsertSchema.parse(payload);
    const category = await prisma.pricebookCategory.findFirst({
      where: {
        id: input.categoryId,
        orgId: context.orgId,
      },
    });
    if (!category) {
      throw new Error('Pricebook category not found');
    }

    const existing = input.id
      ? await prisma.pricebookItem.findFirst({
          where: {
            id: input.id,
            orgId: context.orgId,
          },
        })
      : await prisma.pricebookItem.findFirst({
          where: {
            orgId: context.orgId,
            categoryId: category.id,
            name: input.name,
          },
          orderBy: { createdAt: 'asc' },
        });

    const record = existing
      ? await prisma.pricebookItem.update({
          where: { id: existing.id },
          data: {
            categoryId: category.id,
            kind: input.kind as PricebookItemKind,
            name: input.name,
            description: toStringOrNull(input.description),
            unitType: toStringOrNull(input.unitType) ?? 'EA',
            defaultSellCents: input.defaultSellCents,
            active: input.active ?? true,
            tags: input.tags ?? [],
          },
        })
      : await prisma.pricebookItem.create({
          data: {
            orgId: context.orgId,
            categoryId: category.id,
            kind: input.kind as PricebookItemKind,
            name: input.name,
            description: toStringOrNull(input.description),
            unitType: toStringOrNull(input.unitType) ?? 'EA',
            defaultSellCents: input.defaultSellCents,
            active: input.active ?? true,
            tags: input.tags ?? [],
          },
        });

    return jsonResult({
      item: {
        id: record.id,
        categoryId: record.categoryId,
        kind: record.kind,
        name: record.name,
        defaultSellCents: record.defaultSellCents,
        active: record.active,
      },
      action: existing ? 'updated' : 'created',
    });
  };

  const pricingOverrideBlock: ToolHandler = async ({ context, payload }) => {
    const input = servicePricingOverrideBlockSchema.parse(payload);
    if (context.actorType !== ActorType.HUMAN || context.isAutonomous) {
      throw new Error('system.pricing.overrideBlock requires a human non-autonomous actor');
    }
    const access = await resolveActorAccess({
      orgId: context.orgId,
      actorUserId: context.actorUserId,
    });
    if (!actorHasPermission(access.permissions, 'pricing:block:override')) {
      throw new Error('Missing permission: pricing:block:override');
    }

    if (!input.quoteId && !input.quoteOptionId) {
      throw new Error('quoteId or quoteOptionId is required');
    }

    if (input.quoteId) {
      const quote = await prisma.quote.findFirst({
        where: {
          id: input.quoteId,
          orgId: context.orgId,
          kind: QuoteKind.SERVICE,
        },
      });
      if (!quote) {
        throw new Error('Service quote not found');
      }
      if (quote.guardrailStatus !== GuardrailStatus.BLOCK) {
        throw new Error(
          'system.pricing.overrideBlock can only be used on quotes currently in BLOCK status',
        );
      }

      const existingReasons = Array.isArray(quote.guardrailReasons)
        ? (quote.guardrailReasons as unknown[])
        : [];
      const overrideRecord = {
        code: 'OWNER_OVERRIDE',
        reason: input.reason,
        at: new Date().toISOString(),
        byUserId: context.actorUserId ?? null,
        guardrailStatus: quote.guardrailStatus,
      };

      const updatedQuote = await prisma.quote.update({
        where: { id: quote.id },
        data: {
          guardrailStatus: GuardrailStatus.BLOCK,
          guardrailReasons: toInputJson([...existingReasons, overrideRecord]),
          metadata: toInputJson({
            ...jsonObject(quote.metadata),
            servicePricing: {
              ...jsonObject(
                jsonObject(quote.metadata).servicePricing as Prisma.JsonValue,
              ),
              ownerBlockOverride: overrideRecord,
            },
          }),
        },
      });

      await prisma.auditLog.create({
        data: {
          orgId: context.orgId,
          actorType: context.actorType,
          actorUserId: context.actorUserId,
          action: 'pricing.block.overridden',
          entityType: 'Quote',
          entityId: quote.id,
          metadata: toInputJson({
            quoteId: quote.id,
            reason: input.reason,
            override: overrideRecord,
          }),
        },
      });

      await enqueueOutbox(prisma, {
        orgId: context.orgId,
        eventType: 'pricing.block.overridden',
        payload: toInputJson({
          quoteId: quote.id,
          reason: input.reason,
          override: overrideRecord,
          quoteKind: 'SERVICE',
        }),
      });

      return jsonResult({
        quote: {
          id: updatedQuote.id,
          guardrailStatus: updatedQuote.guardrailStatus,
        },
        overrideApplied: true,
      });
    }

    const installInput = pricingOverrideBlockSchema.parse({
      quoteOptionId: input.quoteOptionId,
      reason: input.reason,
    });
    const quoteOption = await prisma.quoteOption.findFirst({
      where: {
        id: installInput.quoteOptionId,
        orgId: context.orgId,
      },
    });
    if (!quoteOption) {
      throw new Error('Quote option not found');
    }
    if (quoteOption.guardrailStatus !== GuardrailStatus.BLOCK) {
      throw new Error(
        'system.pricing.overrideBlock can only be used on options currently in BLOCK status',
      );
    }

    const existingReasons = Array.isArray(quoteOption.guardrailReasons)
      ? (quoteOption.guardrailReasons as unknown[])
      : [];
    const overrideRecord = {
      code: 'OWNER_OVERRIDE',
      reason: installInput.reason,
      at: new Date().toISOString(),
      byUserId: context.actorUserId ?? null,
      guardrailStatus: quoteOption.guardrailStatus,
    };

    const updated = await prisma.quoteOption.update({
      where: { id: quoteOption.id },
      data: {
        guardrailStatus: GuardrailStatus.BLOCK,
        guardrailReasons: toInputJson([...existingReasons, overrideRecord]),
      },
    });

    await prisma.auditLog.create({
      data: {
        orgId: context.orgId,
        actorType: context.actorType,
        actorUserId: context.actorUserId,
        action: 'pricing.block.overridden',
        entityType: 'QuoteOption',
        entityId: quoteOption.id,
        metadata: toInputJson({
          quoteId: quoteOption.quoteId,
          quoteOptionId: quoteOption.id,
          reason: installInput.reason,
          override: overrideRecord,
        }),
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'pricing.block.overridden',
      payload: toInputJson({
        quoteId: quoteOption.quoteId,
        quoteOptionId: quoteOption.id,
        reason: installInput.reason,
        override: overrideRecord,
      }),
    });

    return jsonResult({
      quoteOption: {
        id: updated.id,
        quoteId: updated.quoteId,
        guardrailStatus: updated.guardrailStatus,
      },
      overrideApplied: true,
    });
  };

  const equipmentOptionsGenerate: ToolHandler = async ({ context, payload }) => {
    const input = equipmentOptionsGenerateSchema.parse(payload);

    const assessment = await prisma.systemAssessment.findFirst({
      where: {
        id: input.assessmentId,
        orgId: context.orgId,
      },
      select: {
        id: true,
        existingTonnage: true,
        existingFurnaceBtu: true,
        existingSystemType: true,
      },
    });
    if (!assessment) {
      throw new Error('SystemAssessment not found');
    }

    const entries = await prisma.equipmentCatalogEntry.findMany({
      where: {
        orgId: context.orgId,
        OR: [
          { manufacturer: { contains: 'GOODMAN', mode: 'insensitive' } },
          { manufacturer: { contains: 'AMANA', mode: 'insensitive' } },
          { rawText: { contains: 'GOODMAN', mode: 'insensitive' } },
          { rawText: { contains: 'AMANA', mode: 'insensitive' } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    const candidateRows = entries.map((entry) => ({
      entry: {
        id: entry.id,
        rawSku: entry.rawSku,
        rawText: entry.rawText,
        manufacturer: entry.manufacturer,
        systemTypeHint: entry.systemTypeHint,
        rawJson: entry.rawJson,
        fuzzyScore: 0,
      } as EquipmentCatalogEntryRow,
      candidate: toLookupCandidate({
        id: entry.id,
        rawSku: entry.rawSku,
        rawText: entry.rawText,
        manufacturer: entry.manufacturer,
        systemTypeHint: entry.systemTypeHint,
        rawJson: entry.rawJson,
        fuzzyScore: 0,
      }),
    }));

    const rankCandidate = (candidate: EquipmentLookupCandidate, base: EquipmentCatalogEntryRow): number => {
      let score = candidate.confidence * 100;

      if (
        assessment.existingTonnage !== null &&
        candidate.tonnage !== null &&
        Math.abs(assessment.existingTonnage - candidate.tonnage) < 0.26
      ) {
        score += 60;
      }

      if (
        assessment.existingFurnaceBtu !== null &&
        candidate.btu !== null &&
        Math.abs(assessment.existingFurnaceBtu - candidate.btu) <= 6_000
      ) {
        score += 45;
      }

      if (
        assessment.existingSystemType &&
        candidate.systemType &&
        assessment.existingSystemType.toLowerCase() === candidate.systemType.toLowerCase()
      ) {
        score += 30;
      }

      if (candidate.model && base.rawSku && candidate.model === base.rawSku) {
        score += 20;
      }

      return score;
    };

    const isHeatPump = (row: EquipmentCatalogEntryRow, candidate: EquipmentLookupCandidate): boolean => {
      const text = `${row.rawSku} ${row.rawText} ${row.systemTypeHint ?? ''} ${candidate.systemType ?? ''}`.toUpperCase();
      return text.includes('HEAT PUMP') || /\\bHP\\b/.test(text);
    };

    const selectTierCandidate = (opts: {
      manufacturerMatch: 'GOODMAN' | 'AMANA';
      requireHeatPump?: boolean;
      excludeHeatPump?: boolean;
    }) => {
      const filtered = candidateRows.filter(({ entry, candidate }) => {
        const manufacturerText = `${candidate.manufacturer ?? ''} ${entry.rawText}`.toUpperCase();
        if (!manufacturerText.includes(opts.manufacturerMatch)) {
          return false;
        }
        const heatPump = isHeatPump(entry, candidate);
        if (opts.requireHeatPump && !heatPump) {
          return false;
        }
        if (opts.excludeHeatPump && heatPump) {
          return false;
        }
        return true;
      });

      if (filtered.length === 0) {
        return null;
      }

      const ranked = filtered
        .map(({ entry, candidate }) => ({
          entry,
          candidate,
          score: rankCandidate(candidate, entry),
        }))
        .sort((a, b) => b.score - a.score);

      return ranked[0] ?? null;
    };

    const requestedAddOns = (input.addOns ?? [])
      .map((code) => code.trim().toLowerCase())
      .filter((code) => code.length > 0);
    const addOns = requestedAddOns
      .map((code) => {
        const config = EQUIPMENT_ADD_ON_CATALOG[code];
        if (!config) {
          return null;
        }
        return {
          code,
          label: config.label,
          priceCents: config.priceCents,
        };
      })
      .filter((entry): entry is { code: string; label: string; priceCents: number } => Boolean(entry));
    const addOnTotalCents = addOns.reduce((sum, addOn) => sum + addOn.priceCents, 0);

    const tiers = [
      {
        tier: 'GOOD',
        label: 'Good',
        match: selectTierCandidate({ manufacturerMatch: 'GOODMAN' }),
      },
      {
        tier: 'BETTER',
        label: 'Better',
        match: selectTierCandidate({ manufacturerMatch: 'AMANA', excludeHeatPump: true }),
      },
      {
        tier: 'BEST',
        label: 'Best',
        match: selectTierCandidate({ manufacturerMatch: 'AMANA', requireHeatPump: true }),
      },
    ].map((tier) => {
      if (!tier.match) {
        return {
          tier: tier.tier,
          label: tier.label,
          available: false,
          message: 'No catalog SKU matched the current sizing baseline.',
        };
      }

      const basePriceCents = toPriceCentsFromEntry(tier.match.entry);
      const totalPriceCents = basePriceCents === null ? null : basePriceCents + addOnTotalCents;
      return {
        tier: tier.tier,
        label: tier.label,
        available: true,
        entryId: tier.match.entry.id,
        manufacturer: tier.match.candidate.manufacturer,
        model: tier.match.candidate.model,
        systemType: tier.match.candidate.systemType,
        tonnage: tier.match.candidate.tonnage,
        btu: tier.match.candidate.btu,
        confidence: tier.match.candidate.confidence,
        basePriceCents,
        addOns,
        totalPriceCents,
      };
    });

    return jsonResult({
      assessmentId: assessment.id,
      baseline: {
        existingTonnage: assessment.existingTonnage,
        existingFurnaceBtu: assessment.existingFurnaceBtu,
        existingSystemType: assessment.existingSystemType,
      },
      tiers,
      addOns,
    });
  };

  const attributionCapture: ToolHandler = async ({ context, payload }) => {
    const leadId = toStringOrNull(payload.leadId);
    const customerId = toStringOrNull(payload.customerId);
    const contactId = toStringOrNull(payload.contactId);
    const sourceTypeInput = String(payload.sourceType ?? '').toUpperCase();
    const sourceType =
      sourceTypeInput in AttributionSourceType
        ? (sourceTypeInput as AttributionSourceType)
        : AttributionSourceType.WEB_FORM;

    const event = await prisma.attributionEvent.create({
      data: {
        orgId: context.orgId,
        leadId,
        customerId,
        contactId,
        sourceType,
        utmSource: toStringOrNull(payload.utmSource),
        utmMedium: toStringOrNull(payload.utmMedium),
        utmCampaign: toStringOrNull(payload.utmCampaign),
        utmContent: toStringOrNull(payload.utmContent),
        utmTerm: toStringOrNull(payload.utmTerm),
        gclid: toStringOrNull(payload.gclid),
        gbraid: toStringOrNull(payload.gbraid),
        wbraid: toStringOrNull(payload.wbraid),
        fbclid: toStringOrNull(payload.fbclid),
        landingUrl: toStringOrNull(payload.landingUrl),
        referrerUrl: toStringOrNull(payload.referrerUrl),
        userAgent: toStringOrNull(payload.userAgent),
        ipHash: toStringOrNull(payload.ipHash),
        capturedAt: toDateOrNull(payload.capturedAt) ?? new Date(),
        metadata: toInputJson(payload.metadata),
      },
    });

    if (leadId) {
      const lead = await prisma.lead.findFirst({
        where: { id: leadId, orgId: context.orgId },
        select: { id: true, notes: true },
      });
      if (lead) {
        const noteParts = [
          'Attribution captured',
          toStringOrNull(payload.utmSource) ?? 'direct',
          toStringOrNull(payload.utmCampaign) ?? 'no-campaign',
        ];
        await prisma.lead.update({
          where: { id: lead.id },
          data: {
            notes: upsertLeadNote(lead.notes, noteParts.join(' / ')),
          },
        });
      }
    }

    return jsonResult({
      attributionEvent: {
        id: event.id,
        sourceType: event.sourceType,
        capturedAt: event.capturedAt.toISOString(),
      },
    });
  };

  const callIngest: ToolHandler = async ({ context, payload }) => {
    const provider = toStringOrNull(payload.provider) ?? 'generic';
    const providerCallId = toStringOrNull(payload.providerCallId);
    const direction = normalizeDirection(payload.direction);
    const fromNumber = normalizePhone(payload.fromNumber);
    const toNumber = normalizePhone(payload.toNumber);
    const startedAt = toDateOrNull(payload.startedAt) ?? new Date();
    const endedAt = toDateOrNull(payload.endedAt);
    const durationSeconds = toNumberOrNull(payload.durationSeconds);
    const answered = payload.answered === true;
    const recordingUrl = toStringOrNull(payload.recordingUrl);
    const transcriptionUrl = toStringOrNull(payload.transcriptionUrl);
    const disposition = toStringOrNull(payload.disposition);
    const metadata = jsonObject(
      (payload.metadata as Prisma.JsonValue | null | undefined) ?? undefined,
    );
    const rawPayload = payload.raw ?? payload;

    if (!fromNumber || !toNumber) {
      throw new Error('fromNumber and toNumber are required');
    }

    const candidatePhone =
      direction === CallDirection.INBOUND ? fromNumber : toNumber;
    const last10 = candidatePhone.replace(/\D/g, '').slice(-10);

    const [matchedLead, matchedCustomer] = await Promise.all([
      prisma.lead.findFirst({
        where: {
          orgId: context.orgId,
          OR: [
            { phone: candidatePhone },
            ...(last10 ? [{ phone: { endsWith: last10 } }] : []),
          ],
        },
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.customer.findFirst({
        where: {
          orgId: context.orgId,
          OR: [
            { phone: candidatePhone },
            ...(last10 ? [{ phone: { endsWith: last10 } }] : []),
          ],
        },
        orderBy: { updatedAt: 'desc' },
      }),
    ]);

    let leadId = matchedLead?.id ?? null;
    let customerId = matchedCustomer?.id ?? null;

    if (
      !leadId &&
      !customerId &&
      direction === CallDirection.INBOUND &&
      (answered || (durationSeconds ?? 0) > 30)
    ) {
      const createdLead = await prisma.lead.create({
        data: {
          orgId: context.orgId,
          fullName:
            toStringOrNull(metadata.callerName) ??
            `Inbound caller ${candidatePhone}`,
          phone: candidatePhone,
          status: 'NEW',
          notes: upsertLeadNote(
            null,
            `Lead auto-created from inbound call (${provider})`,
          ),
        },
      });
      leadId = createdLead.id;
    }

    const trackingNumber = await prisma.trackingNumber.findFirst({
      where: {
        orgId: context.orgId,
        numberE164:
          direction === CallDirection.INBOUND ? toNumber : fromNumber,
      },
    });

    let attributionEventId: string | null = null;
    if (trackingNumber) {
      const attribution = await prisma.attributionEvent.create({
        data: {
          orgId: context.orgId,
          leadId,
          customerId,
          sourceType: AttributionSourceType.CALL,
          utmSource:
            toStringOrNull(metadata.utmSource) ??
            toStringOrNull((trackingNumber.metadata as Record<string, unknown> | null)?.source),
          utmCampaign:
            toStringOrNull(metadata.campaign) ??
            toStringOrNull((trackingNumber.metadata as Record<string, unknown> | null)?.campaign),
          utmTerm: toStringOrNull(metadata.keyword),
          capturedAt: startedAt,
          metadata: toInputJson({
            trackingNumberId: trackingNumber.id,
            trackingNumberLabel:
              toStringOrNull(metadata.trackingNumberLabel) ??
              trackingNumber.label,
            geo: metadata.geo ?? null,
          }),
        },
      });
      attributionEventId = attribution.id;
    }

    const callEvent = await prisma.callEvent.create({
      data: {
        orgId: context.orgId,
        provider,
        providerCallId,
        direction,
        fromNumber,
        toNumber,
        startedAt,
        endedAt,
        durationSeconds: durationSeconds === null ? null : Math.round(durationSeconds),
        answered,
        recordingUrl,
        transcriptionUrl,
        disposition,
        matchedLeadId: leadId,
        matchedCustomerId: customerId,
        matchedContactId: toStringOrNull(payload.matchedContactId),
        attributionEventId,
        rawPayload: toInputJson(rawPayload),
      },
    });

    if (leadId) {
      const lead = await prisma.lead.findFirst({
        where: { id: leadId, orgId: context.orgId },
        select: { id: true, notes: true },
      });
      if (lead) {
        const summary = [
          `Call ${direction === CallDirection.INBOUND ? 'from' : 'to'} ${candidatePhone}`,
          durationSeconds !== null ? `${Math.round(durationSeconds)}s` : null,
          answered ? 'answered' : 'not answered',
          recordingUrl ? `recording: ${recordingUrl}` : null,
        ]
          .filter(Boolean)
          .join(' | ');
        await prisma.lead.update({
          where: { id: lead.id },
          data: {
            notes: upsertLeadNote(lead.notes, summary),
          },
        });
      }
    }

    return jsonResult({
      callEvent: {
        id: callEvent.id,
        provider: callEvent.provider,
        direction: callEvent.direction,
        matchedLeadId: callEvent.matchedLeadId,
        matchedCustomerId: callEvent.matchedCustomerId,
        attributionEventId: callEvent.attributionEventId,
      },
    });
  };

  const receiptUpload: ToolHandler = async ({ context, payload }) => {
    const fileName = toStringOrNull(payload.fileName);
    const objectKey = toStringOrNull(payload.objectKey);
    const bucket = toStringOrNull(payload.bucket);
    const mimeType = toStringOrNull(payload.mimeType) ?? 'application/octet-stream';
    const checksumSha256 = toStringOrNull(payload.checksumSha256);
    const sizeBytes = toNumberOrNull(payload.sizeBytes);

    if (!fileName || !objectKey || !bucket || !checksumSha256 || sizeBytes === null) {
      throw new Error('fileName, objectKey, bucket, checksumSha256, and sizeBytes are required');
    }

    const actorUserId = await resolveActorUserId(context.orgId, context.actorUserId);
    const vendorName = toStringOrNull(payload.vendorName);
    const vendorSuggestion = suggestVendorName(vendorName);
    const canonicalVendorName = vendorSuggestion.canonicalName;
    const totalCents = toNumberOrNull(payload.totalCents);
    const roundedTotalCents = totalCents === null ? null : Math.round(totalCents);
    const taxCents = toNumberOrNull(payload.taxCents);
    const incurredAt = toDateOrNull(payload.incurredAt);
    const purchaseDate = toDateOrNull(payload.purchaseDate) ?? incurredAt;
    const currency = toStringOrNull(payload.currency) ?? 'USD';
    const categoryRuleName = suggestCategoryName(canonicalVendorName ?? vendorName);
    const suggestedCategory = categoryRuleName
      ? await prisma.expenseCategory.findFirst({
          where: {
            orgId: context.orgId,
            name: categoryRuleName,
          },
          select: { id: true, name: true },
        })
      : null;

    const duplicateWindowStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const duplicateReceipt =
      roundedTotalCents === null
        ? null
        : await prisma.receipt.findFirst({
            where: {
              orgId: context.orgId,
              totalCents: roundedTotalCents,
              createdAt: { gte: duplicateWindowStart },
              attachment: {
                checksumSha256,
              },
            },
            select: {
              id: true,
              createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
          });

    const userMetadata = jsonObject(
      (payload.metadata as Prisma.JsonValue | null | undefined) ?? undefined,
    );
    const suggestions = {
      vendorCanonicalName: canonicalVendorName,
      vendorAliasMatched: vendorSuggestion.aliasMatched,
      suggestedCategoryName: suggestedCategory?.name ?? categoryRuleName,
      suggestedCategoryId: suggestedCategory?.id ?? null,
      duplicatePotential: Boolean(duplicateReceipt),
      duplicateReferenceReceiptId: duplicateReceipt?.id ?? null,
      duplicateWindowDays: 7,
    };
    const mergedMetadata = {
      ...userMetadata,
      suggestions,
    };

    const vendor = canonicalVendorName
      ? await prisma.vendor.upsert({
          where: {
            orgId_name: {
              orgId: context.orgId,
              name: canonicalVendorName,
            },
          },
          update: {},
          create: {
            orgId: context.orgId,
            name: canonicalVendorName,
            defaultCategoryId: suggestedCategory?.id ?? null,
          },
        })
      : null;

    const attachment = await prisma.attachment.create({
      data: {
        orgId: context.orgId,
        kind: AttachmentKind.RECEIPT,
        storageProvider: AttachmentStorageProvider.S3,
        bucket,
        objectKey,
        fileName,
        mimeType,
        sizeBytes: Math.round(sizeBytes),
        checksumSha256,
        uploadedByUserId: actorUserId,
        metadata: toInputJson(mergedMetadata),
      },
    });

    const receipt = await prisma.receipt.create({
      data: {
        orgId: context.orgId,
        attachmentId: attachment.id,
        vendorName: canonicalVendorName ?? vendorName,
        purchaseDate,
        totalCents: roundedTotalCents,
        taxCents: taxCents === null ? null : Math.round(taxCents),
        currency,
        suggestedCategoryId:
          toStringOrNull(payload.suggestedCategoryId) ??
          toStringOrNull(payload.categoryId) ??
          suggestedCategory?.id ??
          null,
        linkedJobId: toStringOrNull(payload.jobId),
        notes: toStringOrNull(payload.notes),
        createdByUserId: actorUserId,
        metadata: toInputJson(mergedMetadata),
      },
    });

    const expense = await prisma.expense.create({
      data: {
        orgId: context.orgId,
        status: ExpenseStatus.DRAFT,
        vendorId: vendor?.id ?? null,
        receiptId: receipt.id,
        amountCents: roundedTotalCents,
        taxCents: taxCents === null ? null : Math.round(taxCents),
        currency,
        categoryId: toStringOrNull(payload.categoryId) ?? suggestedCategory?.id ?? null,
        jobId: toStringOrNull(payload.jobId),
        memo: toStringOrNull(payload.memo),
        incurredAt,
        createdByUserId: actorUserId,
        metadata: toInputJson(mergedMetadata),
      },
    });

    return jsonResult({
      attachmentId: attachment.id,
      receiptId: receipt.id,
      expenseId: expense.id,
      expenseStatus: expense.status,
      suggestions,
    });
  };

  const receiptOcrRequest: ToolHandler = async ({ context, payload }) => {
    const receiptId = toStringOrNull(payload.receiptId);
    if (!receiptId) {
      throw new Error('receiptId is required');
    }

    const receipt = await prisma.receipt.findFirst({
      where: {
        id: receiptId,
        orgId: context.orgId,
      },
      include: {
        attachment: true,
      },
    });
    if (!receipt) {
      throw new Error('Receipt not found');
    }

    const provider = toReceiptOcrProvider(payload.provider);
    const ocrResult = await prisma.receiptOcrResult.upsert({
      where: { receiptId: receipt.id },
      update: {
        provider,
        status: ReceiptOcrStatus.PENDING,
        errorMessage: null,
        rawPayload: toInputJson({
          source: 'accounting.receipt.ocr.request',
          requestedAt: new Date().toISOString(),
          requestedByType: context.actorType,
          requestedByUserId: context.actorUserId ?? null,
        }),
      },
      create: {
        orgId: context.orgId,
        receiptId: receipt.id,
        provider,
        status: ReceiptOcrStatus.PENDING,
        rawPayload: toInputJson({
          source: 'accounting.receipt.ocr.request',
          requestedAt: new Date().toISOString(),
          requestedByType: context.actorType,
          requestedByUserId: context.actorUserId ?? null,
        }),
      },
    });

    return jsonResult({
      receipt: {
        id: receipt.id,
        vendorName: receipt.vendorName,
        purchaseDate: receipt.purchaseDate?.toISOString() ?? null,
        totalCents: receipt.totalCents,
        taxCents: receipt.taxCents,
        currency: receipt.currency,
      },
      attachment: {
        id: receipt.attachment.id,
        bucket: receipt.attachment.bucket,
        objectKey: receipt.attachment.objectKey,
        fileName: receipt.attachment.fileName,
        mimeType: receipt.attachment.mimeType,
      },
      ocrResult: {
        id: ocrResult.id,
        status: ocrResult.status,
        provider: ocrResult.provider,
      },
    });
  };

  const receiptApplyOcr: ToolHandler = async ({ context, payload }) => {
    const receiptId = toStringOrNull(payload.receiptId);
    if (!receiptId) {
      throw new Error('receiptId is required');
    }

    const receipt = await prisma.receipt.findFirst({
      where: {
        id: receiptId,
        orgId: context.orgId,
      },
      include: {
        expenses: {
          where: { orgId: context.orgId },
          orderBy: { createdAt: 'asc' },
          take: 1,
        },
      },
    });
    if (!receipt) {
      throw new Error('Receipt not found');
    }

    const provider = toReceiptOcrProvider(payload.provider);
    const status = toReceiptOcrStatus(payload.status);
    const extractedMerchant = toStringOrNull(payload.extractedMerchant);
    const extractedDate = toDateOrNull(payload.extractedDate);
    const extractedTotalCentsRaw = toNumberOrNull(payload.extractedTotalCents);
    const extractedTaxCentsRaw = toNumberOrNull(payload.extractedTaxCents);
    const extractedTotalCents =
      extractedTotalCentsRaw === null ? null : Math.round(extractedTotalCentsRaw);
    const extractedTaxCents =
      extractedTaxCentsRaw === null ? null : Math.round(extractedTaxCentsRaw);
    const extractedLineItems =
      payload.extractedLineItems === undefined
        ? undefined
        : (payload.extractedLineItems as Prisma.InputJsonValue);
    const confidence = jsonObject(
      (payload.confidence as Prisma.JsonValue | null | undefined) ?? undefined,
    );
    const confidenceTotalRaw = confidence.total;
    const confidenceTotal =
      typeof confidenceTotalRaw === 'number' && Number.isFinite(confidenceTotalRaw)
        ? confidenceTotalRaw
        : 0;
    const threshold = toNumberOrNull(payload.confidenceThreshold) ?? 0.85;
    const highConfidence =
      status === ReceiptOcrStatus.COMPLETED && confidenceTotal >= threshold;
    const needsReview =
      status !== ReceiptOcrStatus.COMPLETED || !highConfidence;
    const errorMessage = toStringOrNull(payload.errorMessage);
    const rawText =
      payload.rawText === undefined
        ? undefined
        : (payload.rawText as Prisma.InputJsonValue);
    const rawPayload =
      payload.rawPayload === undefined
        ? toInputJson({})
        : toInputJson(payload.rawPayload);

    const updatedReceiptFields: string[] = [];
    const updatedExpenseFields: string[] = [];

    const existingReceiptMetadata = jsonObject(receipt.metadata);
    const existingReceiptOcrMetadata =
      existingReceiptMetadata.ocr &&
      typeof existingReceiptMetadata.ocr === 'object' &&
      !Array.isArray(existingReceiptMetadata.ocr)
        ? (existingReceiptMetadata.ocr as Record<string, unknown>)
        : {};

    return prisma.$transaction(async (tx) => {
      const ocrResult = await tx.receiptOcrResult.upsert({
        where: { receiptId: receipt.id },
        update: {
          provider,
          extractedMerchant,
          extractedDate,
          extractedTotalCents,
          extractedTaxCents,
          ...(extractedLineItems === undefined ? {} : { extractedLineItems }),
          confidence: toInputJson(confidence),
          ...(rawText === undefined ? {} : { rawText }),
          rawPayload,
          status,
          errorMessage,
        },
        create: {
          orgId: context.orgId,
          receiptId: receipt.id,
          provider,
          extractedMerchant,
          extractedDate,
          extractedTotalCents,
          extractedTaxCents,
          extractedLineItems: extractedLineItems ?? Prisma.JsonNull,
          confidence: toInputJson(confidence),
          rawText: rawText ?? Prisma.JsonNull,
          rawPayload,
          status,
          errorMessage,
        },
      });

      const receiptUpdateData: Prisma.ReceiptUpdateInput = {
        metadata: toInputJson({
          ...existingReceiptMetadata,
          ocr: {
            ...existingReceiptOcrMetadata,
            provider,
            status,
            confidence,
            confidenceTotal,
            threshold,
            needsReview,
            updatedAt: new Date().toISOString(),
            ...(errorMessage ? { errorMessage } : {}),
          },
        }),
      };

      if (highConfidence) {
        if (!receipt.vendorName && extractedMerchant) {
          receiptUpdateData.vendorName = extractedMerchant;
          updatedReceiptFields.push('vendorName');
        }
        if (!receipt.purchaseDate && extractedDate) {
          receiptUpdateData.purchaseDate = extractedDate;
          updatedReceiptFields.push('purchaseDate');
        }
        if (receipt.totalCents === null && extractedTotalCents !== null) {
          receiptUpdateData.totalCents = extractedTotalCents;
          updatedReceiptFields.push('totalCents');
        }
        if (receipt.taxCents === null && extractedTaxCents !== null) {
          receiptUpdateData.taxCents = extractedTaxCents;
          updatedReceiptFields.push('taxCents');
        }
      }

      await tx.receipt.update({
        where: { id: receipt.id },
        data: receiptUpdateData,
      });

      const expense = receipt.expenses[0] ?? null;
      if (expense) {
        const existingExpenseMetadata = jsonObject(expense.metadata);
        const existingExpenseOcrMetadata =
          existingExpenseMetadata.ocr &&
          typeof existingExpenseMetadata.ocr === 'object' &&
          !Array.isArray(existingExpenseMetadata.ocr)
            ? (existingExpenseMetadata.ocr as Record<string, unknown>)
            : {};

        const expenseUpdateData: Prisma.ExpenseUpdateInput = {
          metadata: toInputJson({
            ...existingExpenseMetadata,
            ocr: {
              ...existingExpenseOcrMetadata,
              provider,
              status,
              confidence,
              confidenceTotal,
              threshold,
              needsReview,
              updatedAt: new Date().toISOString(),
              ...(errorMessage ? { errorMessage } : {}),
            },
          }),
        };

        if (highConfidence) {
          if (expense.amountCents === null && extractedTotalCents !== null) {
            expenseUpdateData.amountCents = extractedTotalCents;
            updatedExpenseFields.push('amountCents');
          }
          if (expense.taxCents === null && extractedTaxCents !== null) {
            expenseUpdateData.taxCents = extractedTaxCents;
            updatedExpenseFields.push('taxCents');
          }
          if (!expense.incurredAt && extractedDate) {
            expenseUpdateData.incurredAt = extractedDate;
            updatedExpenseFields.push('incurredAt');
          }
        }

        await tx.expense.update({
          where: { id: expense.id },
          data: expenseUpdateData,
        });
      }

      return jsonResult({
        receiptId: receipt.id,
        ocrResultId: ocrResult.id,
        ocrStatus: status,
        highConfidence,
        needsReview,
        confidenceTotal,
        threshold,
        updatedReceiptFields,
        updatedExpenseFields,
      });
    });
  };

  const expenseUpdate: ToolHandler = async ({ context, payload }) => {
    const expenseId = toStringOrNull(payload.expenseId);
    if (!expenseId) {
      throw new Error('expenseId is required');
    }

    const existing = await prisma.expense.findFirst({
      where: { id: expenseId, orgId: context.orgId },
    });
    if (!existing) {
      throw new Error('Expense not found');
    }

    const vendorName = toStringOrNull(payload.vendorName);
    const vendor = vendorName
      ? await prisma.vendor.upsert({
          where: {
            orgId_name: {
              orgId: context.orgId,
              name: vendorName,
            },
          },
          update: {},
          create: {
            orgId: context.orgId,
            name: vendorName,
          },
        })
      : null;

    const updated = await prisma.expense.update({
      where: { id: existing.id },
      data: {
        vendorId: toStringOrNull(payload.vendorId) ?? vendor?.id ?? undefined,
        amountCents:
          toNumberOrNull(payload.amountCents) === null
            ? undefined
            : Math.round(toNumberOrNull(payload.amountCents) as number),
        taxCents:
          toNumberOrNull(payload.taxCents) === null
            ? undefined
            : Math.round(toNumberOrNull(payload.taxCents) as number),
        currency: toStringOrNull(payload.currency) ?? undefined,
        categoryId: toStringOrNull(payload.categoryId) ?? undefined,
        jobId: toStringOrNull(payload.jobId) ?? undefined,
        memo: toStringOrNull(payload.memo) ?? undefined,
        incurredAt: toDateOrNull(payload.incurredAt) ?? undefined,
        ...(payload.metadata !== undefined
          ? { metadata: toInputJson(payload.metadata) }
          : {}),
      },
    });

    return jsonResult({
      expense: {
        id: updated.id,
        status: updated.status,
        amountCents: updated.amountCents,
        currency: updated.currency,
      },
    });
  };

  const expenseSubmit: ToolHandler = async ({ context, payload }) => {
    const expenseId = toStringOrNull(payload.expenseId);
    if (!expenseId) {
      throw new Error('expenseId is required');
    }
    const existing = await prisma.expense.findFirst({
      where: { id: expenseId, orgId: context.orgId },
    });
    if (!existing) {
      throw new Error('Expense not found');
    }

    const updated = await prisma.expense.update({
      where: { id: existing.id },
      data: {
        status: ExpenseStatus.SUBMITTED,
        memo: toStringOrNull(payload.memo) ?? existing.memo,
      },
    });

    return jsonResult({
      expense: {
        id: updated.id,
        status: updated.status,
      },
    });
  };

  const expenseApprove: ToolHandler = async ({ context, payload }) => {
    if (context.actorType !== ActorType.HUMAN) {
      throw new Error('accounting.expense.approve requires a human actor');
    }

    const expenseId = toStringOrNull(payload.expenseId);
    if (!expenseId) {
      throw new Error('expenseId is required');
    }
    const existing = await prisma.expense.findFirst({
      where: { id: expenseId, orgId: context.orgId },
    });
    if (!existing) {
      throw new Error('Expense not found');
    }

    const approverId = await resolveActorUserId(context.orgId, context.actorUserId);
    const updated = await prisma.expense.update({
      where: { id: existing.id },
      data: {
        status: ExpenseStatus.APPROVED,
        approvedByUserId: approverId,
      },
    });

    return jsonResult({
      expense: {
        id: updated.id,
        status: updated.status,
        approvedByUserId: updated.approvedByUserId,
      },
    });
  };

  const vendorUpsert: ToolHandler = async ({ context, payload }) => {
    const name = toStringOrNull(payload.name);
    if (!name) {
      throw new Error('Vendor name is required');
    }

    const vendor = await prisma.vendor.upsert({
      where: {
        orgId_name: {
          orgId: context.orgId,
          name,
        },
      },
      update: {
        ...(payload.defaultCategoryId !== undefined
          ? { defaultCategoryId: toStringOrNull(payload.defaultCategoryId) }
          : {}),
        ...(payload.metadata !== undefined
          ? { metadata: toInputJson(payload.metadata) }
          : {}),
      },
      create: {
        orgId: context.orgId,
        name,
        defaultCategoryId: toStringOrNull(payload.defaultCategoryId),
        metadata: toInputJson(payload.metadata),
      },
    });

    return jsonResult({
      vendor: {
        id: vendor.id,
        name: vendor.name,
        defaultCategoryId: vendor.defaultCategoryId,
      },
    });
  };

  const categoryList: ToolHandler = async ({ context }) => {
    const categories = await prisma.expenseCategory.findMany({
      where: { orgId: context.orgId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });

    return jsonResult({ categories });
  };

  const summaryRun: ToolHandler = async ({ context, payload }) => {
    const agentRunId = String(payload.agentRunId);
    const [executedCount, blockedCount, queuedCount] = await Promise.all([
      prisma.toolExecution.count({
        where: { orgId: context.orgId, agentRunId, status: 'EXECUTED' },
      }),
      prisma.toolExecution.count({
        where: { orgId: context.orgId, agentRunId, status: 'BLOCKED' },
      }),
      prisma.toolExecution.count({
        where: { orgId: context.orgId, agentRunId, status: 'QUEUED_APPROVAL' },
      }),
    ]);

    return jsonResult({
      agentRunId,
      executedCount,
      blockedCount,
      queuedCount,
    });
  };

  const killSwitchStatus: ToolHandler = async ({ context }) => {
    const current = await prisma.orgSafetyState.findUnique({
      where: { orgId: context.orgId },
      select: {
        mode: true,
        reason: true,
        updatedAt: true,
      },
    });

    return jsonResult({
      mode: current?.mode ?? SafetyMode.NORMAL,
      reason: current?.reason ?? null,
      updatedAt: current?.updatedAt?.toISOString() ?? null,
    });
  };

  const killSwitchSet: ToolHandler = async ({ context, payload }) => {
    if (context.actorType !== ActorType.HUMAN || context.isAutonomous) {
      throw new Error('system.killswitch.set requires human non-autonomous execution');
    }

    const modeValue = String(payload.mode);
    if (
      modeValue !== SafetyMode.NORMAL &&
      modeValue !== SafetyMode.AUTONOMY_OFF &&
      modeValue !== SafetyMode.FULL_STOP
    ) {
      throw new Error(`Invalid kill switch mode: ${modeValue}`);
    }

    const reason = typeof payload.reason === 'string' ? payload.reason : null;
    const updated = await prisma.orgSafetyState.upsert({
      where: { orgId: context.orgId },
      update: {
        mode: modeValue as SafetyMode,
        reason,
        updatedByUserId: context.actorUserId ?? null,
      },
      create: {
        orgId: context.orgId,
        mode: modeValue as SafetyMode,
        reason,
        updatedByUserId: context.actorUserId ?? null,
      },
      select: {
        mode: true,
        reason: true,
        updatedAt: true,
      },
    });

    return jsonResult({
      mode: updated.mode,
      reason: updated.reason,
      updatedAt: updated.updatedAt.toISOString(),
    });
  };

  const agentRunStart: ToolHandler = async ({ context, payload }) => {
    if (context.actorType !== ActorType.HUMAN || !context.actorUserId) {
      throw new Error('system.agent.run.start requires a human actor');
    }

    const goal =
      typeof payload.goal === 'string' ? payload.goal.trim() : '';
    if (!goal) {
      throw new Error('goal is required');
    }

    const mode =
      payload.mode === 'SUPERVISED' ? 'SUPERVISED' : 'AUTO';

    const active = await prisma.agentRun.findFirst({
      where: {
        orgId: context.orgId,
        status: {
          in: [AgentRunStatus.RUNNING, AgentRunStatus.PAUSED_FOR_APPROVALS],
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (active) {
      throw new Error(`Active agent run already exists (${active.id})`);
    }

    const activePolicy = await prisma.policy.findFirst({
      where: { orgId: context.orgId, isActive: true },
      orderBy: [{ version: 'desc' }, { createdAt: 'desc' }],
    });

    const created = await prisma.agentRun.create({
      data: {
        orgId: context.orgId,
        policyId: activePolicy?.id,
        startedByUserId: context.actorUserId,
        goal,
        status: AgentRunStatus.RUNNING,
        currentSkillId: MASTER_AGENT_GRAPH.startNodeId,
        stateJson: {
          goal,
          mode,
          context: payload.context ?? null,
          history: [],
          preferredNextSkillId: null,
        } as Prisma.InputJsonValue,
      },
    });

    return jsonResult({
      agentRunId: created.id,
      goal: created.goal,
      status: created.status,
      mode,
      currentSkillId: created.currentSkillId,
      startedAt: created.startedAt.toISOString(),
    });
  };

  const agentRunPause: ToolHandler = async ({ context, payload }) => {
    const explicitRunId =
      typeof payload.agentRunId === 'string' ? payload.agentRunId : '';
    const run = explicitRunId
      ? await prisma.agentRun.findFirst({
          where: {
            id: explicitRunId,
            orgId: context.orgId,
          },
        })
      : await prisma.agentRun.findFirst({
          where: {
            orgId: context.orgId,
            status: AgentRunStatus.RUNNING,
          },
          orderBy: { createdAt: 'desc' },
        });

    if (!run) {
      throw new Error('No running agent run found to pause');
    }

    if (run.status !== AgentRunStatus.RUNNING) {
      throw new Error(`Agent run ${run.id} is not RUNNING`);
    }

    const pausedAtIso = new Date().toISOString();
    const updated = await prisma.agentRun.update({
      where: { id: run.id },
      data: {
        status: AgentRunStatus.PAUSED_FOR_APPROVALS,
        stateJson: patchStateJson(run.stateJson, {
          pausedAt: pausedAtIso,
          pausedByUserId: context.actorUserId ?? null,
        }),
      },
    });

    return jsonResult({
      agentRunId: updated.id,
      status: updated.status,
      pausedAt: pausedAtIso,
    });
  };

  const agentRunResume: ToolHandler = async ({ context, payload }) => {
    const explicitRunId =
      typeof payload.agentRunId === 'string' ? payload.agentRunId : '';
    const run = explicitRunId
      ? await prisma.agentRun.findFirst({
          where: {
            id: explicitRunId,
            orgId: context.orgId,
          },
        })
      : await prisma.agentRun.findFirst({
          where: {
            orgId: context.orgId,
            status: AgentRunStatus.PAUSED_FOR_APPROVALS,
          },
          orderBy: { createdAt: 'desc' },
        });

    if (!run) {
      throw new Error('No paused agent run found to resume');
    }

    if (run.status !== AgentRunStatus.PAUSED_FOR_APPROVALS) {
      throw new Error(`Agent run ${run.id} is not PAUSED_FOR_APPROVALS`);
    }

    const resumedAtIso = new Date().toISOString();
    const updated = await prisma.agentRun.update({
      where: { id: run.id },
      data: {
        status: AgentRunStatus.RUNNING,
        stateJson: patchStateJson(run.stateJson, {
          resumedAt: resumedAtIso,
          resumedByUserId: context.actorUserId ?? null,
        }),
      },
    });

    return jsonResult({
      agentRunId: updated.id,
      status: updated.status,
      resumedAt: resumedAtIso,
    });
  };

  const agentRunCancel: ToolHandler = async ({ context, payload }) => {
    const explicitRunId =
      typeof payload.agentRunId === 'string' ? payload.agentRunId : '';
    const run = explicitRunId
      ? await prisma.agentRun.findFirst({
          where: {
            id: explicitRunId,
            orgId: context.orgId,
          },
        })
      : await prisma.agentRun.findFirst({
          where: {
            orgId: context.orgId,
            status: {
              in: [AgentRunStatus.RUNNING, AgentRunStatus.PAUSED_FOR_APPROVALS],
            },
          },
          orderBy: { createdAt: 'desc' },
        });

    if (!run) {
      throw new Error('No active agent run found to cancel');
    }

    if (
      run.status !== AgentRunStatus.RUNNING &&
      run.status !== AgentRunStatus.PAUSED_FOR_APPROVALS
    ) {
      throw new Error(`Agent run ${run.id} cannot be cancelled from status ${run.status}`);
    }

    const cancelledAtIso = new Date().toISOString();
    const updated = await prisma.agentRun.update({
      where: { id: run.id },
      data: {
        status: AgentRunStatus.CANCELLED,
        completedAt: new Date(cancelledAtIso),
        stateJson: patchStateJson(run.stateJson, {
          cancelledAt: cancelledAtIso,
          cancelledByUserId: context.actorUserId ?? null,
        }),
      },
    });

    return jsonResult({
      agentRunId: updated.id,
      status: updated.status,
      cancelledAt: cancelledAtIso,
    });
  };

  const agentRunSuggestSkill: ToolHandler = async ({ context, payload }) => {
    const agentRunId =
      typeof payload.agentRunId === 'string' ? payload.agentRunId.trim() : '';
    const skillId =
      typeof payload.skillId === 'string' ? payload.skillId.trim() : '';

    if (!agentRunId || !skillId) {
      throw new Error('agentRunId and skillId are required');
    }

    const [run, safetyState, activePolicy] = await Promise.all([
      prisma.agentRun.findFirst({
        where: {
          id: agentRunId,
          orgId: context.orgId,
        },
      }),
      prisma.orgSafetyState.findUnique({
        where: {
          orgId: context.orgId,
        },
      }),
      prisma.policy.findFirst({
        where: { orgId: context.orgId, isActive: true },
        orderBy: [{ version: 'desc' }, { createdAt: 'desc' }],
      }),
    ]);

    if (!run) {
      throw new Error('Agent run not found');
    }

    if (safetyState?.mode === SafetyMode.FULL_STOP) {
      throw new Error('Kill switch FULL_STOP blocks autonomous steering suggestions');
    }

    const targetSkill = MASTER_AGENT_GRAPH.nodes[skillId];
    if (!targetSkill) {
      throw new Error(`Unknown skill node: ${skillId}`);
    }

    const stateSummary = toGraphStateSummary(run.stateJson);
    const currentSkillId = run.currentSkillId ?? MASTER_AGENT_GRAPH.startNodeId;
    const reachable = isSkillReachable(
      MASTER_AGENT_GRAPH,
      currentSkillId,
      skillId,
      stateSummary,
    );
    if (!reachable) {
      throw new Error(
        `Skill ${skillId} is unreachable from current node ${currentSkillId}`,
      );
    }

    const entryValidation = validateSkillEntry(
      MASTER_AGENT_GRAPH,
      skillId,
      stateSummary,
    );
    if (!entryValidation.valid) {
      throw new Error(
        entryValidation.reason ?? `Entry criteria failed for ${skillId}`,
      );
    }

    const policyJson =
      (activePolicy?.policyJson as Record<string, unknown> | undefined) ?? {};
    const windowOverlay = applyTimeWindowOverlay(policyJson, new Date());

    for (const toolName of targetSkill.allowedTools) {
      const guard = isToolBlocked(policyJson, toolName, true);
      if (guard.blocked) {
        throw new Error(
          guard.reason ??
            `Tool ${toolName} is blocked by policy for skill ${skillId}`,
        );
      }

      if (
        windowOverlay.denyTools.some((pattern) =>
          wildcardMatch(pattern, toolName),
        )
      ) {
        throw new Error(
          `Tool ${toolName} is blocked by active policy time window`,
        );
      }

      const toolDef = await prisma.toolDefinition.findFirst({
        where: {
          orgId: context.orgId,
          name: toolName,
          active: true,
        },
        orderBy: [{ createdAt: 'desc' }],
      });
      if (!toolDef) {
        continue;
      }

      const riskGuard = checkMaxRiskLevelAutonomous(
        policyJson,
        toolDef.riskLevel,
        true,
        windowOverlay.maxRiskLevelAutonomous,
      );
      if (riskGuard.blocked) {
        throw new Error(
          riskGuard.reason ??
            `Tool ${toolName} exceeds policy risk cap for autonomous steering`,
        );
      }
    }

    const preferredNextSkillSetAt = new Date().toISOString();
    const updated = await prisma.agentRun.update({
      where: { id: run.id },
      data: {
        stateJson: patchStateJson(run.stateJson, {
          preferredNextSkillId: skillId,
          preferredNextSkillSetAt,
          preferredNextSkillSetByUserId: context.actorUserId ?? null,
        }),
      },
    });

    return jsonResult({
      agentRunId: updated.id,
      currentSkillId: updated.currentSkillId,
      preferredNextSkillId: skillId,
      preferredNextSkillSetAt,
    });
  };

  const resolveCommsAccount = async (args: {
    orgId: string;
    kind: 'IMESSAGE' | 'GMAIL';
    accountId?: string;
    externalAccountId?: string;
    displayName?: string;
  }) => {
    if (args.accountId) {
      const existing = await prisma.commsAccount.findFirst({
        where: {
          id: args.accountId,
          orgId: args.orgId,
          kind: args.kind,
        },
      });
      if (existing) {
        return existing;
      }
    }

    const externalAccountId =
      args.externalAccountId?.trim() ||
      (args.kind === 'IMESSAGE'
        ? process.env.IMESSAGE_ACCOUNT_ID ?? 'local-imessage'
        : process.env.GMAIL_ACCOUNT_ID ?? '');
    if (!externalAccountId) {
      throw new Error(
        `externalAccountId is required for ${args.kind} sync`,
      );
    }

    return prisma.commsAccount.upsert({
      where: {
        orgId_kind_externalAccountId: {
          orgId: args.orgId,
          kind: args.kind,
          externalAccountId,
        },
      },
      update: {
        displayName:
          args.displayName?.trim() ||
          (args.kind === 'IMESSAGE' ? 'Mac iMessage' : externalAccountId),
      },
      create: {
        orgId: args.orgId,
        kind: args.kind,
        externalAccountId,
        displayName:
          args.displayName?.trim() ||
          (args.kind === 'IMESSAGE' ? 'Mac iMessage' : externalAccountId),
      },
    });
  };

  const upsertCommsThread = async (args: {
    orgId: string;
    channel: CommsChannel;
    externalThreadId: string;
    participants: CommsParticipant[];
    subject?: string | null;
    lastMessageAt: Date;
  }) => {
    const existing = await prisma.commsThread.findFirst({
      where: {
        orgId: args.orgId,
        channel: args.channel,
        externalThreadId: args.externalThreadId,
      },
    });

    const participantsJson = toInputJson(
      dedupeParticipants(args.participants),
    );
    if (existing) {
      return prisma.commsThread.update({
        where: { id: existing.id },
        data: {
          participantsJson,
          subject: args.subject ?? existing.subject,
          lastMessageAt:
            existing.lastMessageAt > args.lastMessageAt
              ? existing.lastMessageAt
              : args.lastMessageAt,
        },
      });
    }

    return prisma.commsThread.create({
      data: {
        orgId: args.orgId,
        channel: args.channel,
        externalThreadId: args.externalThreadId,
        participantsJson,
        subject: args.subject ?? null,
        lastMessageAt: args.lastMessageAt,
      },
    });
  };

  const upsertCommsMessage = async (args: {
    orgId: string;
    threadId: string;
    record: SyncMessageRecord;
    createdByUserId?: string | null;
  }) => {
    const status =
      args.record.direction === 'OUTBOUND'
        ? CommsStatus.SENT
        : CommsStatus.RECEIVED;

    const existing = await prisma.commsMessage.findFirst({
      where: {
        orgId: args.orgId,
        channel: args.record.channel as CommsChannel,
        externalMessageId: args.record.externalMessageId,
      },
      select: { id: true },
    });

    const payload = {
      orgId: args.orgId,
      threadId: args.threadId,
      channel: args.record.channel as CommsChannel,
      direction: args.record.direction as CommsDirection,
      status,
      externalMessageId: args.record.externalMessageId,
      sentAt: args.record.sentAt,
      fromJson: toInputJson(args.record.from),
      toJson: toInputJson(args.record.to),
      bodyText: args.record.bodyText ?? null,
      bodyHtml: args.record.bodyHtml ?? null,
      snippet: args.record.snippet ?? null,
      attachmentsJson: toInputJson(args.record.attachments ?? []),
      rawRef: toInputJson(args.record.rawRef ?? {}),
      createdByUserId: args.createdByUserId ?? null,
    } satisfies Prisma.CommsMessageUncheckedCreateInput;

    if (existing) {
      return prisma.commsMessage.update({
        where: { id: existing.id },
        data: payload,
      });
    }

    return prisma.commsMessage.create({
      data: payload,
    });
  };

  const linkThreadDeterministically = async (
    orgId: string,
    threadId: string,
  ) => {
    const thread = await prisma.commsThread.findFirst({
      where: { id: threadId, orgId },
    });
    if (!thread) {
      throw new Error('Comms thread not found');
    }

    const participants = participantJsonToArray(thread.participantsJson);
    const { phones, emails } = extractThreadPhonesAndEmails(participants);

    const [customerMatches, leadMatches] = await Promise.all([
      prisma.customer.findMany({
        where: {
          orgId,
          OR: [
            ...(phones.length > 0 ? [{ phone: { in: phones } }] : []),
            ...(emails.length > 0 ? [{ email: { in: emails } }] : []),
          ],
        },
        orderBy: { updatedAt: 'desc' },
        take: 3,
      }),
      prisma.lead.findMany({
        where: {
          orgId,
          OR: [
            ...(phones.length > 0 ? [{ phone: { in: phones } }] : []),
            ...(emails.length > 0 ? [{ email: { in: emails } }] : []),
          ],
        },
        orderBy: { updatedAt: 'desc' },
        take: 3,
      }),
    ]);

    const linksCreated: Array<{
      entityType: CommsEntityType;
      entityId: string;
      confidence: number;
      reason: string;
    }> = [];

    if (customerMatches.length > 0) {
      const primary = customerMatches[0];
      const confidence = customerMatches.length > 1 ? 0.7 : 0.9;
      const reason =
        customerMatches.length > 1
          ? 'Multiple customer matches by phone/email; selected most recently updated.'
          : 'Matched customer by phone/email.';
      await prisma.commsEntityLink.upsert({
        where: {
          orgId_threadId_entityType_entityId: {
            orgId,
            threadId,
            entityType: CommsEntityType.CUSTOMER,
            entityId: primary.id,
          },
        },
        update: {
          confidence,
          reason,
        },
        create: {
          orgId,
          threadId,
          entityType: CommsEntityType.CUSTOMER,
          entityId: primary.id,
          confidence,
          reason,
        },
      });
      linksCreated.push({
        entityType: CommsEntityType.CUSTOMER,
        entityId: primary.id,
        confidence,
        reason,
      });
    } else if (leadMatches.length > 0) {
      const primary = leadMatches[0];
      const confidence = leadMatches.length > 1 ? 0.65 : 0.85;
      const reason =
        leadMatches.length > 1
          ? 'Multiple lead matches by phone/email; selected most recently updated.'
          : 'Matched lead by phone/email.';
      await prisma.commsEntityLink.upsert({
        where: {
          orgId_threadId_entityType_entityId: {
            orgId,
            threadId,
            entityType: CommsEntityType.LEAD,
            entityId: primary.id,
          },
        },
        update: {
          confidence,
          reason,
        },
        create: {
          orgId,
          threadId,
          entityType: CommsEntityType.LEAD,
          entityId: primary.id,
          confidence,
          reason,
        },
      });
      linksCreated.push({
        entityType: CommsEntityType.LEAD,
        entityId: primary.id,
        confidence,
        reason,
      });
    }

    if (linksCreated.length === 0) {
      await prisma.task.create({
        data: {
          orgId,
          kind: 'COMMS_TRIAGE',
          queue: 'COMMS',
          dueAt: new Date(Date.now() + 30 * 60 * 1000),
          priority: TaskPriority.MEDIUM,
          status: 'OPEN',
          metadata: toInputJson({
            threadId,
            phones,
            emails,
            reason: 'No deterministic CRM match found for thread participants.',
          }),
        },
      });
    }

    return {
      linksCreated,
      triageCreated: linksCreated.length === 0,
      participants,
    };
  };

  const commsIMessageSync: ToolHandler = async ({ context, payload }) => {
    const input = commsSyncSchema.parse(payload);
    const account = await resolveCommsAccount({
      orgId: context.orgId,
      kind: 'IMESSAGE',
      accountId: input.accountId,
      externalAccountId: input.externalAccountId,
      displayName: input.displayName,
    });

    const connector = createIMessageConnectorMac();
    let cursor = (input.cursor as Record<string, unknown> | undefined) ??
      (account.syncCursor as Record<string, unknown> | null) ??
      {};
    let totalMessages = 0;
    let totalThreads = 0;
    let loops = 0;
    const touchedThreadIds = new Set<string>();

    while (true) {
      loops += 1;
      if (loops > 500) {
        break;
      }

      const result = await connector.sync(
        context.orgId,
        {
          id: account.id,
          kind: account.kind,
          externalAccountId: account.externalAccountId,
          syncCursor: cursor,
        },
        {
          fullSync: input.fullSync,
          batchSize: input.batchSize,
          cursor,
        },
      );

      for (const threadRecord of result.threads) {
        const thread = await upsertCommsThread({
          orgId: context.orgId,
          channel: CommsChannel.IMESSAGE,
          externalThreadId: threadRecord.externalThreadId,
          participants: threadRecord.participants,
          subject: threadRecord.subject ?? null,
          lastMessageAt: threadRecord.lastMessageAt,
        });
        totalThreads += 1;
        touchedThreadIds.add(thread.id);
      }

      for (const messageRecord of result.messages) {
        const thread = await upsertCommsThread({
          orgId: context.orgId,
          channel: CommsChannel.IMESSAGE,
          externalThreadId: messageRecord.externalThreadId,
          participants: dedupeParticipants([...messageRecord.from, ...messageRecord.to]),
          subject: null,
          lastMessageAt: messageRecord.sentAt,
        });
        touchedThreadIds.add(thread.id);
        await upsertCommsMessage({
          orgId: context.orgId,
          threadId: thread.id,
          record: messageRecord,
        });
        totalMessages += 1;
      }

      cursor = result.cursorUpdate;
      if (!result.hasMore || result.messages.length === 0) {
        break;
      }
    }

    const linkedSummaries: Array<Record<string, unknown>> = [];
    for (const threadId of touchedThreadIds) {
      const linked = await linkThreadDeterministically(context.orgId, threadId);
      linkedSummaries.push({
        threadId,
        linksCreated: linked.linksCreated.length,
        triageCreated: linked.triageCreated,
      });
    }

    const updatedAccount = await prisma.commsAccount.update({
      where: { id: account.id },
      data: {
        lastSyncAt: new Date(),
        syncCursor: toInputJson(cursor),
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'comms.imessage.synced',
      payload: toInputJson({
        accountId: updatedAccount.id,
        messages: totalMessages,
        threads: totalThreads,
        cursor,
      }),
    });

    return jsonResult({
      account: {
        id: updatedAccount.id,
        kind: updatedAccount.kind,
        externalAccountId: updatedAccount.externalAccountId,
      },
      stats: {
        messages: totalMessages,
        threads: totalThreads,
      },
      cursor,
      linkedSummaries,
    });
  };

  const commsGmailSync: ToolHandler = async ({ context, payload }) => {
    const input = commsSyncSchema.parse(payload);
    const account = await resolveCommsAccount({
      orgId: context.orgId,
      kind: 'GMAIL',
      accountId: input.accountId,
      externalAccountId: input.externalAccountId,
      displayName: input.displayName,
    });

    const connector = createGmailConnector();
    const result = await connector.sync(
      context.orgId,
      {
        id: account.id,
        kind: account.kind,
        externalAccountId: account.externalAccountId,
        syncCursor:
          (input.cursor as Record<string, unknown> | undefined) ??
          (account.syncCursor as Record<string, unknown> | null),
      },
      {
        fullSync: input.fullSync,
        batchSize: input.batchSize,
        cursor:
          (input.cursor as Record<string, unknown> | undefined) ??
          (account.syncCursor as Record<string, unknown> | null),
      },
    );

    const touchedThreadIds = new Set<string>();

    for (const threadRecord of result.threads) {
      const thread = await upsertCommsThread({
        orgId: context.orgId,
        channel: CommsChannel.EMAIL,
        externalThreadId: threadRecord.externalThreadId,
        participants: threadRecord.participants,
        subject: threadRecord.subject ?? null,
        lastMessageAt: threadRecord.lastMessageAt,
      });
      touchedThreadIds.add(thread.id);
    }

    for (const messageRecord of result.messages) {
      const thread = await upsertCommsThread({
        orgId: context.orgId,
        channel: CommsChannel.EMAIL,
        externalThreadId: messageRecord.externalThreadId,
        participants: dedupeParticipants([...messageRecord.from, ...messageRecord.to]),
        subject: null,
        lastMessageAt: messageRecord.sentAt,
      });
      touchedThreadIds.add(thread.id);
      await upsertCommsMessage({
        orgId: context.orgId,
        threadId: thread.id,
        record: messageRecord,
      });
    }

    const linkedSummaries: Array<Record<string, unknown>> = [];
    for (const threadId of touchedThreadIds) {
      const linked = await linkThreadDeterministically(context.orgId, threadId);
      linkedSummaries.push({
        threadId,
        linksCreated: linked.linksCreated.length,
        triageCreated: linked.triageCreated,
      });
    }

    const updatedAccount = await prisma.commsAccount.update({
      where: { id: account.id },
      data: {
        lastSyncAt: new Date(),
        syncCursor: toInputJson(result.cursorUpdate),
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'comms.gmail.synced',
      payload: toInputJson({
        accountId: updatedAccount.id,
        messages: result.messages.length,
        threads: result.threads.length,
        cursor: result.cursorUpdate,
        hasMore: result.hasMore,
      }),
    });

    return jsonResult({
      account: {
        id: updatedAccount.id,
        kind: updatedAccount.kind,
        externalAccountId: updatedAccount.externalAccountId,
      },
      stats: {
        messages: result.messages.length,
        threads: result.threads.length,
      },
      hasMore: result.hasMore,
      cursor: result.cursorUpdate,
      linkedSummaries,
    });
  };

  const commsThreadLink: ToolHandler = async ({ context, payload }) => {
    const input = commsThreadLinkSchema.parse(payload);

    const thread = await prisma.commsThread.findFirst({
      where: {
        id: input.threadId,
        orgId: context.orgId,
      },
      select: { id: true },
    });
    if (!thread) {
      throw new Error('Comms thread not found');
    }

    if (input.entityType && input.entityId) {
      const link = await prisma.commsEntityLink.upsert({
        where: {
          orgId_threadId_entityType_entityId: {
            orgId: context.orgId,
            threadId: thread.id,
            entityType: input.entityType as CommsEntityType,
            entityId: input.entityId,
          },
        },
        update: {
          confidence: input.confidence ?? 1,
          reason: input.reason ?? 'Linked by operator',
        },
        create: {
          orgId: context.orgId,
          threadId: thread.id,
          entityType: input.entityType as CommsEntityType,
          entityId: input.entityId,
          confidence: input.confidence ?? 1,
          reason: input.reason ?? 'Linked by operator',
        },
      });

      await enqueueOutbox(prisma, {
        orgId: context.orgId,
        eventType: 'comms.thread.linked',
        payload: toInputJson({
          threadId: thread.id,
          entityType: link.entityType,
          entityId: link.entityId,
          confidence: link.confidence,
        }),
      });

      return jsonResult({
        linksCreated: [link],
        triageCreated: false,
      });
    }

    const linked = await linkThreadDeterministically(context.orgId, thread.id);
    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'comms.thread.linked',
      payload: toInputJson({
        threadId: thread.id,
        linksCreated: linked.linksCreated,
        triageCreated: linked.triageCreated,
      }),
    });

    return jsonResult(linked);
  };

  const commsDraftCreate: ToolHandler = async ({ context, payload }) => {
    const input = commsDraftCreateSchema.parse(payload);
    const actorUserId = await resolveActorUserId(context.orgId, context.actorUserId);

    const thread = await prisma.commsThread.findFirst({
      where: {
        id: input.threadId,
        orgId: context.orgId,
      },
    });
    if (!thread) {
      throw new Error('Comms thread not found');
    }

    if (thread.channel !== (input.channel as CommsChannel)) {
      throw new Error('Draft channel must match thread channel');
    }

    const toParticipants = participantJsonToArray(input.to);

    const draft = await prisma.outboundDraft.create({
      data: {
        orgId: context.orgId,
        threadId: thread.id,
        channel: input.channel as CommsChannel,
        toJson: toInputJson(toParticipants),
        subject: input.subject ?? null,
        bodyText: input.bodyText,
        bodyHtml: input.bodyHtml ?? null,
        status: CommsStatus.DRAFT,
        requiresApproval: true,
        createdByUserId: actorUserId,
      },
    });

    const message = await prisma.commsMessage.create({
      data: {
        orgId: context.orgId,
        threadId: thread.id,
        channel: input.channel as CommsChannel,
        direction: CommsDirection.OUTBOUND,
        status: CommsStatus.DRAFT,
        externalMessageId: `draft-${draft.id}`,
        sentAt: new Date(),
        fromJson: toInputJson([{ name: 'Draft' }]),
        toJson: toInputJson(toParticipants),
        bodyText: input.bodyText,
        bodyHtml: input.bodyHtml ?? null,
        snippet: input.bodyText.slice(0, 180),
        attachmentsJson: toInputJson([]),
        rawRef: toInputJson({ source: 'outbound-draft', draftId: draft.id }),
        createdByUserId: actorUserId,
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'comms.draft.created',
      payload: toInputJson({
        draftId: draft.id,
        threadId: draft.threadId,
        channel: draft.channel,
      }),
    });

    return jsonResult({
      draft: {
        id: draft.id,
        threadId: draft.threadId,
        channel: draft.channel,
        status: draft.status,
      },
      message: {
        id: message.id,
        status: message.status,
      },
    });
  };

  const commsDraftApproveAndSend: ToolHandler = async ({ context, payload }) => {
    const input = commsDraftApproveSendSchema.parse(payload);
    const actorUserId = await resolveActorUserId(context.orgId, context.actorUserId);

    const draft = await prisma.outboundDraft.findFirst({
      where: {
        id: input.draftId,
        orgId: context.orgId,
      },
      include: {
        thread: true,
      },
    });
    if (!draft) {
      throw new Error('Outbound draft not found');
    }

    if (!context.approvedExecution) {
      if (draft.status === CommsStatus.SENT) {
        return jsonResult({
          draft: {
            id: draft.id,
            status: draft.status,
            sentAt: draft.sentAt?.toISOString() ?? null,
          },
          idempotent: true,
          reason: 'Draft already sent',
        });
      }
      if (draft.status === CommsStatus.QUEUED_APPROVAL) {
        return jsonResult({
          draft: {
            id: draft.id,
            status: draft.status,
            sentAt: draft.sentAt?.toISOString() ?? null,
          },
          idempotent: true,
          reason: 'Draft is already queued for approval',
        });
      }
      await prisma.outboundDraft.update({
        where: { id: draft.id },
        data: {
          status: CommsStatus.QUEUED_APPROVAL,
        },
      });

      return handlerGovernanceDirective({
        status: 'QUEUED_APPROVAL',
        requiredApprovals: 1,
        reason: 'Outbound communication send requires approval.',
        approvalPayload: { draftId: draft.id },
        decision: {
          decision: 'QUEUED_APPROVAL',
          stage: 'AUTONOMY_GATE',
          reason: 'Outbound communication send requires approval.',
          details: {
            policyPath: 'comms.outbound.approval',
            draftId: draft.id,
            threadId: draft.threadId,
          },
        },
      });
    }

    if (draft.status === CommsStatus.SENT) {
      return jsonResult({
        draft: {
          id: draft.id,
          status: draft.status,
          sentAt: draft.sentAt?.toISOString() ?? null,
        },
        idempotent: true,
        reason: 'Draft already sent',
      });
    }

    const recipientParticipants = participantJsonToArray(draft.toJson);
    const recipientEmails = recipientParticipants
      .map((participant) => normalizeEmail(participant.email ?? participant.raw))
      .filter((value): value is string => Boolean(value));
    const recipientPhones = recipientParticipants
      .map((participant) => normalizePhone(participant.phone ?? participant.raw))
      .filter((value): value is string => Boolean(value));

    const schedulingSettings = await prisma.orgSchedulingSettings.findUnique({
      where: { orgId: context.orgId },
      select: { timezone: true },
    });
    const timezone = schedulingSettings?.timezone ?? 'America/Denver';
    const hour = localHourInTimezone(new Date(), timezone);
    if (process.env.COMMS_SKIP_TIME_WINDOW !== 'true' && (hour < 9 || hour >= 18)) {
      return handlerGovernanceDirective({
        status: 'BLOCKED',
        reason: `Outbound communication send is restricted to business hours (09:00-18:00 ${timezone}).`,
        decision: {
          decision: 'BLOCKED',
          stage: 'TIME_WINDOW',
          reason: `Outbound communication send is restricted to business hours (09:00-18:00 ${timezone}).`,
          details: {
            policyPath: 'autonomy.timeWindows',
            toolName: 'comms.draft.approveAndSend',
            window: {
              timezone,
              start: '09:00',
              end: '18:00',
              hour,
            },
          },
        },
      });
    }

    const windowStart = new Date();
    windowStart.setUTCHours(0, 0, 0, 0);
    const sentToday = await prisma.outboundDraft.count({
      where: {
        orgId: context.orgId,
        status: CommsStatus.SENT,
        sentAt: { gte: windowStart },
      },
    });
    if (sentToday >= 25) {
      return handlerGovernanceDirective({
        status: 'BLOCKED',
        reason: 'Daily outbound communication limit reached (25/day).',
        decision: {
          decision: 'BLOCKED',
          stage: 'PER_TOOL_LIMIT',
          reason: 'Daily outbound communication limit reached (25/day).',
          details: {
            policyPath: 'autonomy.rateLimits.perTool',
            toolName: 'comms.draft.approveAndSend',
            rate: {
              maxPerDay: 25,
              countToday: sentToday,
            },
          },
        },
      });
    }

    const sentDraftsToday = await prisma.outboundDraft.findMany({
      where: {
        orgId: context.orgId,
        status: CommsStatus.SENT,
        sentAt: { gte: windowStart },
      },
      select: {
        toJson: true,
      },
    });
    const perContactCounter = new Map<string, number>();
    for (const sentDraft of sentDraftsToday) {
      for (const participant of participantJsonToArray(sentDraft.toJson)) {
        const key =
          normalizeEmail(participant.email ?? participant.raw) ??
          normalizePhone(participant.phone ?? participant.raw) ??
          null;
        if (!key) {
          continue;
        }
        perContactCounter.set(key, (perContactCounter.get(key) ?? 0) + 1);
      }
    }

    const contactLimit =
      Number.parseInt(process.env.COMMS_MAX_PER_CONTACT_PER_DAY ?? '5', 10) || 5;
    const draftTargets = [...recipientEmails, ...recipientPhones];
    for (const target of draftTargets) {
      if ((perContactCounter.get(target) ?? 0) >= contactLimit) {
        return handlerGovernanceDirective({
          status: 'BLOCKED',
          reason: `Per-contact daily outbound limit reached for ${target}.`,
          decision: {
            decision: 'BLOCKED',
            stage: 'PER_TOOL_LIMIT',
            reason: `Per-contact daily outbound limit reached for ${target}.`,
            details: {
              policyPath: 'autonomy.rateLimits.perTool',
              toolName: 'comms.draft.approveAndSend',
              rate: {
                maxPerContactPerDay: contactLimit,
                contact: target,
                countToday: perContactCounter.get(target) ?? 0,
              },
            },
          },
        });
      }
    }

    if (process.env.COMMS_SEND_STUB !== 'true') {
      if (draft.channel === CommsChannel.EMAIL) {
        if (recipientEmails.length === 0) {
          throw new Error('Email draft requires at least one recipient email');
        }
        const accessToken = process.env.GMAIL_ACCESS_TOKEN;
        if (!accessToken) {
          throw new Error('GMAIL_ACCESS_TOKEN is required to send email drafts');
        }
        await sendGmailMessage({
          accessToken,
          to: recipientEmails,
          subject: draft.subject,
          bodyText: draft.bodyText,
          bodyHtml: draft.bodyHtml,
        });
      } else {
        const recipient = recipientPhones[0];
        if (!recipient) {
          throw new Error('iMessage/SMS draft requires at least one recipient phone');
        }
        await sendIMessageViaShortcut({
          recipient,
          message: draft.bodyText,
        });
      }
    }

    const sentAt = new Date();
    const updatedDraft = await prisma.outboundDraft.update({
      where: { id: draft.id },
      data: {
        status: CommsStatus.SENT,
        approvedAt: draft.approvedAt ?? sentAt,
        approvedByUserId: actorUserId,
        sentAt,
        error: null,
      },
    });

    await prisma.commsMessage.create({
      data: {
        orgId: context.orgId,
        threadId: draft.threadId,
        channel: draft.channel,
        direction: CommsDirection.OUTBOUND,
        status: CommsStatus.SENT,
        externalMessageId: `sent-${draft.id}-${sentAt.getTime()}`,
        sentAt,
        fromJson: toInputJson([{ name: 'Operator' }]),
        toJson: toInputJson(recipientParticipants),
        bodyText: draft.bodyText,
        bodyHtml: draft.bodyHtml ?? null,
        snippet: draft.bodyText.slice(0, 180),
        attachmentsJson: toInputJson([]),
        rawRef: toInputJson({ source: 'outbound-draft-send', draftId: draft.id }),
        createdByUserId: actorUserId,
      },
    });

    await prisma.commsThread.update({
      where: { id: draft.threadId },
      data: {
        lastMessageAt: sentAt,
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'comms.draft.sent',
      payload: toInputJson({
        draftId: draft.id,
        threadId: draft.threadId,
        channel: draft.channel,
        sentAt: sentAt.toISOString(),
      }),
    });

    return jsonResult({
      draft: {
        id: updatedDraft.id,
        status: updatedDraft.status,
        sentAt: updatedDraft.sentAt?.toISOString() ?? null,
      },
    });
  };

  const commsDraftUpdate: ToolHandler = async ({ context, payload }) => {
    const input = commsDraftUpdateSchema.parse(payload);
    const actorUserId = await resolveActorUserId(context.orgId, context.actorUserId);

    const draft = await prisma.outboundDraft.findFirst({
      where: {
        id: input.draftId,
        orgId: context.orgId,
      },
    });
    if (!draft) {
      throw new Error('Outbound draft not found');
    }

    if (draft.status !== CommsStatus.DRAFT && draft.status !== CommsStatus.QUEUED_APPROVAL) {
      throw new Error('Only DRAFT or QUEUED_APPROVAL drafts can be edited');
    }

    const updated = await prisma.outboundDraft.update({
      where: { id: draft.id },
      data: {
        subject: input.subject ?? null,
        bodyText: input.bodyText,
        bodyHtml: input.bodyHtml ?? null,
        status: CommsStatus.DRAFT,
      },
    });

    await prisma.commsMessage.create({
      data: {
        orgId: context.orgId,
        threadId: draft.threadId,
        channel: draft.channel,
        direction: CommsDirection.OUTBOUND,
        status: CommsStatus.DRAFT,
        externalMessageId: `draft-update-${draft.id}-${Date.now()}`,
        sentAt: new Date(),
        fromJson: toInputJson([{ name: 'Operator' }]),
        toJson: toInputJson(draft.toJson),
        bodyText: input.bodyText,
        bodyHtml: input.bodyHtml ?? null,
        snippet: input.bodyText.slice(0, 180),
        attachmentsJson: toInputJson([]),
        rawRef: toInputJson({
          source: 'outbound-draft-update',
          draftId: draft.id,
          updatedByUserId: actorUserId,
        }),
        createdByUserId: actorUserId,
      },
    });

    await enqueueOutbox(prisma, {
      orgId: context.orgId,
      eventType: 'comms.draft.updated',
      payload: toInputJson({
        draftId: updated.id,
        threadId: updated.threadId,
      }),
    });

    return jsonResult({
      draft: {
        id: updated.id,
        status: updated.status,
        subject: updated.subject,
        bodyText: updated.bodyText,
        updatedAt: updated.updatedAt.toISOString(),
      },
    });
  };

  const commsMessageMarkTriaged: ToolHandler = async ({ context, payload }) => {
    const input = commsMessageMarkTriagedSchema.parse(payload);

    const message = await prisma.commsMessage.findFirst({
      where: {
        id: input.messageId,
        orgId: context.orgId,
      },
      select: {
        id: true,
        triagedAt: true,
      },
    });
    if (!message) {
      throw new Error('Comms message not found');
    }

    const updated = await prisma.commsMessage.update({
      where: { id: message.id },
      data: {
        triagedAt: message.triagedAt ?? new Date(),
      },
    });

    return jsonResult({
      message: {
        id: updated.id,
        triagedAt: updated.triagedAt?.toISOString() ?? null,
      },
    });
  };

  const genericNoop: ToolHandler = async ({ tool, payload }) => {
    return jsonResult({
      handler: tool.handlerKey,
      status: 'NOOP',
      payload,
    });
  };

  return {
    'reporting.context.build': reportingContextBuild,
    'crm.lead.create': leadCreate,
    'lead.profile.upsert': leadProfileUpsert,
    'lead.site.upsert': leadSiteUpsert,
    'lead.stage.update': leadStageUpdateV2,
    'lead.owner.assign': leadOwnerAssign,
    'lead.touch.record': leadTouchRecord,
    'lead.nextAction.set': leadNextActionSet,
    'lead.sla.evaluate': leadSlaEvaluate,
    'lead.nurture.enroll': leadNurtureEnroll,
    'crm.lead.updateStage': leadUpdateStage,
    'crm.lead.upsertFromWebsite': leadUpsertFromWebsite,
    'crm.lead.list': leadList,
    'crm.customer.get': customerGet,
    'jobs.list': jobsList,
    'crm.lead.score': leadScore,
    'crm.task.create': taskCreate,
    'crm.task.createSalesSla': taskCreateSalesSla,
    'crm.note.add': noteAdd,
    'crm.timeline.add': timelineAdd,
    'crm.attribution.captureFromWebsite': attributionCaptureFromWebsite,
    'crm.attachmentRef.create': attachmentRefCreate,
    'crm.priceMatch.create': priceMatchCreate,
    'marketing.sms.draft': smsDraft,
    'marketing.email.draft': emailDraft,
    'marketing.sms.send': smsSend,
    'marketing.email.send': emailSend,
    'marketing.review.request.draft': reviewRequestDraft,
    'marketing.review.request.send': reviewRequestSend,
    'marketing.review.request.auto': reviewRequestAuto,
    'marketing.referral.invite': referralInvite,
    'marketing.referral.convert': referralConvert,
    'marketing.referral.reward.issue': referralRewardIssue,
    'crm.quote.send': quoteSend,
    'crm.quote.accept': quoteAccept,
    'contract.clause.createDraft': contractClauseCreateDraft,
    'contract.clause.updateDraft': contractClauseUpdateDraft,
    'contract.clause.publish': contractClausePublish,
    'contract.clause.deprecate': contractClauseDeprecate,
    'contract.template.createDraft': contractTemplateCreateDraft,
    'contract.template.updateStructure': contractTemplateUpdateStructure,
    'contract.template.updateVariableSchema': contractTemplateUpdateVariableSchema,
    'contract.template.publish': contractTemplatePublish,
    'contract.legalPack.upsert': contractLegalPackUpsert,
    'quote.manifest.generate': quoteManifestGenerate,
    'quote.manifest.get': quoteManifestGet,
    'quote.accept.withEvidence': quoteAcceptWithEvidence,
    'contract.preview.fromQuote': contractPreviewFromQuote,
    'contract.draft.createFromQuote': contractDraftCreateFromQuote,
    'contract.draft.generatePdf': contractDraftGeneratePdf,
    'contract.signatureEnvelope.createForQuote': contractSignatureEnvelopeCreateForQuote,
    'contract.esign.send': contractEsignSend,
    'contract.finalizeFromQuote': contractFinalizeFromQuote,
    'contract.redline.generate': contractRedlineGenerate,
    'contract.references.extract': contractReferencesExtract,
    'crm.job.createFromQuote': jobCreateFromQuote,
    'scheduling.settings.update': schedulingSettingsUpdate,
    'scheduling.blocks.listAvailability': schedulingBlocksListAvailability,
    'scheduling.appointment.listForDay': schedulingAppointmentListForDay,
    'scheduling.appointment.bookFromToken': schedulingAppointmentBookFromToken,
    'scheduling.appointment.assignTech': schedulingAppointmentAssignTech,
    'scheduling.appointment.reschedule': schedulingAppointmentReschedule,
    'scheduling.appointment.cancel': schedulingAppointmentCancel,
    'time.clockIn': timeClockIn,
    'time.clockOut': timeClockOut,
    'time.breakStart': timeBreakStart,
    'time.breakEnd': timeBreakEnd,
    'time.jobStart': timeJobStart,
    'time.jobStop': timeJobStop,
    'time.edit.request': timeEditRequest,
    'time.edit.review': timeEditReview,
    'auth.mobile.pin.set': mobilePinSet,
    'auth.mobile.pin.reset': mobilePinReset,
    'auth.mobile.pin.login': mobilePinLogin,
    'comms.imessage.sync': commsIMessageSync,
    'comms.gmail.sync': commsGmailSync,
    'comms.thread.link': commsThreadLink,
    'comms.draft.create': commsDraftCreate,
    'comms.draft.update': commsDraftUpdate,
    'comms.draft.approveAndSend': commsDraftApproveAndSend,
    'comms.message.markTriaged': commsMessageMarkTriaged,
    'jobs.schedule.change': scheduleChange,
    'jobs.job.create': jobCreate,
    'jobs.geo.ensure': jobGeoEnsure,
    'jobs.dispatch.assign': dispatchAssign,
    'billing.invoice.create': invoiceCreate,
    'billing.invoice.issue': invoiceIssue,
    'crm.customer.upsertFromJobberCsv': customerUpsertFromJobberCsv,
    'pricing.item.upsertFromJobberCsv': pricingItemUpsertFromJobberCsv,
    'crm.quote.importFromJobberCsv': quoteImportFromJobberCsv,
    'billing.invoice.importFromJobberCsv': invoiceImportFromJobberCsv,
    'catalog.equipment.importCsv': equipmentCatalogImportCsv,
    'catalog.equipment.lookup': equipmentCatalogLookup,
    'catalog.equipment.options.generate': equipmentOptionsGenerate,
    'crm.equipmentSpec.selectForAssessment': equipmentSpecSelectForAssessment,
    'crm.assessment.create': assessmentCreate,
    'crm.assessment.attachment.add': assessmentAttachmentAdd,
    'media.uploadSession.start': mediaUploadSessionStart,
    'media.uploadSession.complete': mediaUploadSessionComplete,
    'media.uploadSession.fail': mediaUploadSessionFail,
    'media.photo.upload': mediaPhotoUpload,
    'media.list': mediaList,
    'media.setPublic': mediaSetPublic,
    'media.delete': mediaDelete,
    'admin.media.purgeExpired': adminMediaPurgeExpired,
    'crm.assessment.update': assessmentUpdate,
    'crm.assessment.updateInstallPricingInputs': assessmentUpdateInstallPricingInputs,
    'crm.quote.generateInstallOptions': quoteGenerateInstallOptions,
    'crm.quote.applyDiscount': quoteApplyDiscount,
    'crm.serviceQuote.createFromBundle': serviceQuoteCreateFromBundle,
    'crm.serviceQuote.addLineItem': serviceQuoteAddLineItem,
    'crm.serviceQuote.removeLineItem': serviceQuoteRemoveLineItem,
    'crm.serviceQuote.setLaborHours': serviceQuoteSetLaborHours,
    'crm.serviceQuote.setTiming': serviceQuoteSetTiming,
    'crm.serviceQuote.applyDiscount': serviceQuoteApplyDiscount,
    'admin.bundleTemplates.upsert': adminBundleTemplateUpsert,
    'admin.pricebook.upsertCategory': adminPricebookCategoryUpsert,
    'admin.pricebook.upsertItem': adminPricebookItemUpsert,
    'system.pricing.overrideBlock': pricingOverrideBlock,
    'marketing.attribution.capture': attributionCapture,
    'marketing.call.ingest': callIngest,
    'accounting.receipt.upload': receiptUpload,
    'accounting.receipt.ocr.request': receiptOcrRequest,
    'accounting.receipt.applyOcr': receiptApplyOcr,
    'accounting.expense.update': expenseUpdate,
    'accounting.expense.submit': expenseSubmit,
    'accounting.expense.approve': expenseApprove,
    'accounting.vendor.upsert': vendorUpsert,
    'accounting.category.list': categoryList,
    'billing.subscription.create': genericNoop,
    'reporting.run.summary': summaryRun,
    'system.killswitch.status': killSwitchStatus,
    'system.killswitch.set': killSwitchSet,
    'system.agent.run.start': agentRunStart,
    'system.agent.run.pause': agentRunPause,
    'system.agent.run.resume': agentRunResume,
    'system.agent.run.cancel': agentRunCancel,
    'system.agent.run.suggest_skill': agentRunSuggestSkill,
    'crm.contact.update': genericNoop,
    'contracts.renew': genericNoop,
    'billing.subscription.modify': genericNoop,
    'pricing.discount.apply': genericNoop,
    'pricing.plan.change': genericNoop,
    'contracts.price.change': genericNoop,
    'crm.lead.convert': genericNoop,
    'inventory.part.reserve': genericNoop,
    'reporting.export.csv': genericNoop,
    'billing.refund.issue': genericNoop,
    'auth.role.assign': genericNoop,
    'crm.customer.delete': genericNoop,
    'jobs.job.delete': genericNoop,
    'system.user.disable': genericNoop,
    'crm.communication.log': genericNoop,
    'crm.lead.tag.add': genericNoop,
    'jobs.note.add': genericNoop,
    'jobs.priority.update': genericNoop,
    'billing.payment.record': genericNoop,
    'billing.adjustment.create': genericNoop,
    'jobs.dispatch.cancel': genericNoop,
  };
}

export function createHandlerMap(prisma: PrismaClient): HandlerMap {
  return buildCoreHandlers(prisma);
}
