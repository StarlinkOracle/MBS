import express, {
  NextFunction,
  Request,
  Response,
} from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createHash,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  extname,
  basename,
  join,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGunzip } from 'node:zlib';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import multer from 'multer';

import {
  MASTER_AGENT_GRAPH,
  toAgentGraphView,
} from '@rcs/agent-graph';
import {
  ActorType,
  ApprovalStatus,
  ClientActionStatus,
  CommsStatus,
  ExecutionStatus,
  ImportMode,
  ImportProvider,
  ImportRunStatus,
  LeadStage,
  LeadType,
  Prisma,
  MobileSyncCursorType,
  OutboxStatus,
  RiskLevel,
  TaskStatus,
  TimeEntryStatus,
  TimeEntryType,
  prisma,
} from '@rcs/db';
import { enqueueOutbox } from '@rcs/event-bus';
import {
  computeChecksum,
  deleteObject as deleteStorageObject,
  getObject as getStorageObject,
  getSignedUrl as getStorageSignedUrl,
  putObject,
} from '@rcs/storage';
import {
  ToolRegistry,
  type ToolExecutionResponse,
} from '@rcs/tool-registry';
import { z } from 'zod';

import { resolveApprovalStatus } from './approval-flow.js';
import {
  assertPlaybookInputShape,
  assertPlaybookInputSize,
  executePlaybook,
  loadPlaybookPack,
  PlaybookInputShapeError,
  PlaybookInputTooLargeError,
  PlaybookPackValidationError,
  type LoadedPlaybookPack,
  type PlaybookExecutionResult,
} from './agent-playbooks.js';
import {
  AsyncTimeoutError,
  runWithTimeout,
} from './async-timeout.js';
import {
  getPlaybookExecutionInflightSnapshot,
  isPlaybookRequestKeyInflight,
  tryAcquirePlaybookExecutionSlot,
} from './playbook-execution-guard.js';
import {
  evaluatePlaybookFailClosedGate,
  loadPlaybookFailClosedConfig,
} from './playbook-governance-gate.js';
import { buildPhotoDerivatives } from './media-processing.js';
import { registerHvacDiagnosticRoutes } from './hvac-diagnostic-routes.js';
import {
  advanceStreamCursor,
  applyLastEventIdCursor,
  parseStreamCursor,
  shouldEmitStreamEvent,
  type StreamCursorEvent,
} from './stream-cursor.js';
import {
  capStreamEvents,
  parseStreamSinceCursor,
  parseStreamEventTypeFilter,
  StreamConnectionRegistry,
} from './stream-guards.js';

const app = express();
const registry = new ToolRegistry(prisma);
const requestCorrelationStore = new AsyncLocalStorage<string>();
const rawRegistryExecute = registry.execute.bind(registry);
registry.execute = ((toolName, payload, context) =>
  rawRegistryExecute(toolName, payload, {
    ...context,
    correlationId: context.correlationId ?? requestCorrelationStore.getStore(),
  })) as ToolRegistry['execute'];

const rawRegistryExplain = registry.explain.bind(registry);
registry.explain = ((toolName, payload, context) =>
  rawRegistryExplain(toolName, payload, {
    ...context,
    correlationId: context.correlationId ?? requestCorrelationStore.getStore(),
  })) as ToolRegistry['explain'];
const jobberCsvUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.JOBBER_CSV_MAX_FILE_BYTES ?? 15 * 1024 * 1024),
  },
});
const equipmentCatalogUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.EQUIPMENT_CSV_MAX_FILE_BYTES ?? 15 * 1024 * 1024),
  },
});
const assessmentNameplateUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.NAMEPLATE_UPLOAD_MAX_FILE_BYTES ?? 12 * 1024 * 1024),
  },
});
const receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.RECEIPT_UPLOAD_MAX_FILE_BYTES ?? 12 * 1024 * 1024),
  },
});
const mediaPhotoUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.MEDIA_UPLOAD_MAX_FILE_BYTES ?? 20 * 1024 * 1024),
  },
});
const CORRELATION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const MOBILE_DEVICE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const MOBILE_TOOL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;
const MOBILE_ORG_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MOBILE_BEARER_TOKEN_MAX_LENGTH = 4096;
const MOBILE_JWT_ISSUER = (process.env.MOBILE_JWT_ISSUER ?? 'mbs-mobile').trim();
const MOBILE_JWT_ACCESS_AUDIENCE = (process.env.MOBILE_JWT_ACCESS_AUDIENCE ?? 'mbs-mobile-access').trim();
const MOBILE_JWT_REFRESH_AUDIENCE = (process.env.MOBILE_JWT_REFRESH_AUDIENCE ?? 'mbs-mobile-refresh').trim();

function resolveRequestCorrelationId(value: unknown): string {
  if (typeof value !== 'string') {
    return randomUUID();
  }
  const trimmed = value.trim();
  if (!CORRELATION_ID_PATTERN.test(trimmed)) {
    return randomUUID();
  }
  return trimmed;
}

const allowedOrigins = new Set(
  (process.env.CORS_ALLOWED_ORIGINS ??
    'http://localhost:5173,http://127.0.0.1:5173,http://0.0.0.0:5173')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0),
);

app.use((req, res, next) => {
  const correlationId = resolveRequestCorrelationId(req.header('x-correlation-id'));
  const startedAt = Date.now();

  requestCorrelationStore.run(correlationId, () => {
    res.setHeader('x-correlation-id', correlationId);
    logStructured('info', 'http.request.started', {
      correlationId,
      method: req.method,
      path: req.path,
      orgSlug: req.header('x-org-slug') ?? null,
      actorUserId: req.header('x-actor-user-id') ?? null,
    });

    res.on('finish', () => {
      const durationMs = Date.now() - startedAt;
      const statusCode = res.statusCode;
      const level =
        statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
      const finishPayload = {
        correlationId,
        method: req.method,
        path: req.path,
        statusCode,
        durationMs,
      };

      logStructured(level, 'http.request.finished', finishPayload);
      if (statusCode >= 500) {
        void emitErrorTelemetry({
          type: 'http_request_failure',
          ...finishPayload,
        });
      }
    });

    next();
  });
});

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, x-actor-user-id, x-actor-label',
  );
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  );

  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }

  next();
});

const API_JSON_BODY_LIMIT = process.env.API_JSON_BODY_LIMIT ?? '1mb';
app.use(express.json({ limit: API_JSON_BODY_LIMIT }));
app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  const err = error as { status?: number; type?: string } | undefined;
  if (err?.type === 'entity.too.large' || err?.status === 413) {
    res.status(413).json({
      error: {
        code: 'API_JSON_PAYLOAD_TOO_LARGE',
        message: 'JSON payload exceeds API body size limit',
        recoverable: true,
        details: {
          limit: API_JSON_BODY_LIMIT,
        },
      },
    });
    return;
  }
  if (error instanceof SyntaxError) {
    res.status(400).json({
      error: {
        code: 'API_JSON_INVALID',
        message: 'Invalid JSON payload',
        recoverable: true,
      },
    });
    return;
  }
  next(error);
});

const STREAM_EVENT_TYPES = [
  'tool.execution.created',
  'tool.execution.updated',
  'approval.request.created',
  'approval.request.updated',
  'agent.run.updated',
  'system.killswitch.updated',
  'system.policy.updated',
  'finance.exposure.updated',
] as const;

type StreamEventType = (typeof STREAM_EVENT_TYPES)[number];

type StreamEventMessage = {
  type: StreamEventType;
  at: Date;
  key: string;
  payload: Record<string, unknown>;
};

const STREAM_MAX_ROWS_PER_TABLE = parsePositiveIntValue(
  process.env.STREAM_MAX_ROWS_PER_TABLE,
  200,
);
const STREAM_MAX_EVENTS_PER_POLL = parsePositiveIntValue(
  process.env.STREAM_MAX_EVENTS_PER_POLL,
  400,
);
const STREAM_MAX_CONNECTIONS_GLOBAL = parsePositiveIntValue(
  process.env.STREAM_MAX_CONNECTIONS_GLOBAL,
  150,
);
const STREAM_MAX_CONNECTIONS_PER_USER = parsePositiveIntValue(
  process.env.STREAM_MAX_CONNECTIONS_PER_USER,
  4,
);
const STREAM_MAX_BACKPRESSURE_MS = parsePositiveIntValue(
  process.env.STREAM_MAX_BACKPRESSURE_MS,
  30_000,
);

const streamConnections = new StreamConnectionRegistry(
  STREAM_MAX_CONNECTIONS_GLOBAL,
  STREAM_MAX_CONNECTIONS_PER_USER,
);

const playbookPackCache = new Map<string, LoadedPlaybookPack>();

async function getPlaybookPack(packId: string): Promise<LoadedPlaybookPack> {
  const cached = playbookPackCache.get(packId);
  if (cached) {
    return cached;
  }

  // Delegate pack path resolution to loadPlaybookPack so manifest integrity
  // enforcement remains active for runtime loading.
  const loaded = await loadPlaybookPack({ packId });
  playbookPackCache.set(packId, loaded);
  return loaded;
}

const JOBBER_CSV_TYPES = [
  'clients',
  'products_services',
  'quotes_report',
  'invoices_report',
] as const;

type JobberCsvType = (typeof JOBBER_CSV_TYPES)[number];

type IngestAuthContext = {
  token: string;
  sourceIpHash: string;
};

type IngestRateWindow = {
  windowStartMs: number;
  count: number;
};

type RateLimitEventKey =
  | 'ingest'
  | 'mobile_login'
  | 'mobile_refresh'
  | 'mobile_sync_push'
  | 'mobile_sync_pull'
  | 'call_webhook'
  | 'agent_playbook';

const ingestRateWindowByKey = new Map<string, IngestRateWindow>();
const mobileAuthRateWindowByKey = new Map<string, IngestRateWindow>();
const mobileRefreshRateWindowByKey = new Map<string, IngestRateWindow>();
const mobileSyncPushRateWindowByKey = new Map<string, IngestRateWindow>();
const mobileSyncPullRateWindowByKey = new Map<string, IngestRateWindow>();
const callWebhookRateWindowByKey = new Map<string, IngestRateWindow>();
const agentPlaybookRateWindowByKey = new Map<string, IngestRateWindow>();
const rateLimitEventsByKey = new Map<RateLimitEventKey, number[]>();
const playbookInflightLimitEvents: number[] = [];
const playbookRequestTimeoutEvents: number[] = [];
const playbookPackLoadFailureEvents: number[] = [];
const playbookPayloadRejectedEvents: number[] = [];
const playbookDuplicateInflightEvents: number[] = [];
const playbookFailClosedBlockedEvents: number[] = [];
const playbookGovernanceErrorEvents: number[] = [];
const mobileSyncPayloadRejectedEvents: number[] = [];
const RATE_LIMIT_MAX_KEYS = Number.parseInt(process.env.RATE_LIMIT_MAX_KEYS ?? '10000', 10);

function applyWindowRateLimit(args: {
  store: Map<string, IngestRateWindow>;
  key: string;
  windowMs: number;
  limit: number;
}): boolean {
  const nowMs = Date.now();
  const safeWindowMs = Number.isFinite(args.windowMs) && args.windowMs > 0 ? args.windowMs : 60000;
  const safeLimit = Number.isFinite(args.limit) && args.limit > 0 ? args.limit : 1;
  const safeMaxKeys = Number.isFinite(RATE_LIMIT_MAX_KEYS) && RATE_LIMIT_MAX_KEYS > 0
    ? RATE_LIMIT_MAX_KEYS
    : 10000;

  // Opportunistic cleanup keeps in-memory rate limiter bounded under sustained traffic.
  if (args.store.size > safeMaxKeys) {
    for (const [storeKey, value] of args.store) {
      if (nowMs - value.windowStartMs >= safeWindowMs) {
        args.store.delete(storeKey);
      }
    }
  }
  while (args.store.size > safeMaxKeys) {
    const oldestKey = args.store.keys().next().value;
    if (typeof oldestKey !== 'string') {
      break;
    }
    args.store.delete(oldestKey);
  }

  const existing = args.store.get(args.key);
  if (!existing || nowMs - existing.windowStartMs >= safeWindowMs) {
    args.store.set(args.key, { windowStartMs: nowMs, count: 1 });
    return true;
  }
  if (existing.count >= safeLimit) {
    return false;
  }
  existing.count += 1;
  args.store.set(args.key, existing);
  return true;
}

function recordRateLimitEvent(key: RateLimitEventKey): void {
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  const existing = rateLimitEventsByKey.get(key) ?? [];
  const next = existing.filter((timestamp) => timestamp >= cutoff);
  next.push(now);
  if (next.length > 5000) {
    next.splice(0, next.length - 5000);
  }
  rateLimitEventsByKey.set(key, next);
}

function getRateLimitEventCount1h(key: RateLimitEventKey): number {
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  const existing = rateLimitEventsByKey.get(key) ?? [];
  if (existing.length === 0) {
    return 0;
  }
  const next = existing.filter((timestamp) => timestamp >= cutoff);
  if (next.length !== existing.length) {
    rateLimitEventsByKey.set(key, next);
  }
  return next.length;
}

function recordMobileSyncPayloadRejectedEvent(): void {
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  const next = mobileSyncPayloadRejectedEvents.filter((timestamp) => timestamp >= cutoff);
  next.push(now);
  if (next.length > 5000) {
    next.splice(0, next.length - 5000);
  }
  mobileSyncPayloadRejectedEvents.splice(0, mobileSyncPayloadRejectedEvents.length, ...next);
}

function getMobileSyncPayloadRejectedEventCount1h(): number {
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  const next = mobileSyncPayloadRejectedEvents.filter((timestamp) => timestamp >= cutoff);
  if (next.length !== mobileSyncPayloadRejectedEvents.length) {
    mobileSyncPayloadRejectedEvents.splice(0, mobileSyncPayloadRejectedEvents.length, ...next);
  }
  return next.length;
}

function recordPlaybookInflightLimitEvent(): void {
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  const next = playbookInflightLimitEvents.filter((timestamp) => timestamp >= cutoff);
  next.push(now);
  if (next.length > 5000) {
    next.splice(0, next.length - 5000);
  }
  playbookInflightLimitEvents.splice(0, playbookInflightLimitEvents.length, ...next);
}

function getPlaybookInflightLimitEventCount1h(): number {
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  const next = playbookInflightLimitEvents.filter((timestamp) => timestamp >= cutoff);
  if (next.length !== playbookInflightLimitEvents.length) {
    playbookInflightLimitEvents.splice(0, playbookInflightLimitEvents.length, ...next);
  }
  return next.length;
}

function recordPlaybookRequestTimeoutEvent(): void {
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  const next = playbookRequestTimeoutEvents.filter((timestamp) => timestamp >= cutoff);
  next.push(now);
  if (next.length > 5000) {
    next.splice(0, next.length - 5000);
  }
  playbookRequestTimeoutEvents.splice(0, playbookRequestTimeoutEvents.length, ...next);
}

function getPlaybookRequestTimeoutEventCount1h(): number {
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  const next = playbookRequestTimeoutEvents.filter((timestamp) => timestamp >= cutoff);
  if (next.length !== playbookRequestTimeoutEvents.length) {
    playbookRequestTimeoutEvents.splice(0, playbookRequestTimeoutEvents.length, ...next);
  }
  return next.length;
}

function recordPlaybookPackLoadFailureEvent(): void {
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  const next = playbookPackLoadFailureEvents.filter((timestamp) => timestamp >= cutoff);
  next.push(now);
  if (next.length > 5000) {
    next.splice(0, next.length - 5000);
  }
  playbookPackLoadFailureEvents.splice(0, playbookPackLoadFailureEvents.length, ...next);
}

function getPlaybookPackLoadFailureEventCount1h(): number {
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  const next = playbookPackLoadFailureEvents.filter((timestamp) => timestamp >= cutoff);
  if (next.length !== playbookPackLoadFailureEvents.length) {
    playbookPackLoadFailureEvents.splice(0, playbookPackLoadFailureEvents.length, ...next);
  }
  return next.length;
}

function recordPlaybookPayloadRejectedEvent(): void {
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  const next = playbookPayloadRejectedEvents.filter((timestamp) => timestamp >= cutoff);
  next.push(now);
  if (next.length > 5000) {
    next.splice(0, next.length - 5000);
  }
  playbookPayloadRejectedEvents.splice(0, playbookPayloadRejectedEvents.length, ...next);
}

function getPlaybookPayloadRejectedEventCount1h(): number {
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  const next = playbookPayloadRejectedEvents.filter((timestamp) => timestamp >= cutoff);
  if (next.length !== playbookPayloadRejectedEvents.length) {
    playbookPayloadRejectedEvents.splice(0, playbookPayloadRejectedEvents.length, ...next);
  }
  return next.length;
}

function recordPlaybookDuplicateInflightEvent(): void {
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  const next = playbookDuplicateInflightEvents.filter((timestamp) => timestamp >= cutoff);
  next.push(now);
  if (next.length > 5000) {
    next.splice(0, next.length - 5000);
  }
  playbookDuplicateInflightEvents.splice(0, playbookDuplicateInflightEvents.length, ...next);
}

function getPlaybookDuplicateInflightEventCount1h(): number {
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  const next = playbookDuplicateInflightEvents.filter((timestamp) => timestamp >= cutoff);
  if (next.length !== playbookDuplicateInflightEvents.length) {
    playbookDuplicateInflightEvents.splice(0, playbookDuplicateInflightEvents.length, ...next);
  }
  return next.length;
}

function recordPlaybookFailClosedBlockedEvent(): void {
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  const next = playbookFailClosedBlockedEvents.filter((timestamp) => timestamp >= cutoff);
  next.push(now);
  if (next.length > 5000) {
    next.splice(0, next.length - 5000);
  }
  playbookFailClosedBlockedEvents.splice(0, playbookFailClosedBlockedEvents.length, ...next);
}

function getPlaybookFailClosedBlockedEventCount1h(): number {
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  const next = playbookFailClosedBlockedEvents.filter((timestamp) => timestamp >= cutoff);
  if (next.length !== playbookFailClosedBlockedEvents.length) {
    playbookFailClosedBlockedEvents.splice(0, playbookFailClosedBlockedEvents.length, ...next);
  }
  return next.length;
}

function recordPlaybookGovernanceErrorEvent(): void {
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  const next = playbookGovernanceErrorEvents.filter((timestamp) => timestamp >= cutoff);
  next.push(now);
  if (next.length > 5000) {
    next.splice(0, next.length - 5000);
  }
  playbookGovernanceErrorEvents.splice(0, playbookGovernanceErrorEvents.length, ...next);
}

function getPlaybookGovernanceErrorEventCount1h(): number {
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  const next = playbookGovernanceErrorEvents.filter((timestamp) => timestamp >= cutoff);
  if (next.length !== playbookGovernanceErrorEvents.length) {
    playbookGovernanceErrorEvents.splice(0, playbookGovernanceErrorEvents.length, ...next);
  }
  return next.length;
}

function logStructured(
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, unknown>,
): void {
  const payload = {
    level,
    event,
    ts: new Date().toISOString(),
    service: 'api',
    ...fields,
  };
  // Keep output line-oriented JSON for easy ingestion by log forwarders.
  console[level](JSON.stringify(payload));
}

async function emitErrorTelemetry(fields: Record<string, unknown>): Promise<void> {
  const webhook = process.env.ERROR_TELEMETRY_WEBHOOK_URL?.trim();
  if (!webhook) {
    return;
  }
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        service: 'api',
        ts: new Date().toISOString(),
        ...fields,
      }),
    });
  } catch {
    // Do not fail request flow due to telemetry transport errors.
  }
}

const contactIntakeSchema = z
  .object({
    firstName: z.string().trim().optional(),
    lastName: z.string().trim().optional(),
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
  })
  .strict();

const priceMatchAttachmentSchema = z
  .object({
    provider: z.enum(['S3', 'URL']).optional(),
    bucket: z.string().trim().optional(),
    objectKey: z.string().trim().optional(),
    url: z.string().trim().optional(),
    fileName: z.string().trim().optional(),
    mimeType: z.string().trim().optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    checksumSha256: z.string().trim().optional(),
    key: z.string().trim().optional(),
  })
  .strict();

const priceMatchAttributionSchema = z
  .object({
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
  })
  .strict();

const priceMatchIntakeSchema = z
  .object({
    lead: z
      .object({
        name: z.string().trim().optional(),
        phone: z.string().trim().optional(),
        email: z.string().trim().optional(),
        address: z.string().trim().optional(),
        serviceType: z.string().trim().optional(),
      })
      .strict(),
    intakeType: z.literal('PRICE_MATCH'),
    competitor: z
      .object({
        name: z.string().trim().min(1),
        priceCents: z.number().int().nonnegative().optional(),
        notes: z.string().trim().optional(),
      })
      .strict(),
    attachment: priceMatchAttachmentSchema.nullable(),
    attribution: priceMatchAttributionSchema.optional(),
    source: z.string().trim().default('website_price_match'),
  })
  .strict();

const mobileSyncPushSchema = z
  .object({
    deviceId: z
      .string()
      .trim()
      .regex(MOBILE_DEVICE_ID_PATTERN),
    actions: z
      .array(
        z
          .object({
            clientActionId: z.string().trim().uuid(),
            toolName: z
              .string()
              .trim()
              .min(1)
              .max(256)
              .regex(MOBILE_TOOL_NAME_PATTERN),
            payload: z.record(z.unknown()).default({}),
            reason: z.string().trim().max(512).optional(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();

const mobileSyncPullSchema = z
  .object({
    deviceId: z
      .string()
      .trim()
      .regex(MOBILE_DEVICE_ID_PATTERN),
    cursors: z
      .object({
        auditCursor: z.string().trim().optional(),
        outboxCursor: z.string().trim().optional(),
      })
      .optional(),
  })
  .strict();

const mobilePinLoginSchema = z
  .object({
    orgSlug: z.string().trim().regex(MOBILE_ORG_SLUG_PATTERN),
    identifier: z.string().trim().min(1),
    pin: z.string().trim().regex(/^\d{4,6}$/),
    deviceId: z
      .string()
      .trim()
      .regex(MOBILE_DEVICE_ID_PATTERN),
    deviceName: z.string().trim().optional(),
  })
  .strict();

const mobileTokenRefreshSchema = z
  .object({
    refreshToken: z.string().trim().min(1).max(MOBILE_BEARER_TOKEN_MAX_LENGTH),
    deviceId: z
      .string()
      .trim()
      .regex(MOBILE_DEVICE_ID_PATTERN),
  })
  .strict();

const mobilePinSetSchema = z
  .object({
    newPin: z.string().trim().regex(/^\d{4,6}$/),
    reason: z.string().trim().optional(),
  })
  .strict();

const mobilePinResetSchema = z
  .object({
    temporaryPin: z.string().trim().regex(/^\d{4,6}$/).optional(),
    reason: z.string().trim().optional(),
  })
  .strict();

function zodIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

function mobileDeviceMismatchResponse(args: {
  tokenDeviceId: string;
  requestDeviceId: string;
}) {
  return {
    error: {
      code: 'MOBILE_SYNC_DEVICE_MISMATCH',
      message: 'mobile access token is bound to a different deviceId',
      details: {
        tokenDeviceId: args.tokenDeviceId,
        requestDeviceId: args.requestDeviceId,
      },
    },
  };
}

function mobileSyncEndpointErrorResponse(args: {
  status: number;
  message: string;
  defaultCode: 'MOBILE_SYNC_PUSH_ERROR' | 'MOBILE_SYNC_PULL_ERROR';
}) {
  const normalizedMessage = args.message.trim();
  let code: string = args.defaultCode;
  let recoverable = args.status >= 500;

  if (normalizedMessage === 'Missing mobile access token') {
    code = 'MOBILE_AUTH_REQUIRED';
    recoverable = true;
  } else if (normalizedMessage === 'Invalid or expired mobile access token') {
    code = 'MOBILE_AUTH_INVALID_TOKEN';
    recoverable = true;
  } else if (normalizedMessage === 'Mobile PIN state changed; sign in again') {
    code = 'MOBILE_AUTH_PIN_STATE_CHANGED';
    recoverable = true;
  } else if (normalizedMessage === 'Mobile user session no longer valid') {
    code = 'MOBILE_AUTH_SESSION_INVALID';
    recoverable = false;
  } else if (normalizedMessage.includes('missing required permissions (mobile:sync)')) {
    code = 'MOBILE_SYNC_FORBIDDEN';
    recoverable = false;
  }

  return {
    error: {
      code,
      message: normalizedMessage || 'Unknown mobile sync error',
      recoverable,
    },
  };
}

function parsePositiveIntValue(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

function getSystemHealthRequestTimeoutMs(): number {
  const timeoutMs = parsePositiveIntValue(
    process.env.SYSTEM_HEALTH_REQUEST_TIMEOUT_MS,
    8_000,
  );
  return Math.min(timeoutMs, 120_000);
}

function getRateLimitRetryAfterSeconds(windowEnvKey: string, fallbackWindowMs: number): number {
  const windowMs = parsePositiveIntValue(process.env[windowEnvKey], fallbackWindowMs);
  return Math.max(1, Math.ceil(windowMs / 1000));
}

function applyRetryAfterHeader(
  res: Response,
  status: number,
  retryAfterSeconds: unknown,
): void {
  if (status !== 429) {
    return;
  }
  if (typeof retryAfterSeconds !== 'number' || !Number.isFinite(retryAfterSeconds)) {
    return;
  }
  const normalized = Math.max(1, Math.floor(retryAfterSeconds));
  res.setHeader('Retry-After', String(normalized));
}

function getMobileSyncPayloadLimits(): {
  maxActionPayloadBytes: number;
  maxBatchPayloadBytes: number;
  maxActionsPerPush: number;
  maxActionPayloadDepth: number;
  maxActionPayloadKeys: number;
} {
  const maxActionsPerPush = parsePositiveIntValue(
    process.env.MOBILE_SYNC_MAX_ACTIONS_PER_PUSH,
    200,
  );
  return {
    maxActionPayloadBytes: parsePositiveIntValue(
      process.env.MOBILE_SYNC_ACTION_MAX_PAYLOAD_BYTES,
      64 * 1024,
    ),
    maxBatchPayloadBytes: parsePositiveIntValue(
      process.env.MOBILE_SYNC_BATCH_MAX_PAYLOAD_BYTES,
      512 * 1024,
    ),
    maxActionsPerPush: Math.min(maxActionsPerPush, 200),
    maxActionPayloadDepth: Math.min(
      parsePositiveIntValue(process.env.MOBILE_SYNC_ACTION_MAX_PAYLOAD_DEPTH, 20),
      200,
    ),
    maxActionPayloadKeys: Math.min(
      parsePositiveIntValue(process.env.MOBILE_SYNC_ACTION_MAX_PAYLOAD_KEYS, 5000),
      50000,
    ),
  };
}

function getMobileSyncPullLimits(): {
  maxAuditEvents: number;
  maxOutboxEvents: number;
  maxTimeEditRequests: number;
  maxTodayAppointments: number;
  maxTodayTimeEntries: number;
  maxDispatchAppointments: number;
} {
  return {
    maxAuditEvents: parsePositiveIntValue(
      process.env.MOBILE_SYNC_PULL_MAX_AUDIT_EVENTS,
      500,
    ),
    maxOutboxEvents: parsePositiveIntValue(
      process.env.MOBILE_SYNC_PULL_MAX_OUTBOX_EVENTS,
      500,
    ),
    maxTimeEditRequests: parsePositiveIntValue(
      process.env.MOBILE_SYNC_PULL_MAX_TIME_EDIT_REQUESTS,
      50,
    ),
    maxTodayAppointments: parsePositiveIntValue(
      process.env.MOBILE_SYNC_PULL_MAX_TODAY_APPOINTMENTS,
      120,
    ),
    maxTodayTimeEntries: parsePositiveIntValue(
      process.env.MOBILE_SYNC_PULL_MAX_TODAY_TIME_ENTRIES,
      40,
    ),
    maxDispatchAppointments: parsePositiveIntValue(
      process.env.MOBILE_SYNC_PULL_MAX_DISPATCH_APPOINTMENTS,
      300,
    ),
  };
}

function getMobileSyncCursorLimits(): {
  maxCursorBytes: number;
} {
  return {
    maxCursorBytes: parsePositiveIntValue(
      process.env.MOBILE_SYNC_CURSOR_MAX_BYTES,
      2048,
    ),
  };
}

function getMobileSyncRuntimeLimits(): {
  maxActionExecutionMs: number;
  pendingClaimStaleSeconds: number;
} {
  return {
    maxActionExecutionMs: parsePositiveIntValue(
      process.env.MOBILE_SYNC_ACTION_TIMEOUT_MS,
      15_000,
    ),
    pendingClaimStaleSeconds: parsePositiveIntValue(
      process.env.MOBILE_SYNC_PENDING_CLAIM_STALE_SECONDS,
      90,
    ),
  };
}

const MOBILE_SYNC_PENDING_CLAIM_PREFIX = '__IN_PROGRESS__';

function buildPendingClaimMarker(now: Date = new Date()): string {
  return `${MOBILE_SYNC_PENDING_CLAIM_PREFIX}:${now.toISOString()}:${randomUUID()}`;
}

function parsePendingClaimMarkerStartedAt(marker: string): Date | null {
  const prefix = `${MOBILE_SYNC_PENDING_CLAIM_PREFIX}:`;
  if (!marker.startsWith(prefix)) {
    return null;
  }
  const remainder = marker.slice(prefix.length);
  const tailSeparatorIndex = remainder.lastIndexOf(':');
  if (tailSeparatorIndex <= 0) {
    return null;
  }
  const startedAtIso = remainder.slice(0, tailSeparatorIndex);
  const startedAt = new Date(startedAtIso);
  if (Number.isNaN(startedAt.getTime())) {
    return null;
  }
  return startedAt;
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

function jsonUtf8ByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

type JsonShapeViolation = {
  reason: 'MAX_DEPTH_EXCEEDED' | 'MAX_KEYS_EXCEEDED';
  actualDepth: number;
  actualKeys: number;
};

function inspectJsonShape(args: {
  value: unknown;
  maxDepth: number;
  maxKeys: number;
}): JsonShapeViolation | null {
  const maxDepth = Math.max(1, Math.floor(args.maxDepth));
  const maxKeys = Math.max(1, Math.floor(args.maxKeys));
  const stack: Array<{ value: unknown; depth: number }> = [{ value: args.value, depth: 1 }];
  let actualDepth = 1;
  let actualKeys = 0;

  while (stack.length > 0) {
    const current = stack.pop() as { value: unknown; depth: number };
    actualDepth = Math.max(actualDepth, current.depth);
    if (current.depth > maxDepth) {
      return {
        reason: 'MAX_DEPTH_EXCEEDED',
        actualDepth: current.depth,
        actualKeys,
      };
    }

    if (Array.isArray(current.value)) {
      actualKeys += current.value.length;
      if (actualKeys > maxKeys) {
        return {
          reason: 'MAX_KEYS_EXCEEDED',
          actualDepth,
          actualKeys,
        };
      }
      for (const entry of current.value) {
        if (entry !== null && typeof entry === 'object') {
          stack.push({
            value: entry,
            depth: current.depth + 1,
          });
        }
      }
      continue;
    }

    if (current.value !== null && typeof current.value === 'object') {
      const keys = Object.keys(current.value as Record<string, unknown>);
      actualKeys += keys.length;
      if (actualKeys > maxKeys) {
        return {
          reason: 'MAX_KEYS_EXCEEDED',
          actualDepth,
          actualKeys,
        };
      }
      for (const key of keys) {
        const entry = (current.value as Record<string, unknown>)[key];
        if (entry !== null && typeof entry === 'object') {
          stack.push({
            value: entry,
            depth: current.depth + 1,
          });
        }
      }
    }
  }

  return null;
}

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort((a, b) => a.localeCompare(b));
  const rows = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${rows.join(',')}}`;
}

const mediaUploadSessionInitiateSchema = z
  .object({
    sessionKey: z.string().trim().min(8).max(128).optional(),
    ownerType: z.enum(['QUOTE', 'JOB']),
    ownerId: z.string().trim().min(1),
    tag: z
      .enum(['BEFORE', 'AFTER', 'EQUIPMENT_PLATE', 'RECEIPT', 'PROBLEM', 'INSTALL', 'OTHER'])
      .optional(),
    caption: z.string().trim().optional(),
    fileName: z.string().trim().min(1),
    mimeType: z.string().trim().min(1),
    sizeBytes: z.number().int().positive().optional(),
    checksumSha256: z.string().trim().min(1).optional(),
  })
  .strict();

function isJobberCsvType(value: unknown): value is JobberCsvType {
  return typeof value === 'string' && (JOBBER_CSV_TYPES as readonly string[]).includes(value);
}

function parseDryRunOption(rawOptions: unknown): boolean {
  if (typeof rawOptions === 'string' && rawOptions.trim().length > 0) {
    try {
      const parsed = JSON.parse(rawOptions) as { dryRun?: unknown };
      if (typeof parsed?.dryRun === 'boolean') {
        return parsed.dryRun;
      }
    } catch {
      return false;
    }
    return false;
  }

  if (
    rawOptions &&
    typeof rawOptions === 'object' &&
    !Array.isArray(rawOptions) &&
    typeof (rawOptions as { dryRun?: unknown }).dryRun === 'boolean'
  ) {
    return Boolean((rawOptions as { dryRun?: unknown }).dryRun);
  }

  return false;
}

const equipmentCatalogMappingSchema = z
  .object({
    skuColumn: z.string().trim().optional(),
    manufacturerColumn: z.string().trim().optional(),
    systemTypeColumn: z.string().trim().optional(),
    textColumns: z.array(z.string().trim().min(1)).max(40).optional(),
  })
  .strict();

function parseEquipmentCatalogMapping(
  rawMapping: unknown,
): Record<string, unknown> | undefined {
  if (rawMapping === undefined || rawMapping === null || rawMapping === '') {
    return undefined;
  }

  if (typeof rawMapping === 'string') {
    try {
      const parsed = JSON.parse(rawMapping);
      const mapping = equipmentCatalogMappingSchema.parse(parsed);
      return {
        ...mapping,
        textColumns: mapping.textColumns?.map((value) => value.trim()),
      };
    } catch {
      throw new Error('Invalid mapping JSON for equipment catalog upload');
    }
  }

  if (typeof rawMapping === 'object' && !Array.isArray(rawMapping)) {
    const mapping = equipmentCatalogMappingSchema.parse(rawMapping);
    return {
      ...mapping,
      textColumns: mapping.textColumns?.map((value) => value.trim()),
    };
  }

  return undefined;
}

function parseIngestTokensFromEnv(): Set<string> {
  const raw = process.env.MBS_INGEST_TOKENS ?? '';
  const tokens = raw
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  return new Set(tokens);
}

type SecretHealthState = 'OK' | 'MISSING' | 'INSECURE';

function secretsMatchConstantTime(actual: string, provided: string): boolean {
  const actualBuffer = Buffer.from(actual, 'utf8');
  const providedBuffer = Buffer.from(provided, 'utf8');
  const length = Math.max(actualBuffer.length, providedBuffer.length, 1);
  const actualPadded = Buffer.alloc(length);
  const providedPadded = Buffer.alloc(length);
  actualBuffer.copy(actualPadded);
  providedBuffer.copy(providedPadded);
  const equal = timingSafeEqual(actualPadded, providedPadded);
  return equal && actualBuffer.length === providedBuffer.length;
}

function findMatchingSecret(
  provided: string,
  candidates: Iterable<string>,
): string | null {
  let matched: string | null = null;
  for (const candidate of candidates) {
    if (secretsMatchConstantTime(candidate, provided)) {
      matched = candidate;
    }
  }
  return matched;
}

function evaluateIngestTokensHealth(): SecretHealthState {
  const tokens = [...parseIngestTokensFromEnv()];
  if (tokens.length === 0) {
    return 'MISSING';
  }
  if (tokens.some((token) => isOperationalSecretInsecure(token))) {
    return 'INSECURE';
  }
  return 'OK';
}

function evaluateCallWebhookSecretHealth(): SecretHealthState {
  const secret = (process.env.CALL_WEBHOOK_SECRET ?? '').trim();
  if (!secret) {
    return 'MISSING';
  }
  if (isOperationalSecretInsecure(secret)) {
    return 'INSECURE';
  }
  return 'OK';
}

function evaluateIngestIpHashSaltHealth(): SecretHealthState {
  const salt = (process.env.MBS_IP_HASH_SALT ?? '').trim();
  if (!salt) {
    return 'MISSING';
  }
  if (salt === DEFAULT_INGEST_IP_HASH_SALT || isOperationalSecretInsecure(salt)) {
    return 'INSECURE';
  }
  return 'OK';
}

function getIngestSourceIp(req: Request): string {
  const forwarded = req.header('x-forwarded-for');
  if (forwarded && forwarded.trim().length > 0) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) {
      return first;
    }
  }
  return req.ip || '0.0.0.0';
}

function hashSourceIp(ip: string): string {
  const salt = process.env.MBS_IP_HASH_SALT ?? DEFAULT_INGEST_IP_HASH_SALT;
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex');
}

function applyIngestRateLimit(token: string, ip: string): boolean {
  const windowMs = Number.parseInt(
    process.env.MBS_INGEST_RATE_LIMIT_WINDOW_MS ?? '60000',
    10,
  );
  const limit = Number.parseInt(
    process.env.MBS_INGEST_RATE_LIMIT_MAX ?? '60',
    10,
  );
  const key = `${token}:${ip}`;
  return applyWindowRateLimit({
    store: ingestRateWindowByKey,
    key,
    windowMs,
    limit,
  });
}

function applyMobileLoginRateLimit(identifier: string, ip: string): boolean {
  const windowMs = Number.parseInt(
    process.env.MOBILE_PIN_RATE_LIMIT_WINDOW_MS ?? '300000',
    10,
  );
  const limit = Number.parseInt(
    process.env.MOBILE_PIN_RATE_LIMIT_MAX ?? '20',
    10,
  );
  const key = `${identifier.toLowerCase().trim()}:${ip}`;
  return applyWindowRateLimit({
    store: mobileAuthRateWindowByKey,
    key,
    windowMs,
    limit,
  });
}

function applyMobileRefreshRateLimit(deviceId: string, ip: string): boolean {
  const windowMs = Number.parseInt(
    process.env.MOBILE_REFRESH_RATE_LIMIT_WINDOW_MS ?? '300000',
    10,
  );
  const limit = Number.parseInt(
    process.env.MOBILE_REFRESH_RATE_LIMIT_MAX ?? '60',
    10,
  );
  const key = `${deviceId}:${ip}`;
  return applyWindowRateLimit({
    store: mobileRefreshRateWindowByKey,
    key,
    windowMs,
    limit,
  });
}

function applyMobileSyncPushRateLimit(args: {
  userId: string;
  deviceId: string;
  ip: string;
}): boolean {
  const windowMs = Number.parseInt(
    process.env.MOBILE_SYNC_PUSH_RATE_LIMIT_WINDOW_MS ?? '60000',
    10,
  );
  const limit = Number.parseInt(
    process.env.MOBILE_SYNC_PUSH_RATE_LIMIT_MAX ?? '120',
    10,
  );
  const key = `${args.userId}:${args.deviceId}:${args.ip}`;
  return applyWindowRateLimit({
    store: mobileSyncPushRateWindowByKey,
    key,
    windowMs,
    limit,
  });
}

function applyMobileSyncPullRateLimit(args: {
  userId: string;
  deviceId: string;
  ip: string;
}): boolean {
  const windowMs = Number.parseInt(
    process.env.MOBILE_SYNC_PULL_RATE_LIMIT_WINDOW_MS ?? '60000',
    10,
  );
  const limit = Number.parseInt(
    process.env.MOBILE_SYNC_PULL_RATE_LIMIT_MAX ?? '240',
    10,
  );
  const key = `${args.userId}:${args.deviceId}:${args.ip}`;
  return applyWindowRateLimit({
    store: mobileSyncPullRateWindowByKey,
    key,
    windowMs,
    limit,
  });
}

function applyCallWebhookRateLimit(ip: string): boolean {
  const windowMs = Number.parseInt(
    process.env.CALL_WEBHOOK_RATE_LIMIT_WINDOW_MS ?? '60000',
    10,
  );
  const limit = Number.parseInt(
    process.env.CALL_WEBHOOK_RATE_LIMIT_MAX ?? '120',
    10,
  );
  return applyWindowRateLimit({
    store: callWebhookRateWindowByKey,
    key: ip,
    windowMs,
    limit,
  });
}

function applyAgentPlaybookRateLimit(args: {
  orgId: string;
  actorUserId?: string;
  ip: string;
}): boolean {
  const windowMs = Number.parseInt(
    process.env.AGENT_PLAYBOOK_RATE_LIMIT_WINDOW_MS ?? '60000',
    10,
  );
  const limit = Number.parseInt(
    process.env.AGENT_PLAYBOOK_RATE_LIMIT_MAX ?? '120',
    10,
  );
  const key = `${args.orgId}:${args.actorUserId ?? 'unknown'}:${args.ip}`;
  return applyWindowRateLimit({
    store: agentPlaybookRateWindowByKey,
    key,
    windowMs,
    limit,
  });
}

function authenticateIntakeRequest(req: Request): IngestAuthContext {
  const tokens = parseIngestTokensFromEnv();
  if (tokens.size === 0) {
    const error = new Error('MBS intake tokens not configured');
    (error as Error & { status?: number }).status = 503;
    throw error;
  }

  const authorization = req.header('authorization') ?? '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  const matchedToken = token ? findMatchingSecret(token, tokens) : null;

  if (!token || !matchedToken) {
    const error = new Error('Unauthorized ingest token');
    (error as Error & { status?: number }).status = 401;
    throw error;
  }

  const sourceIp = getIngestSourceIp(req);
  if (!applyIngestRateLimit(matchedToken, sourceIp)) {
    recordRateLimitEvent('ingest');
    const error = new Error('Rate limit exceeded for ingest token');
    const rateLimitedError = error as Error & {
      status?: number;
      retryAfterSeconds?: number;
    };
    rateLimitedError.status = 429;
    rateLimitedError.retryAfterSeconds = getRateLimitRetryAfterSeconds(
      'MBS_INGEST_RATE_LIMIT_WINDOW_MS',
      60000,
    );
    throw error;
  }

  return {
    token: matchedToken,
    sourceIpHash: hashSourceIp(sourceIp),
  };
}

function hasAttributionData(input: {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  fbclid?: string;
  landingUrl?: string;
  referrerUrl?: string;
  visitorId?: string;
}): boolean {
  return Boolean(
    input.utmSource ||
      input.utmMedium ||
      input.utmCampaign ||
      input.utmContent ||
      input.utmTerm ||
      input.gclid ||
      input.gbraid ||
      input.wbraid ||
      input.fbclid ||
      input.landingUrl ||
      input.referrerUrl ||
      input.visitorId,
  );
}

function splitFullName(value: string | undefined): {
  firstName?: string;
  lastName?: string;
} {
  const normalized = (value ?? '').trim();
  if (!normalized) {
    return {};
  }
  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return { firstName: parts[0] };
  }
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' '),
  };
}

function getExecutionOutputObject(
  output: unknown,
): Record<string, unknown> {
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    return output as Record<string, unknown>;
  }
  return {};
}

function ensureToolExecuted(
  result: ToolExecutionResponse,
  toolName: string,
): asserts result is Extract<ToolExecutionResponse, { status: 'EXECUTED' }> {
  if (result.status === 'EXECUTED') {
    return;
  }
  const detail =
    'reason' in result
      ? result.reason
      : 'error' in result
        ? result.error
        : 'No details';
  throw new Error(
    `${toolName} returned ${result.status}: ${detail}`,
  );
}

type LeadSlaStatus = 'OK' | 'DUE_SOON' | 'OVERDUE';

const LEAD_PIPELINE_STAGES: LeadStage[] = [
  LeadStage.NEW,
  LeadStage.CONTACTED,
  LeadStage.QUALIFIED,
  LeadStage.APPOINTMENT_SET,
  LeadStage.ESTIMATE_SENT,
  LeadStage.WON,
  LeadStage.LOST,
  LeadStage.NURTURE,
];

function normalizeLeadStage(value: unknown): LeadStage {
  const normalized = String(value ?? '')
    .trim()
    .toUpperCase();
  if (normalized in LeadStage) {
    return normalized as LeadStage;
  }
  return LeadStage.NEW;
}

function evaluateLeadSlaStatus(
  nextTouchDueAt: Date | null | undefined,
  dueSoonMinutes: number,
  now: Date = new Date(),
): {
  slaStatus: LeadSlaStatus;
  minutesUntilDue: number;
  escalationLevel: 'NONE' | 'DISPATCHER' | 'MANAGER';
} {
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

  if (minutesUntilDue <= Math.max(1, dueSoonMinutes)) {
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

function executionStatusCode(result: ToolExecutionResponse, executedCode = 200): number {
  if (result.status === 'EXECUTED') {
    return executedCode;
  }
  if (result.status === 'BLOCKED') {
    return 403;
  }
  return 202;
}

function countAcceptedCsvRows(content: string): number {
  const normalized = content.replace(/^\uFEFF/, '');
  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length <= 1) {
    return 0;
  }
  return lines.length - 1;
}

function resolveMediaSessionKey(req: Request): string {
  const headerValue = req.header('x-upload-session-key');
  if (typeof headerValue === 'string' && headerValue.trim().length >= 8) {
    return headerValue.trim().slice(0, 128);
  }
  const bodyValue = req.body?.sessionKey;
  if (typeof bodyValue === 'string' && bodyValue.trim().length >= 8) {
    return bodyValue.trim().slice(0, 128);
  }
  return randomUUID();
}

function parseDateOnlyInput(value: unknown, fallback: Date = new Date()): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return value.trim();
  }
  const d = fallback;
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseCursorDateInput(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toCursorValue(date: Date): string {
  return date.toISOString();
}

type MobileEventCursor = {
  ts: Date;
  ids: string[];
};

function parseMobileEventCursor(value: unknown): MobileEventCursor | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const directDate = parseCursorDateInput(trimmed);
  if (directDate) {
    return { ts: directDate, ids: [] };
  }

  try {
    const parsed = JSON.parse(trimmed) as { ts?: unknown; ids?: unknown };
    const ts = parseCursorDateInput(parsed.ts);
    if (!ts) {
      return null;
    }
    const ids = Array.isArray(parsed.ids)
      ? parsed.ids
          .filter((row): row is string => typeof row === 'string' && row.trim().length > 0)
          .map((row) => row.trim())
      : [];
    return {
      ts,
      ids: [...new Set(ids)].sort((a, b) => a.localeCompare(b)),
    };
  } catch {
    return null;
  }
}

function sanitizeMobileEventCursor(
  cursor: MobileEventCursor | null,
  now: Date,
  maxFutureSkewSeconds: number,
): MobileEventCursor | null {
  if (!cursor) {
    return null;
  }
  const safeSkewSeconds = Number.isFinite(maxFutureSkewSeconds) && maxFutureSkewSeconds >= 0
    ? Math.floor(maxFutureSkewSeconds)
    : 0;
  const maxAllowedTs = now.getTime() + safeSkewSeconds * 1000;
  if (cursor.ts.getTime() > maxAllowedTs) {
    return null;
  }
  return cursor;
}

function encodeMobileEventCursor(cursor: MobileEventCursor): string {
  return JSON.stringify({
    ts: cursor.ts.toISOString(),
    ids: [...new Set(cursor.ids)]
      .filter((row) => row.trim().length > 0)
      .sort((a, b) => a.localeCompare(b)),
  });
}

function mergeCursorIds(
  previousCursor: MobileEventCursor,
  currentTimestampIds: string[],
  currentTimestamp: Date,
): string[] {
  const merged = new Set(currentTimestampIds);
  if (previousCursor.ts.getTime() === currentTimestamp.getTime()) {
    for (const id of previousCursor.ids) {
      merged.add(id);
    }
  }
  return [...merged].sort((a, b) => a.localeCompare(b));
}

type MobileAccessJwtPayload = {
  type: 'mobile_access';
  sub: string;
  orgId: string;
  orgSlug: string;
  deviceId: string;
  pinVersion: number;
};

type MobileRefreshJwtPayload = {
  type: 'mobile_refresh';
  sub: string;
  orgId: string;
  orgSlug: string;
  deviceId: string;
  pinVersion: number;
};

const DEFAULT_JWT_SECRET = 'change-me';
const DEFAULT_INGEST_IP_HASH_SALT = 'mbs-intake-dev-salt';
const JWT_SECRET_INSECURE_VALUES = new Set([
  '',
  DEFAULT_JWT_SECRET,
  'default',
  'changeme',
  'secret',
  'password',
]);
const OPERATIONAL_SECRET_INSECURE_VALUES = new Set([
  '',
  DEFAULT_JWT_SECRET,
  'default',
  'changeme',
  'secret',
  'password',
  'token',
  'test',
  'dev',
  'development',
]);

function isJwtSecretInsecure(secret: string): boolean {
  const normalized = secret.trim().toLowerCase();
  if (JWT_SECRET_INSECURE_VALUES.has(normalized)) {
    return true;
  }
  return secret.trim().length < 32;
}

function isOperationalSecretInsecure(secret: string): boolean {
  const normalized = secret.trim().toLowerCase();
  if (OPERATIONAL_SECRET_INSECURE_VALUES.has(normalized)) {
    return true;
  }
  return secret.trim().length < 24;
}

function deriveMobilePinVersion(value: unknown): number {
  if (value instanceof Date && Number.isFinite(value.getTime()) && value.getTime() > 0) {
    return value.getTime();
  }
  if (typeof value === 'string') {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp) && timestamp > 0) {
      return timestamp;
    }
  }
  return 0;
}

function getJwtSecret(): string {
  return process.env.JWT_SECRET?.trim() || DEFAULT_JWT_SECRET;
}

function parseBearerToken(req: Request): string | null {
  const authorization = req.header('authorization') ?? '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  if (!token || token.length === 0 || token.length > MOBILE_BEARER_TOKEN_MAX_LENGTH) {
    return null;
  }
  return token;
}

function issueMobileAccessToken(payload: MobileAccessJwtPayload): {
  token: string;
  expiresAt: string;
} {
  const ttl = (process.env.MOBILE_ACCESS_TOKEN_TTL ?? '12h') as jwt.SignOptions['expiresIn'];
  const token = jwt.sign(payload, getJwtSecret(), {
    algorithm: 'HS256',
    expiresIn: ttl,
    issuer: MOBILE_JWT_ISSUER,
    audience: MOBILE_JWT_ACCESS_AUDIENCE,
  });
  const decoded = jwt.decode(token) as { exp?: number } | null;
  const expiresAt = decoded?.exp
    ? new Date(decoded.exp * 1000).toISOString()
    : new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  return { token, expiresAt };
}

function issueMobileRefreshToken(payload: {
  sub: string;
  orgId: string;
  orgSlug: string;
  deviceId: string;
  pinVersion: number;
}): string {
  const ttl = (process.env.MOBILE_REFRESH_TOKEN_TTL ?? '30d') as jwt.SignOptions['expiresIn'];
  return jwt.sign(
    {
      type: 'mobile_refresh',
      sub: payload.sub,
      orgId: payload.orgId,
      orgSlug: payload.orgSlug,
      deviceId: payload.deviceId,
      pinVersion: payload.pinVersion,
    },
    getJwtSecret(),
    {
      algorithm: 'HS256',
      expiresIn: ttl,
      issuer: MOBILE_JWT_ISSUER,
      audience: MOBILE_JWT_REFRESH_AUDIENCE,
    },
  );
}

function verifyMobileAccessToken(token: string): MobileAccessJwtPayload {
  const decoded = jwt.verify(token, getJwtSecret(), {
    algorithms: ['HS256'],
    issuer: MOBILE_JWT_ISSUER,
    audience: MOBILE_JWT_ACCESS_AUDIENCE,
  }) as jwt.JwtPayload;
  const sub = typeof decoded.sub === 'string' ? decoded.sub.trim() : '';
  const orgId = typeof decoded.orgId === 'string' ? decoded.orgId.trim() : '';
  const orgSlug = typeof decoded.orgSlug === 'string' ? decoded.orgSlug.trim() : '';
  const deviceId = typeof decoded.deviceId === 'string' ? decoded.deviceId.trim() : '';
  const pinVersion = typeof decoded.pinVersion === 'number' ? decoded.pinVersion : NaN;
  if (
    decoded?.type !== 'mobile_access' ||
    sub.length === 0 ||
    sub.length > 128 ||
    orgId.length === 0 ||
    orgId.length > 128 ||
    !MOBILE_ORG_SLUG_PATTERN.test(orgSlug) ||
    !MOBILE_DEVICE_ID_PATTERN.test(deviceId) ||
    !Number.isFinite(pinVersion) ||
    pinVersion < 0
  ) {
    throw new Error('Invalid mobile access token');
  }

  return {
    type: 'mobile_access',
    sub,
    orgId,
    orgSlug,
    deviceId,
    pinVersion,
  };
}

function verifyMobileRefreshToken(token: string): MobileRefreshJwtPayload {
  const decoded = jwt.verify(token, getJwtSecret(), {
    algorithms: ['HS256'],
    issuer: MOBILE_JWT_ISSUER,
    audience: MOBILE_JWT_REFRESH_AUDIENCE,
  }) as jwt.JwtPayload;
  const sub = typeof decoded.sub === 'string' ? decoded.sub.trim() : '';
  const orgId = typeof decoded.orgId === 'string' ? decoded.orgId.trim() : '';
  const orgSlug = typeof decoded.orgSlug === 'string' ? decoded.orgSlug.trim() : '';
  const deviceId = typeof decoded.deviceId === 'string' ? decoded.deviceId.trim() : '';
  const pinVersion = typeof decoded.pinVersion === 'number' ? decoded.pinVersion : NaN;
  if (
    decoded?.type !== 'mobile_refresh' ||
    sub.length === 0 ||
    sub.length > 128 ||
    orgId.length === 0 ||
    orgId.length > 128 ||
    !MOBILE_ORG_SLUG_PATTERN.test(orgSlug) ||
    !MOBILE_DEVICE_ID_PATTERN.test(deviceId) ||
    !Number.isFinite(pinVersion) ||
    pinVersion < 0
  ) {
    throw new Error('Invalid mobile refresh token');
  }

  return {
    type: 'mobile_refresh',
    sub,
    orgId,
    orgSlug,
    deviceId,
    pinVersion,
  };
}

async function requireMobileSession(req: Request): Promise<{
  orgId: string;
  orgSlug: string;
  deviceId: string;
  user: {
    id: string;
    email: string;
    name: string;
    actorType: ActorType;
  };
}> {
  const token = parseBearerToken(req);
  if (!token) {
    const error = new Error('Missing mobile access token');
    (error as Error & { status?: number }).status = 401;
    throw error;
  }

  let payload: MobileAccessJwtPayload;
  try {
    payload = verifyMobileAccessToken(token);
  } catch {
    const error = new Error('Invalid or expired mobile access token');
    (error as Error & { status?: number }).status = 401;
    throw error;
  }

  const user = await prisma.user.findFirst({
    where: {
      id: payload.sub,
      orgId: payload.orgId,
      isActive: true,
    },
    select: {
      id: true,
      orgId: true,
      email: true,
      name: true,
      actorType: true,
      mobilePinUpdatedAt: true,
      organization: {
        select: {
          slug: true,
        },
      },
      mobileClients: {
        where: {
          deviceId: payload.deviceId,
        },
        select: {
          id: true,
        },
        take: 1,
      },
    },
  });
  if (!user) {
    const error = new Error('Mobile user session no longer valid');
    (error as Error & { status?: number }).status = 401;
    throw error;
  }
  if (user.organization.slug !== payload.orgSlug || user.actorType !== ActorType.HUMAN) {
    const error = new Error('Invalid or expired mobile access token');
    (error as Error & { status?: number }).status = 401;
    throw error;
  }
  const currentPinVersion = deriveMobilePinVersion(user.mobilePinUpdatedAt);
  if (currentPinVersion !== payload.pinVersion) {
    const error = new Error('Mobile PIN state changed; sign in again');
    (error as Error & { status?: number }).status = 401;
    throw error;
  }
  if (!Array.isArray(user.mobileClients) || user.mobileClients.length === 0) {
    const error = new Error('Mobile user session no longer valid');
    (error as Error & { status?: number }).status = 401;
    throw error;
  }

  return {
    orgId: user.orgId,
    orgSlug: user.organization.slug,
    deviceId: payload.deviceId,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      actorType: user.actorType,
    },
  };
}

function toUtcDateOnly(dateString: string): Date {
  const match = dateString.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid date value: ${dateString}`);
  }
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

async function upsertMobileClient(args: {
  orgId: string;
  userId: string;
  deviceId: string;
  deviceName?: string | null;
}) {
  await prisma.mobileClient.upsert({
    where: {
      orgId_userId_deviceId: {
        orgId: args.orgId,
        userId: args.userId,
        deviceId: args.deviceId,
      },
    },
    update: {
      deviceName: args.deviceName ?? undefined,
      lastSeenAt: new Date(),
    },
    create: {
      orgId: args.orgId,
      userId: args.userId,
      deviceId: args.deviceId,
      deviceName: args.deviceName ?? null,
      lastSeenAt: new Date(),
    },
  });
}

type MobilePushActionResult = {
  clientActionId: string;
  status: 'APPLIED' | 'FAILED';
  output?: unknown;
  error?: string;
  errorCode?: string;
  recoverable?: boolean;
};

type PendingClientActionRecovery = {
  result: MobilePushActionResult;
  clientActionStatus: ClientActionStatus;
  resultJson: Prisma.InputJsonValue;
  error: string | null;
};

async function recoverPendingClientAction(args: {
  orgId: string;
  clientActionId: string;
}): Promise<PendingClientActionRecovery | null> {
  const execution = await prisma.toolExecution.findFirst({
    where: {
      orgId: args.orgId,
      clientActionId: args.clientActionId,
    },
    include: {
      approvalRequest: {
        select: {
          id: true,
          requiredApprovals: true,
        },
      },
    },
    orderBy: [{ createdAt: 'desc' }],
  });

  if (!execution) {
    return null;
  }

  if (execution.status === ExecutionStatus.EXECUTED) {
    const payload = {
      status: 'EXECUTED',
      executionId: execution.id,
      output: execution.outputPayload ?? null,
    };
    return {
      result: {
        clientActionId: args.clientActionId,
        status: 'APPLIED',
        output: payload,
      },
      clientActionStatus: ClientActionStatus.APPLIED,
      resultJson: payload as Prisma.InputJsonValue,
      error: null,
    };
  }

  if (execution.status === ExecutionStatus.QUEUED_APPROVAL) {
    const payload = {
      status: 'QUEUED_APPROVAL',
      executionId: execution.id,
      approvalRequestId: execution.approvalRequest?.id ?? null,
      requiredApprovals: execution.approvalRequest?.requiredApprovals ?? 1,
    };
    return {
      result: {
        clientActionId: args.clientActionId,
        status: 'APPLIED',
        output: payload,
      },
      clientActionStatus: ClientActionStatus.APPLIED,
      resultJson: payload as Prisma.InputJsonValue,
      error: null,
    };
  }

  const errorMessage =
    execution.status === ExecutionStatus.BLOCKED
      ? execution.blockedReason ?? 'Action blocked by governance'
      : execution.errorMessage ?? `Action execution ended with ${execution.status}`;
  const errorCode =
    execution.status === ExecutionStatus.BLOCKED
      ? 'TOOL_BLOCKED'
      : execution.status === ExecutionStatus.FAILED
        ? 'TOOL_FAILED'
        : 'TOOL_NOT_APPLIED';
  const failedPayload = {
    status: 'FAILED',
    executionId: execution.id,
    error: errorMessage,
    errorCode,
    recoverable: false,
  };

  return {
    result: {
      clientActionId: args.clientActionId,
      status: 'FAILED',
      error: errorMessage,
      errorCode,
      recoverable: false,
    },
    clientActionStatus: ClientActionStatus.FAILED,
    resultJson: failedPayload as Prisma.InputJsonValue,
    error: errorMessage,
  };
}

async function claimPendingClientAction(args: {
  id: string;
  existingError: string | null;
  staleAfterSeconds: number;
}): Promise<
  | { claimed: true; claimMarker: string }
  | { claimed: false; reason: 'IN_PROGRESS' }
> {
  const now = new Date();
  const currentError = args.existingError;
  if (currentError && currentError.startsWith(`${MOBILE_SYNC_PENDING_CLAIM_PREFIX}:`)) {
    const startedAt = parsePendingClaimMarkerStartedAt(currentError);
    if (startedAt) {
      const staleAfterMs = Math.max(1, args.staleAfterSeconds) * 1000;
      if (now.getTime() - startedAt.getTime() < staleAfterMs) {
        return {
          claimed: false,
          reason: 'IN_PROGRESS',
        };
      }
    } else {
      return {
        claimed: false,
        reason: 'IN_PROGRESS',
      };
    }
  }

  const claimMarker = buildPendingClaimMarker(now);
  const updated = await prisma.clientAction.updateMany({
    where: {
      id: args.id,
      status: ClientActionStatus.PENDING,
      ...(currentError === null ? { error: null } : { error: currentError }),
    },
    data: {
      error: claimMarker,
    },
  });
  if (updated.count === 1) {
    return {
      claimed: true,
      claimMarker,
    };
  }
  return {
    claimed: false,
    reason: 'IN_PROGRESS',
  };
}

async function buildDispatchDayReadModel(args: {
  orgId: string;
  dateKey: string;
  maxAppointments: number;
}) {
  const maxAppointments = Math.max(1, args.maxAppointments);
  const date = toUtcDateOnly(args.dateKey);
  const [settings, blocks, reservations, appointments] = await Promise.all([
    prisma.orgSchedulingSettings.findUnique({
      where: { orgId: args.orgId },
    }),
    prisma.timeBlockTemplate.findMany({
      where: { orgId: args.orgId, active: true },
      orderBy: { startTime: 'asc' },
    }),
    prisma.appointmentReservation.findMany({
      where: { orgId: args.orgId, date },
    }),
    prisma.appointment.findMany({
      where: {
        orgId: args.orgId,
        date,
        status: { not: 'CANCELED' },
      },
      include: {
        customer: {
          select: {
            id: true,
            fullName: true,
            phone: true,
            email: true,
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
        quote: {
          select: {
            id: true,
            kind: true,
            status: true,
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
      take: maxAppointments + 1,
    }),
  ]);
  const appointmentsTruncated = appointments.length > maxAppointments;
  const cappedAppointments = appointmentsTruncated
    ? appointments.slice(0, maxAppointments)
    : appointments;

  const fallbackServiceCapacity =
    settings?.throttleServiceEnabled
      ? settings.throttleServiceCapacityPerBlock
      : settings?.defaultServiceCapacityPerBlock ?? 2;
  const fallbackInstallCapacity =
    settings?.throttleInstallEnabled
      ? settings.throttleInstallCapacityPerBlock
      : settings?.defaultInstallCapacityPerBlock ?? 2;

  const reservationMap = new Map<string, (typeof reservations)[number]>();
  for (const row of reservations) {
    reservationMap.set(`${row.type}|${row.timeBlockCode}`, row);
  }

  const appointmentMap = new Map<string, (typeof appointments)>();
  for (const appointment of cappedAppointments) {
    const key = String(appointment.timeBlockCode);
    const current = appointmentMap.get(key) ?? [];
    current.push(appointment);
    appointmentMap.set(key, current);
  }

  const blockRows = blocks.map((block) => {
    const blockAppointments = appointmentMap.get(String(block.code)) ?? [];
    const installAppointments = blockAppointments.filter((row) => row.type === 'INSTALL');
    const serviceAppointments = blockAppointments.filter((row) => row.type === 'SERVICE_ESTIMATE');

    const installReservation = reservationMap.get(`INSTALL|${block.code}`);
    const serviceReservation = reservationMap.get(`SERVICE_ESTIMATE|${block.code}`);
    const installCapacity = installReservation?.capacity ?? fallbackInstallCapacity;
    const serviceCapacity = serviceReservation?.capacity ?? fallbackServiceCapacity;
    const installCount = installReservation?.reservedCount ?? installAppointments.length;
    const serviceCount = serviceReservation?.reservedCount ?? serviceAppointments.length;

    return {
      code: block.code,
      startTime: block.startTime,
      endTime: block.endTime,
      install: {
        capacity: installCapacity,
        reservedCount: installCount,
        remaining: Math.max(installCapacity - installCount, 0),
        appointments: installAppointments,
      },
      serviceEstimate: {
        capacity: serviceCapacity,
        reservedCount: serviceCount,
        remaining: Math.max(serviceCapacity - serviceCount, 0),
        appointments: serviceAppointments,
      },
    };
  });

  return {
    date: args.dateKey,
    appointmentsTruncated,
    appointmentCount: cappedAppointments.length,
    settings: settings
      ? {
          timezone: settings.timezone,
          defaultServiceCapacityPerBlock: settings.defaultServiceCapacityPerBlock,
          defaultInstallCapacityPerBlock: settings.defaultInstallCapacityPerBlock,
          throttleServiceCapacityPerBlock: settings.throttleServiceCapacityPerBlock,
          throttleInstallCapacityPerBlock: settings.throttleInstallCapacityPerBlock,
          throttleServiceEnabled: settings.throttleServiceEnabled,
          throttleInstallEnabled: settings.throttleInstallEnabled,
        }
      : null,
    blocks: blockRows,
  };
}

async function buildTodayScheduleReadModel(args: {
  orgId: string;
  userId: string;
  dateKey: string;
  maxAppointments: number;
  maxTimeEntries: number;
}) {
  const maxAppointments = Math.max(1, args.maxAppointments);
  const maxTimeEntries = Math.max(1, args.maxTimeEntries);
  const date = toUtcDateOnly(args.dateKey);
  const [appointments, timeEntries] = await Promise.all([
    prisma.appointment.findMany({
      where: {
        orgId: args.orgId,
        date,
        assignedTechId: args.userId,
        status: { not: 'CANCELED' },
      },
      include: {
        customer: {
          select: {
            id: true,
            fullName: true,
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
          },
        },
        quote: {
          select: {
            id: true,
            kind: true,
            status: true,
          },
        },
      },
      orderBy: [{ timeBlockCode: 'asc' }, { createdAt: 'asc' }],
      take: maxAppointments + 1,
    }),
    prisma.timeEntry.findMany({
      where: {
        orgId: args.orgId,
        userId: args.userId,
        startedAt: {
          gte: new Date(date.getTime() - 6 * 24 * 60 * 60 * 1000),
        },
      },
      orderBy: { startedAt: 'desc' },
      take: maxTimeEntries + 1,
    }),
  ]);
  const appointmentsTruncated = appointments.length > maxAppointments;
  const cappedAppointments = appointmentsTruncated
    ? appointments.slice(0, maxAppointments)
    : appointments;
  const timeEntriesTruncated = timeEntries.length > maxTimeEntries;
  const cappedTimeEntries = timeEntriesTruncated
    ? timeEntries.slice(0, maxTimeEntries)
    : timeEntries;

  const openShift = cappedTimeEntries.find(
    (row) => row.type === TimeEntryType.SHIFT && row.status === TimeEntryStatus.OPEN,
  );
  const openBreak = cappedTimeEntries.find(
    (row) => row.type === TimeEntryType.BREAK && row.status === TimeEntryStatus.OPEN,
  );
  const openJob = cappedTimeEntries.find(
    (row) => row.type === TimeEntryType.JOB && row.status === TimeEntryStatus.OPEN,
  );

  return {
    date: args.dateKey,
    appointments: cappedAppointments,
    appointmentsTruncated,
    timeEntriesTruncated,
    openEntries: {
      shiftId: openShift?.id ?? null,
      breakId: openBreak?.id ?? null,
      jobEntryId: openJob?.id ?? null,
      jobId: openJob?.jobId ?? null,
    },
    timeEntries: cappedTimeEntries,
  };
}

function toPublicQuoteAttachmentView(attachment: {
  id: string;
  fileName: string;
  mimeType: string;
  caption: string | null;
  tag: string;
  displayObjectKey: string | null;
  thumbObjectKey: string | null;
  objectKey: string;
  bucket: string;
  createdAt: Date;
}) {
  return {
    id: attachment.id,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    caption: attachment.caption,
    tag: attachment.tag,
    displayObjectKey: attachment.displayObjectKey,
    thumbObjectKey: attachment.thumbObjectKey,
    objectKey: attachment.objectKey,
    bucket: attachment.bucket,
    createdAt: attachment.createdAt.toISOString(),
  };
}

type CommsParticipantView = {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  raw?: string | null;
};

function commsParticipantsFromJson(value: unknown): CommsParticipantView[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const participants: CommsParticipantView[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      continue;
    }
    const participant = row as Record<string, unknown>;
    participants.push({
      name: typeof participant.name === 'string' ? participant.name : null,
      phone: typeof participant.phone === 'string' ? participant.phone : null,
      email: typeof participant.email === 'string' ? participant.email : null,
      raw: typeof participant.raw === 'string' ? participant.raw : null,
    });
  }
  return participants;
}

async function resolvePrivilegedActorUserId(orgId: string): Promise<string | undefined> {
  const ownerOrAdmin = await prisma.user.findFirst({
    where: {
      orgId,
      isActive: true,
      userRoles: {
        some: {
          role: {
            name: { in: ['owner', 'admin'] },
          },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });

  if (ownerOrAdmin?.id) {
    return ownerOrAdmin.id;
  }

  return resolveSystemActorUserId(orgId);
}


async function requireOwnerOrAdmin(req: Request, orgId: string) {
  const user = await resolveActorUser(req, orgId);
  if (!user) {
    const notFound = new Error('No active user found for organization');
    (notFound as Error & { status?: number }).status = 404;
    throw notFound;
  }

  const roleLinks = await prisma.userRole.findMany({
    where: { userId: user.id },
    include: { role: true },
  });
  const roles = roleLinks.map((link) => link.role.name.toLowerCase());
  const allowed = roles.some((role) => role === 'owner' || role === 'admin');
  if (!allowed) {
    const forbidden = new Error('Forbidden: owner or admin role required');
    (forbidden as Error & { status?: number }).status = 403;
    throw forbidden;
  }

  return {
    user,
    roles,
  };
}

async function requireOwnerAdminOrManager(req: Request, orgId: string) {
  const user = await resolveActorUser(req, orgId);
  if (!user) {
    const notFound = new Error('No active user found for organization');
    (notFound as Error & { status?: number }).status = 404;
    throw notFound;
  }

  const roleLinks = await prisma.userRole.findMany({
    where: { userId: user.id },
    include: { role: true },
  });
  const roles = roleLinks.map((link) => link.role.name.toLowerCase());
  const allowed = roles.some(
    (role) =>
      role === 'owner' ||
      role === 'admin' ||
      role.includes('manager') ||
      role === 'billing_manager',
  );
  if (!allowed) {
    const forbidden = new Error('Forbidden: owner/admin/manager role required');
    (forbidden as Error & { status?: number }).status = 403;
    throw forbidden;
  }

  return {
    user,
    roles,
  };
}

function permissionCovers(required: string, granted: string): boolean {
  if (granted === '*' || granted === required) {
    return true;
  }
  if (granted.endsWith('*')) {
    return required.startsWith(granted.slice(0, -1));
  }
  return false;
}

async function resolveUserPermissions(userId: string): Promise<string[]> {
  const roleLinks = await prisma.userRole.findMany({
    where: { userId },
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

  const keys = new Set<string>();
  for (const roleLink of roleLinks) {
    for (const rolePermission of roleLink.role.rolePermissions) {
      keys.add(rolePermission.permission.key);
    }
  }

  return [...keys.values()];
}

async function requireAnyPermission(
  req: Request,
  orgId: string,
  requiredPermissions: string[],
) {
  const user = await resolveActorUser(req, orgId);
  if (!user) {
    const notFound = new Error('No active user found for organization');
    (notFound as Error & { status?: number }).status = 404;
    throw notFound;
  }

  const granted = await resolveUserPermissions(user.id);
  const allowed = requiredPermissions.some((required) =>
    granted.some((grant) => permissionCovers(required, grant)),
  );

  if (!allowed) {
    const forbidden = new Error(
      `Forbidden: missing required permissions (${requiredPermissions.join(', ')})`,
    );
    (forbidden as Error & { status?: number }).status = 403;
    throw forbidden;
  }

  return {
    user,
    permissions: granted,
  };
}

function userHasPermission(grantedPermissions: string[], required: string): boolean {
  return grantedPermissions.some((grant) => permissionCovers(required, grant));
}

async function resolveUserRoleNames(userId: string): Promise<string[]> {
  const roleLinks = await prisma.userRole.findMany({
    where: { userId },
    include: { role: true },
  });
  return roleLinks.map((link) => link.role.name.toLowerCase());
}

function parseIntField(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? Math.round(parsed) : null;
  }
  return null;
}

function sanitizeObjectKeySegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function canAccessStreamByRoles(roles: string[]): boolean {
  return roles.some((role) => role === 'owner' || role === 'admin' || role.includes('manager'));
}

async function requireStreamAccess(req: Request, orgId: string) {
  const user = await resolveActorUser(req, orgId);
  if (!user) {
    throw new Error('No active user found for organization');
  }

  const roleLinks = await prisma.userRole.findMany({
    where: { userId: user.id },
    include: { role: true },
  });
  const roles = roleLinks.map((link) => link.role.name.toLowerCase());

  if (!canAccessStreamByRoles(roles)) {
    const forbidden = new Error('Forbidden: owner or manager role required');
    (forbidden as Error & { status?: number }).status = 403;
    throw forbidden;
  }

  return { user, roles };
}

async function getOrgId(req: Request): Promise<string> {
  const slug = req.header('x-org-slug') ?? 'russell-comfort';
  const org = await prisma.organization.findUnique({ where: { slug } });
  if (!org) {
    throw new Error(`Organization not found: ${slug}`);
  }
  return org.id;
}

async function resolveActorUser(req: Request, orgId: string) {
  const headerUserId = req.header('x-actor-user-id');
  const queryUserId =
    typeof req.query.userId === 'string' ? req.query.userId : undefined;
  const queryEmail =
    typeof req.query.email === 'string' ? req.query.email : undefined;

  if (headerUserId) {
    const user = await prisma.user.findFirst({
      where: { id: headerUserId, orgId, isActive: true },
    });
    if (user) {
      return user;
    }
  }

  if (queryUserId) {
    const user = await prisma.user.findFirst({
      where: { id: queryUserId, orgId, isActive: true },
    });
    if (user) {
      return user;
    }
  }

  if (queryEmail) {
    const user = await prisma.user.findFirst({
      where: { email: queryEmail, orgId, isActive: true },
    });
    if (user) {
      return user;
    }
  }

  return prisma.user.findFirst({
    where: {
      orgId,
      actorType: ActorType.HUMAN,
      isActive: true,
    },
    orderBy: { createdAt: 'asc' },
  });
}

async function getActor(req: Request, orgId: string) {
  const resolved = await resolveActorUser(req, orgId);

  return {
    actorType: ActorType.HUMAN,
    actorUserId: resolved?.id,
    actorLabel: 'api-default-user',
  };
}

async function resolveSystemActorUserId(orgId: string): Promise<string | undefined> {
  const systemUser = await prisma.user.findFirst({
    where: {
      orgId,
      actorType: ActorType.SYSTEM,
      isActive: true,
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (systemUser) {
    return systemUser.id;
  }

  const adminFallback = await prisma.user.findFirst({
    where: {
      orgId,
      isActive: true,
      email: 'admin@russellcomfort.com',
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return adminFallback?.id;
}

function localDateKey(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value ?? '1970';
  const month = parts.find((part) => part.type === 'month')?.value ?? '01';
  const day = parts.find((part) => part.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function parseRangeDays(value: unknown, fallbackDays = 30): number {
  if (typeof value !== 'string') {
    return fallbackDays;
  }
  const match = value.trim().match(/^(\d{1,3})d$/i);
  if (!match) {
    return fallbackDays;
  }
  const parsed = Number.parseInt(match[1], 10);
  if (!Number.isFinite(parsed)) {
    return fallbackDays;
  }
  return Math.min(Math.max(parsed, 1), 365);
}

type HealthIssueLevel = 'WARN' | 'CRITICAL';

type HealthIssue = {
  level: HealthIssueLevel;
  key: string;
  message: string;
};

type HealthRecommendedAction = {
  key: string;
  title: string;
  why: string;
  commands: string[];
};

type HealthSnapshotPoint = {
  timestamp: string;
  overall: 'OK' | 'WARN' | 'CRITICAL';
  pendingOutbox: number | null;
  failedOutbox: number | null;
  pendingApprovals: number | null;
  failedExecutions1h: number | null;
  backupAgeHours: number | null;
  restoreDrillAgeHours: number | null;
  loadSmokeAgeHours: number | null;
  loadSmokeSuccessPct: number | null;
  loadSmokeP95Seconds: number | null;
  loadSmokeTrendFailCount: number | null;
};

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePositiveFloatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

type BackupChecksumState = 'UNKNOWN' | 'OK' | 'MISMATCH' | 'UNAVAILABLE';
type BackupArchiveState = 'UNKNOWN' | 'OK' | 'CORRUPT' | 'UNAVAILABLE';

const execFileAsync = promisify(execFile);

const backupChecksumCache = new Map<
  string,
  {
    state: BackupChecksumState;
    checkedAtMs: number;
  }
>();
const backupArchiveCache = new Map<
  string,
  {
    state: BackupArchiveState;
    checkedAtMs: number;
  }
>();

function parseKeyValueText(raw: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (key) {
      values.set(key, value);
    }
  }
  return values;
}

async function sha256FileHex(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);

    stream.on('error', () => resolve(null));
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => {
      try {
        resolve(hash.digest('hex'));
      } catch {
        resolve(null);
      }
    });
  });
}

async function fileSignature(filePath: string): Promise<string | null> {
  try {
    const info = await stat(filePath);
    return `${info.size}:${Math.trunc(info.mtimeMs)}`;
  } catch {
    return null;
  }
}

async function buildBackupChecksumCacheKey(input: {
  backupPath: string;
  postgresFile: string;
  postgresSha: string;
  minioFile: string;
  minioSha: string;
}): Promise<string> {
  const postgresPath = join(input.backupPath, input.postgresFile);
  const minioPath = join(input.backupPath, input.minioFile);
  const [postgresSignature, minioSignature] = await Promise.all([
    fileSignature(postgresPath),
    fileSignature(minioPath),
  ]);

  return [
    input.backupPath,
    input.postgresFile,
    input.postgresSha,
    input.minioFile,
    input.minioSha,
    postgresSignature ?? 'missing',
    minioSignature ?? 'missing',
  ].join('|');
}

async function buildBackupArchiveCacheKey(input: {
  backupPath: string;
  postgresFile: string;
  minioFile: string;
  postgresSha: string;
  minioSha: string;
}): Promise<string> {
  const postgresPath = join(input.backupPath, input.postgresFile);
  const minioPath = join(input.backupPath, input.minioFile);
  const [postgresSignature, minioSignature] = await Promise.all([
    fileSignature(postgresPath),
    fileSignature(minioPath),
  ]);

  return [
    input.backupPath,
    input.postgresFile,
    input.minioFile,
    input.postgresSha,
    input.minioSha,
    postgresSignature ?? 'missing',
    minioSignature ?? 'missing',
  ].join('|');
}

async function evaluateBackupChecksums(input: {
  backupPath: string;
  postgresFile: string;
  postgresSha: string;
  minioFile: string;
  minioSha: string;
}): Promise<BackupChecksumState> {
  const cacheKey = await buildBackupChecksumCacheKey(input);
  const nowMs = Date.now();
  const cacheTtlMs = parsePositiveIntEnv('HEALTH_BACKUP_CHECKSUM_CACHE_MINUTES', 30) * 60 * 1000;
  const cached = backupChecksumCache.get(cacheKey);
  if (cached && nowMs - cached.checkedAtMs <= cacheTtlMs) {
    return cached.state;
  }

  const [actualPostgresSha, actualMinioSha] = await Promise.all([
    sha256FileHex(join(input.backupPath, input.postgresFile)),
    sha256FileHex(join(input.backupPath, input.minioFile)),
  ]);

  let state: BackupChecksumState = 'UNAVAILABLE';
  if (actualPostgresSha && actualMinioSha) {
    state =
      actualPostgresSha === input.postgresSha &&
      actualMinioSha === input.minioSha
        ? 'OK'
        : 'MISMATCH';
  }

  backupChecksumCache.set(cacheKey, {
    state,
    checkedAtMs: nowMs,
  });
  return state;
}

async function verifyGzipArchive(filePath: string): Promise<boolean> {
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  try {
    await pipeline(
      createReadStream(filePath),
      createGunzip(),
      sink,
    );
    return true;
  } catch {
    return false;
  }
}

async function verifyTarGzipArchive(filePath: string): Promise<{
  ok: boolean;
  unavailable: boolean;
}> {
  try {
    await execFileAsync('tar', ['-tzf', filePath], {
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, unavailable: false };
  } catch (error) {
    const errorCode =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : '';
    if (errorCode === 'ENOENT') {
      return { ok: false, unavailable: true };
    }
    return { ok: false, unavailable: false };
  }
}

async function evaluateBackupArchiveState(input: {
  backupPath: string;
  postgresFile: string;
  minioFile: string;
  postgresSha: string;
  minioSha: string;
}): Promise<BackupArchiveState> {
  const cacheKey = await buildBackupArchiveCacheKey(input);
  const nowMs = Date.now();
  const cacheTtlMs = parsePositiveIntEnv('HEALTH_BACKUP_CHECKSUM_CACHE_MINUTES', 30) * 60 * 1000;
  const cached = backupArchiveCache.get(cacheKey);
  if (cached && nowMs - cached.checkedAtMs <= cacheTtlMs) {
    return cached.state;
  }

  const postgresArchiveOk = await verifyGzipArchive(join(input.backupPath, input.postgresFile));
  let state: BackupArchiveState;
  if (!postgresArchiveOk) {
    state = 'CORRUPT';
  } else {
    const minioArchive = await verifyTarGzipArchive(join(input.backupPath, input.minioFile));
    if (minioArchive.ok) {
      state = 'OK';
    } else if (minioArchive.unavailable) {
      state = 'UNAVAILABLE';
    } else {
      state = 'CORRUPT';
    }
  }

  backupArchiveCache.set(cacheKey, {
    state,
    checkedAtMs: nowMs,
  });
  return state;
}

function parseIsoDateOrNull(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function resolveBackupDirConfig(): { path: string; explicit: boolean } {
  const configured = process.env.BACKUP_DIR?.trim();
  if (configured) {
    return { path: configured, explicit: true };
  }
  return {
    path: join(process.cwd(), '..', '..', 'backups'),
    explicit: false,
  };
}

function getHealthSnapshotLogPath(): string {
  const configured = process.env.HEALTH_SNAPSHOT_LOG_PATH?.trim();
  if (configured) {
    return configured;
  }
  const backupDir = resolveBackupDirConfig().path;
  return join(backupDir, 'health-history.jsonl');
}

function getHealthIncidentDirPath(): string {
  const configured = process.env.HEALTH_INCIDENT_DIR?.trim();
  if (configured) {
    return configured;
  }
  const backupDir = resolveBackupDirConfig().path;
  return join(backupDir, 'incidents');
}

function getRestoreDrillMarkerPath(): string {
  const configured = process.env.HEALTH_RESTORE_DRILL_MARKER_PATH?.trim();
  if (configured) {
    return configured;
  }
  const backupDir = resolveBackupDirConfig().path;
  return join(backupDir, 'restore-drill.marker');
}

function getRestoreDrillLockPath(): string {
  const configured = process.env.HEALTH_RESTORE_DRILL_LOCK_PATH?.trim();
  if (configured) {
    return configured;
  }
  const backupDir = resolveBackupDirConfig().path;
  return join(backupDir, 'restore-drill.lock');
}

function getRemediateLockPath(): string {
  const configured = process.env.HEALTH_REMEDIATE_LOCK_PATH?.trim();
  if (configured) {
    return configured;
  }
  const backupDir = resolveBackupDirConfig().path;
  return join(backupDir, 'remediate.lock');
}

function getLoadSmokeMarkerPath(): string {
  const configured = process.env.HEALTH_LOAD_SMOKE_MARKER_PATH?.trim();
  if (configured) {
    return configured;
  }
  const backupDir = resolveBackupDirConfig().path;
  return join(backupDir, 'load-smoke.marker');
}

function getLoadSmokeHistoryPath(): string {
  const configured = process.env.HEALTH_LOAD_SMOKE_HISTORY_PATH?.trim();
  if (configured) {
    return configured;
  }
  const backupDir = resolveBackupDirConfig().path;
  return join(backupDir, 'load-smoke-history.jsonl');
}

async function loadRestoreDrillStatus(now: Date = new Date()): Promise<{
  path: string;
  state: 'OK' | 'MISSING' | 'INVALID' | 'FAILED';
  status: string | null;
  completedAt: Date | null;
  completedAtIso: string | null;
  ageHours: number | null;
}> {
  const markerPath = getRestoreDrillMarkerPath();
  try {
    const raw = await readFile(markerPath, 'utf8');
    const values = new Map<string, string>();
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex <= 0) {
        continue;
      }
      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim();
      if (!key) {
        continue;
      }
      values.set(key, value);
    }

    const completedAtIsoRaw = values.get('completedAtIso') ?? null;
    const completedAtEpochRaw = values.get('completedAtEpoch');
    const statusRaw = values.get('status')?.trim() ?? null;
    const parsedFromIso = parseIsoDateOrNull(completedAtIsoRaw);
    const parsedEpoch = completedAtEpochRaw ? Number.parseInt(completedAtEpochRaw, 10) : Number.NaN;
    const parsedFromEpoch =
      Number.isFinite(parsedEpoch) && parsedEpoch > 0
        ? new Date(parsedEpoch * 1000)
        : null;
    const completedAt = parsedFromIso ?? parsedFromEpoch;

    if (!completedAt || Number.isNaN(completedAt.getTime())) {
      return {
        path: markerPath,
        state: 'INVALID',
        status: statusRaw,
        completedAt: null,
        completedAtIso: completedAtIsoRaw,
        ageHours: null,
      };
    }

    if (statusRaw && statusRaw.toLowerCase() !== 'success') {
      const ageHours = Math.max(
        0,
        Math.floor((now.getTime() - completedAt.getTime()) / (60 * 60 * 1000)),
      );
      return {
        path: markerPath,
        state: 'FAILED',
        status: statusRaw,
        completedAt,
        completedAtIso: completedAt.toISOString(),
        ageHours,
      };
    }

    const ageHours = Math.max(
      0,
      Math.floor((now.getTime() - completedAt.getTime()) / (60 * 60 * 1000)),
    );
    return {
      path: markerPath,
      state: 'OK',
      status: statusRaw,
      completedAt,
      completedAtIso: completedAt.toISOString(),
      ageHours,
    };
  } catch {
    return {
      path: markerPath,
      state: 'MISSING',
      status: null,
      completedAt: null,
      completedAtIso: null,
      ageHours: null,
    };
  }
}

async function loadRestoreDrillLockStatus(now: Date = new Date()): Promise<{
  path: string;
  state: 'NONE' | 'ACTIVE' | 'STALE';
  ageMinutes: number | null;
}> {
  const lockPath = getRestoreDrillLockPath();
  const maxAgeMinutes = parsePositiveIntValue(
    process.env.HEALTH_MAX_RESTORE_DRILL_LOCK_AGE_MINUTES,
    120,
  );

  try {
    const lockStat = await stat(lockPath);
    const epochRaw = await readFile(join(lockPath, 'startedAtEpoch'), 'utf8').catch(
      () => '',
    );
    const parsedEpoch = Number.parseInt(epochRaw.trim(), 10);
    const startedAt =
      Number.isFinite(parsedEpoch) && parsedEpoch > 0
        ? new Date(parsedEpoch * 1000)
        : lockStat.mtime;
    const ageMinutes = Math.max(
      0,
      Math.floor((now.getTime() - startedAt.getTime()) / (60 * 1000)),
    );

    return {
      path: lockPath,
      state: ageMinutes > maxAgeMinutes ? 'STALE' : 'ACTIVE',
      ageMinutes,
    };
  } catch {
    return {
      path: lockPath,
      state: 'NONE',
      ageMinutes: null,
    };
  }
}

async function loadRemediateLockStatus(now: Date = new Date()): Promise<{
  path: string;
  state: 'NONE' | 'ACTIVE' | 'STALE';
  ageMinutes: number | null;
}> {
  const lockPath = getRemediateLockPath();
  const maxAgeMinutes = parsePositiveIntValue(
    process.env.HEALTH_MAX_REMEDIATE_LOCK_AGE_MINUTES,
    30,
  );

  try {
    const lockStat = await stat(lockPath);
    const raw = await readFile(lockPath, 'utf8').catch(() => '');
    const entries = parseKeyValueText(raw);
    const epochRaw = entries.get('createdAtEpoch') ?? '';
    const parsedEpoch = Number.parseInt(epochRaw.trim(), 10);
    const createdAt =
      Number.isFinite(parsedEpoch) && parsedEpoch > 0
        ? new Date(parsedEpoch * 1000)
        : lockStat.mtime;
    const ageMinutes = Math.max(
      0,
      Math.floor((now.getTime() - createdAt.getTime()) / (60 * 1000)),
    );

    return {
      path: lockPath,
      state: ageMinutes > maxAgeMinutes ? 'STALE' : 'ACTIVE',
      ageMinutes,
    };
  } catch {
    return {
      path: lockPath,
      state: 'NONE',
      ageMinutes: null,
    };
  }
}

async function loadLoadSmokeStatus(now: Date = new Date()): Promise<{
  path: string;
  state: 'OK' | 'MISSING' | 'INVALID';
  status: string | null;
  completedAt: Date | null;
  completedAtIso: string | null;
  ageHours: number | null;
  successPct: number | null;
  p95Seconds: number | null;
}> {
  const markerPath = getLoadSmokeMarkerPath();
  try {
    const raw = await readFile(markerPath, 'utf8');
    const values = parseKeyValueText(raw);

    const completedAtIsoRaw = values.get('completedAtIso') ?? null;
    const completedAtEpochRaw = values.get('completedAtEpoch');
    const statusRaw = values.get('status')?.trim() ?? null;
    const successPctRaw = values.get('successPct');
    const p95Raw = values.get('p95Seconds');
    const parsedFromIso = parseIsoDateOrNull(completedAtIsoRaw);
    const parsedEpoch = completedAtEpochRaw ? Number.parseInt(completedAtEpochRaw, 10) : Number.NaN;
    const parsedFromEpoch =
      Number.isFinite(parsedEpoch) && parsedEpoch > 0
        ? new Date(parsedEpoch * 1000)
        : null;
    const completedAt = parsedFromIso ?? parsedFromEpoch;
    const successPct = successPctRaw ? Number.parseFloat(successPctRaw) : Number.NaN;
    const p95Seconds = p95Raw ? Number.parseFloat(p95Raw) : Number.NaN;

    if (!completedAt || Number.isNaN(completedAt.getTime())) {
      return {
        path: markerPath,
        state: 'INVALID',
        status: statusRaw,
        completedAt: null,
        completedAtIso: completedAtIsoRaw,
        ageHours: null,
        successPct: Number.isFinite(successPct) ? successPct : null,
        p95Seconds: Number.isFinite(p95Seconds) ? p95Seconds : null,
      };
    }

    const ageHours = Math.max(
      0,
      Math.floor((now.getTime() - completedAt.getTime()) / (60 * 60 * 1000)),
    );
    return {
      path: markerPath,
      state: 'OK',
      status: statusRaw,
      completedAt,
      completedAtIso: completedAt.toISOString(),
      ageHours,
      successPct: Number.isFinite(successPct) ? successPct : null,
      p95Seconds: Number.isFinite(p95Seconds) ? p95Seconds : null,
    };
  } catch {
    return {
      path: markerPath,
      state: 'MISSING',
      status: null,
      completedAt: null,
      completedAtIso: null,
      ageHours: null,
      successPct: null,
      p95Seconds: null,
    };
  }
}

async function loadLoadSmokeTrend(): Promise<{
  path: string;
  window: number;
  failCount: number;
}> {
  const path = getLoadSmokeHistoryPath();
  const window = parsePositiveIntEnv('HEALTH_LOAD_SMOKE_TREND_WINDOW', 5);
  if (window <= 0) {
    return { path, window: 0, failCount: 0 };
  }
  try {
    const raw = await readFile(path, 'utf8');
    const lines = raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const recent = lines.slice(-window);
    let failCount = 0;
    for (const line of recent) {
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        const status = typeof row.status === 'string' ? row.status.toUpperCase() : '';
        if (status === 'FAIL') {
          failCount += 1;
        }
      } catch {
        // ignore malformed history lines
      }
    }
    return { path, window, failCount };
  } catch {
    return { path, window, failCount: 0 };
  }
}

async function loadLatestHealthSnapshot(): Promise<{
  path: string;
  snapshot: Record<string, unknown>;
} | null> {
  const filePath = getHealthSnapshotLogPath();
  try {
    const raw = await readFile(filePath, 'utf8');
    const lines = raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const parsed = JSON.parse(lines[index]) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return {
            path: filePath,
            snapshot: parsed as Record<string, unknown>,
          };
        }
      } catch {
        // Skip malformed line and continue searching backwards.
      }
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeHealthOverall(value: unknown): 'OK' | 'WARN' | 'CRITICAL' {
  const normalized = String(value ?? '')
    .trim()
    .toUpperCase();
  if (normalized === 'CRITICAL') {
    return 'CRITICAL';
  }
  if (normalized === 'WARN') {
    return 'WARN';
  }
  return 'OK';
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function toHealthSnapshotPoint(record: Record<string, unknown>): HealthSnapshotPoint | null {
  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : null;
  if (!timestamp) {
    return null;
  }

  const metrics =
    record.metrics && typeof record.metrics === 'object' && !Array.isArray(record.metrics)
      ? (record.metrics as Record<string, unknown>)
      : {};

  return {
    timestamp,
    overall: normalizeHealthOverall(record.overall),
    pendingOutbox: numberOrNull(metrics.pendingOutbox),
    failedOutbox: numberOrNull(metrics.failedOutbox),
    pendingApprovals: numberOrNull(metrics.pendingApprovals),
    failedExecutions1h: numberOrNull(metrics.failedExecutions1h),
    backupAgeHours: numberOrNull(metrics.backupAgeHours),
    restoreDrillAgeHours: numberOrNull(metrics.restoreDrillAgeHours),
    loadSmokeAgeHours: numberOrNull(metrics.loadSmokeAgeHours),
    loadSmokeSuccessPct: numberOrNull(metrics.loadSmokeSuccessPct),
    loadSmokeP95Seconds: numberOrNull(metrics.loadSmokeP95Seconds),
    loadSmokeTrendFailCount: numberOrNull(metrics.loadSmokeTrendFailCount),
  };
}

async function loadRecentHealthSnapshots(limit = 24): Promise<{
  path: string;
  snapshots: HealthSnapshotPoint[];
}> {
  const filePath = getHealthSnapshotLogPath();
  try {
    const raw = await readFile(filePath, 'utf8');
    const lines = raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const snapshots: HealthSnapshotPoint[] = [];
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (snapshots.length >= limit) {
        break;
      }
      try {
        const parsed = JSON.parse(lines[index]) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          continue;
        }
        const point = toHealthSnapshotPoint(parsed as Record<string, unknown>);
        if (point) {
          snapshots.push(point);
        }
      } catch {
        // Skip malformed line and continue scanning.
      }
    }

    snapshots.reverse();
    return {
      path: filePath,
      snapshots,
    };
  } catch {
    return {
      path: filePath,
      snapshots: [],
    };
  }
}

function healthIncidentFingerprintFromPayload(payload: Record<string, unknown>): string {
  const fromPayload =
    typeof payload.fingerprint === 'string' && payload.fingerprint.trim().length > 0
      ? payload.fingerprint.trim()
      : null;
  if (fromPayload) {
    return fromPayload;
  }

  const health =
    payload.health && typeof payload.health === 'object' && !Array.isArray(payload.health)
      ? (payload.health as Record<string, unknown>)
      : {};
  const overall = String(health.overall ?? payload.severity ?? 'UNKNOWN')
    .trim()
    .toUpperCase();
  const issueKeys = Array.isArray(health.issues)
    ? Array.from(
        new Set(
          health.issues
            .map((issue) =>
              issue && typeof issue === 'object' && !Array.isArray(issue)
                ? String((issue as Record<string, unknown>).key ?? '')
                : '',
            )
            .filter((key) => key.length > 0),
        ),
      ).sort((a, b) => a.localeCompare(b))
    : [];
  const exit = Number.isFinite(payload.healthExit)
    ? Number(payload.healthExit)
    : Number.isFinite((health as Record<string, unknown>).exitCode)
      ? Number((health as Record<string, unknown>).exitCode)
      : -1;
  const source = `overall=${overall};exit=${exit};issues=${issueKeys.join(',')}`;
  return createHash('sha256').update(source).digest('hex');
}

async function loadRecentHealthIncidents(
  limit = 10,
  options: {
    collapse?: boolean;
    collapseWindowMinutes?: number;
  } = {},
): Promise<{
  incidents: Array<{
    path: string;
    timestamp: string | null;
    severity: string | null;
    fingerprint: string;
    duplicateCount: number;
    payload: Record<string, unknown>;
  }>;
  rawCount: number;
}> {
  const collapse = options.collapse ?? true;
  const collapseWindowMinutes =
    options.collapseWindowMinutes ??
    parsePositiveIntEnv('HEALTH_INCIDENT_COLLAPSE_WINDOW_MINUTES', 180);
  const collapseWindowMs = collapseWindowMinutes * 60 * 1000;
  const incidentDir = getHealthIncidentDirPath();
  try {
    const entries = await readdir(incidentDir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => join(incidentDir, entry.name));

    const withMtime = await Promise.all(
      files.map(async (filePath) => {
        try {
          const info = await stat(filePath);
          return { filePath, mtimeMs: info.mtimeMs };
        } catch {
          return null;
        }
      }),
    );

    const sorted = withMtime
      .filter((row): row is { filePath: string; mtimeMs: number } => row !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, Math.max(1, limit));

    const parsedIncidents: Array<{
      path: string;
      timestamp: string | null;
      severity: string | null;
      fingerprint: string;
      observedAtMs: number;
      payload: Record<string, unknown>;
    }> = [];

    for (const item of sorted) {
      try {
        const text = await readFile(item.filePath, 'utf8');
        const parsed = JSON.parse(text) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          continue;
        }
        const payload = parsed as Record<string, unknown>;
        const timestamp =
          typeof payload.timestamp === 'string' ? payload.timestamp : null;
        const parsedAt =
          timestamp && !Number.isNaN(Date.parse(timestamp))
            ? Date.parse(timestamp)
            : item.mtimeMs;
        parsedIncidents.push({
          path: item.filePath,
          timestamp,
          severity: typeof payload.severity === 'string' ? payload.severity : null,
          fingerprint: healthIncidentFingerprintFromPayload(payload),
          observedAtMs: parsedAt,
          payload,
        });
      } catch {
        // Ignore malformed incidents.
      }
    }

    if (!collapse) {
      return {
        incidents: parsedIncidents.slice(0, Math.max(1, limit)).map((incident) => ({
          path: incident.path,
          timestamp: incident.timestamp,
          severity: incident.severity,
          fingerprint: incident.fingerprint,
          duplicateCount: 1,
          payload: incident.payload,
        })),
        rawCount: parsedIncidents.length,
      };
    }

    const anchors = new Map<string, { index: number; anchorMs: number }>();
    const deduped: Array<{
      path: string;
      timestamp: string | null;
      severity: string | null;
      fingerprint: string;
      duplicateCount: number;
      payload: Record<string, unknown>;
    }> = [];

    for (const incident of parsedIncidents) {
      const existing = anchors.get(incident.fingerprint);
      if (
        existing &&
        existing.anchorMs - incident.observedAtMs >= 0 &&
        existing.anchorMs - incident.observedAtMs <= collapseWindowMs
      ) {
        deduped[existing.index].duplicateCount += 1;
        continue;
      }

      deduped.push({
        path: incident.path,
        timestamp: incident.timestamp,
        severity: incident.severity,
        fingerprint: incident.fingerprint,
        duplicateCount: 1,
        payload: incident.payload,
      });
      anchors.set(incident.fingerprint, {
        index: deduped.length - 1,
        anchorMs: incident.observedAtMs,
      });

      if (deduped.length >= limit) {
        break;
      }
    }

    return {
      incidents: deduped,
      rawCount: parsedIncidents.length,
    };
  } catch {
    return {
      incidents: [],
      rawCount: 0,
    };
  }
}

function coerceIssueLevel(level: unknown): HealthIssueLevel {
  return String(level).toUpperCase() === 'CRITICAL' ? 'CRITICAL' : 'WARN';
}

function deriveOverallHealthStatus(issues: HealthIssue[]): 'OK' | 'WARN' | 'CRITICAL' {
  if (issues.some((issue) => issue.level === 'CRITICAL')) {
    return 'CRITICAL';
  }
  if (issues.length > 0) {
    return 'WARN';
  }
  return 'OK';
}

function recommendedActionForIssue(issue: HealthIssue): HealthRecommendedAction | null {
  switch (issue.key) {
    case 'postgres_disk_full':
      return {
        key: issue.key,
        title: 'Recover Postgres disk pressure',
        why: issue.message,
        commands: [
          'npm run ops:disk:status',
          'npm run ops:disk:recover',
          'npm run ops:disk:recover:aggressive',
          'docker compose up -d postgres api',
          'npm run ops:health:json',
        ],
      };
    case 'db_unreachable':
    case 'db_container_missing':
      return {
        key: issue.key,
        title: 'Restore database availability',
        why: issue.message,
        commands: [
          'docker compose ps',
          'docker compose up -d postgres',
          'npm run ops:health:json',
        ],
      };
    case 'backup_missing':
    case 'backup_dir_missing':
    case 'backup_stale':
    case 'backup_incomplete':
    case 'backup_manifest_invalid':
    case 'backup_checksum_mismatch':
    case 'backup_checksum_unavailable':
    case 'backup_archive_corrupt':
    case 'backup_archive_unavailable':
      return {
        key: issue.key,
        title: 'Repair backup visibility',
        why: issue.message,
        commands: [
          'bash scripts/ops/backup_nightly.sh',
          'bash scripts/ops/restore_latest_drill.sh',
          'npm run ops:health:json',
        ],
      };
    case 'restore_drill_missing':
    case 'restore_drill_invalid':
    case 'restore_drill_marker_invalid':
    case 'restore_drill_failed':
    case 'restore_drill_stale':
    case 'restore_drill_lock_stale':
      return {
        key: issue.key,
        title: 'Run restore drill validation',
        why: issue.message,
        commands: [
          'bash scripts/ops/restore_latest_drill.sh',
          'npm run ops:health:json',
        ],
      };
    case 'remediate_lock_stale':
      return {
        key: issue.key,
        title: 'Clear stale remediation lock',
        why: issue.message,
        commands: [
          'npm run ops:health:remediate:dry-run',
          'npm run ops:health:json',
        ],
      };
    case 'launchd_not_loaded':
    case 'launchd_exit_nonzero':
    case 'launchd_unavailable':
      return {
        key: issue.key,
        title: 'Repair launchd jobs',
        why: issue.message,
        commands: [
          'npm run ops:launchd:health',
          'npm run ops:launchd:repair',
          'npm run ops:launchd:repair:run-health',
        ],
      };
    case 'disk_free_low_gb':
    case 'disk_free_low_pct':
      return {
        key: issue.key,
        title: 'Increase free disk capacity',
        why: issue.message,
        commands: [
          'npm run ops:disk:status',
          'npm run ops:disk:recover',
          'npm run ops:disk:recover:aggressive',
        ],
      };
    case 'ops_snapshot_missing':
    case 'ops_snapshot_stale':
      return {
        key: issue.key,
        title: 'Restore ops health snapshot pipeline',
        why: issue.message,
        commands: [
          'npm run ops:launchd:health',
          'npm run ops:launchd:repair:run-health',
          'npm run ops:health:json',
        ],
      };
    case 'load_smoke_missing':
    case 'load_smoke_marker_invalid':
    case 'load_smoke_stale':
    case 'load_smoke_failed':
    case 'load_smoke_regressed':
    case 'load_smoke_latency_high':
    case 'load_smoke_trend_failed':
      return {
        key: issue.key,
        title: 'Refresh load smoke baseline',
        why: issue.message,
        commands: [
          'npm run ops:load:smoke:record',
          'npm run ops:health:json',
        ],
      };
    case 'outbox_pending_high':
    case 'outbox_stale_pending_high':
    case 'outbox_failed_high':
      return {
        key: issue.key,
        title: 'Drain outbox backlog',
        why: issue.message,
        commands: [
          'docker compose logs --tail=200 worker',
          'npm run ops:health:json',
        ],
      };
    case 'pending_approvals_high':
      return {
        key: issue.key,
        title: 'Triage approval queue',
        why: issue.message,
        commands: [
          'Open /approvals in Control Room',
          'Review stuck approval policies',
        ],
      };
    case 'auth_jwt_secret_insecure':
      return {
        key: issue.key,
        title: 'Rotate JWT secret',
        why: issue.message,
        commands: [
          'Set JWT_SECRET to a strong random value (32+ chars)',
          'Restart api service',
          'Force mobile/web re-login if needed',
        ],
      };
    case 'ingest_tokens_missing':
    case 'ingest_tokens_insecure':
      return {
        key: issue.key,
        title: 'Harden website ingest tokens',
        why: issue.message,
        commands: [
          'Set MBS_INGEST_TOKENS to one or more strong random values (comma-separated)',
          'Update website bearer token to the rotated token',
          'Restart api service',
        ],
      };
    case 'call_webhook_secret_missing':
    case 'call_webhook_secret_insecure':
      return {
        key: issue.key,
        title: 'Harden call webhook secret',
        why: issue.message,
        commands: [
          'Set CALL_WEBHOOK_SECRET to a strong random value (24+ chars)',
          'Rotate provider webhook secret to match',
          'Restart api service',
        ],
      };
    case 'ingest_ip_hash_salt_missing':
    case 'ingest_ip_hash_salt_insecure':
      return {
        key: issue.key,
        title: 'Harden intake IP hash salt',
        why: issue.message,
        commands: [
          'Set MBS_IP_HASH_SALT to a strong random value (24+ chars)',
          'Restart api service',
        ],
      };
    case 'ingest_rate_limited_high':
    case 'mobile_login_rate_limited_high':
    case 'mobile_refresh_rate_limited_high':
    case 'mobile_sync_push_rate_limited_high':
    case 'mobile_sync_pull_rate_limited_high':
    case 'call_webhook_rate_limited_high':
    case 'agent_playbook_rate_limited_high':
      return {
        key: issue.key,
        title: 'Reduce repeated rate-limit pressure',
        why: issue.message,
        commands: [
          'Review API logs for repeated 429 sources and client retry bursts',
          'Confirm client-side backoff and retry behavior is exponential',
          'Tune *_RATE_LIMIT_MAX / *_RATE_LIMIT_WINDOW_MS only after fixing caller behavior',
        ],
      };
    case 'mobile_sync_payload_rejected_high':
      return {
        key: issue.key,
        title: 'Reduce mobile sync payload rejection pressure',
        why: issue.message,
        commands: [
          'Inspect MOBILE_SYNC_PAYLOAD_* and MOBILE_SYNC_TOO_MANY_ACTIONS responses to identify oversized payload patterns',
          'Trim queued action payload fields and split large writes into smaller deterministic actions',
          'Tune MOBILE_SYNC_ACTION_MAX_PAYLOAD_* limits only after fixing payload discipline on clients',
        ],
      };
    case 'agent_playbook_inflight_limit_high':
      return {
        key: issue.key,
        title: 'Reduce playbook executor saturation',
        why: issue.message,
        commands: [
          'Review API logs for PLAYBOOK_INFLIGHT_LIMIT_REACHED events and long-running playbooks',
          'Increase AGENT_PLAYBOOK_MAX_INFLIGHT_* only after verifying step timeouts and caller concurrency',
          'Scale api capacity or reduce concurrent dispatch from callers',
        ],
      };
    case 'agent_playbook_duplicate_inflight_high':
      return {
        key: issue.key,
        title: 'Reduce duplicate playbook in-flight collisions',
        why: issue.message,
        commands: [
          'Review client correlationId reuse and ensure one active execution per correlationId/playbook',
          'Wait for existing execution completion before replaying identical requests',
          'Use distinct correlationId values for distinct business intents',
        ],
      };
    case 'agent_playbook_timeout_high':
      return {
        key: issue.key,
        title: 'Reduce playbook timeout pressure',
        why: issue.message,
        commands: [
          'Review API logs for PLAYBOOK_REQUEST_TIMEOUT bursts and step execution timings',
          'Optimize slow tool steps or reduce payload complexity before increasing timeout budget',
          'Tune AGENT_PLAYBOOK_REQUEST_TIMEOUT_MS only after addressing root latency',
        ],
      };
    case 'agent_playbook_pack_load_failed_high':
      return {
        key: issue.key,
        title: 'Restore playbook pack load reliability',
        why: issue.message,
        commands: [
          'Check pack fixture/runtime path, manifest integrity, and symlink protections',
          'Verify requested pack ids exist and match deployed external-pack manifest entries',
          'Inspect API logs for PLAYBOOK_PACK_* errors and fix deployment drift',
        ],
      };
    case 'agent_playbook_payload_rejected_high':
      return {
        key: issue.key,
        title: 'Reduce playbook payload rejection pressure',
        why: issue.message,
        commands: [
          'Inspect PLAYBOOK_STEP_PAYLOAD_TOO_LARGE responses and identify oversized caller inputs',
          'Trim optional fields from playbook inputs and split large payloads into read-then-write steps',
          'Adjust AGENT_PLAYBOOK_MAX_STEP_PAYLOAD_BYTES only after confirming payload discipline',
        ],
      };
    case 'agent_playbook_fail_closed_high':
      return {
        key: issue.key,
        title: 'Stabilize fail-closed playbook gate pressure',
        why: issue.message,
        commands: [
          'Inspect /api/system/health issues and fix the triggering governance keys',
          'Keep AGENT_PLAYBOOK_FAIL_CLOSED_ENABLED=true and remediate root causes instead of disabling guardrails',
          'Tune AGENT_PLAYBOOK_FAIL_CLOSED_ISSUE_KEYS only with explicit ops sign-off',
        ],
      };
    case 'agent_playbook_governance_unavailable_high':
      return {
        key: issue.key,
        title: 'Restore governance gate reliability',
        why: issue.message,
        commands: [
          'Inspect API logs for PLAYBOOK_GOVERNANCE_TIMEOUT and PLAYBOOK_GOVERNANCE_UNAVAILABLE failures',
          'Increase AGENT_PLAYBOOK_FAIL_CLOSED_TIMEOUT_MS only after reducing health-check latency',
          'Stabilize health dependencies before resuming playbook traffic',
        ],
      };
    case 'media_upload_sessions_stale_high':
      return {
        key: issue.key,
        title: 'Drain stale media upload sessions',
        why: issue.message,
        commands: [
          'POST /api/admin/media/purge-expired (or run daily media purge worker) to expire stale sessions',
          'Inspect repeated upload failures in API logs for media.uploadSession.fail bursts',
          'Verify client retries reuse x-idempotency-key and sessionKey for deterministic recovery',
        ],
      };
    default:
      return null;
  }
}

function buildHealthRecommendations(issues: HealthIssue[]): HealthRecommendedAction[] {
  const seen = new Set<string>();
  const actions: HealthRecommendedAction[] = [];

  for (const issue of issues) {
    const action = recommendedActionForIssue(issue);
    if (!action || seen.has(action.key)) {
      continue;
    }
    seen.add(action.key);
    actions.push(action);
  }

  return actions;
}

function enforceProductionSecurityConfig(): void {
  const nodeEnv = (process.env.NODE_ENV ?? 'development').toLowerCase();
  if (nodeEnv !== 'production') {
    return;
  }
  if (
    process.env.ALLOW_INSECURE_JWT_SECRET !== 'true' &&
    isJwtSecretInsecure(getJwtSecret())
  ) {
    throw new Error(
      'Refusing to start API in production with insecure JWT_SECRET. Configure a strong secret (32+ chars).',
    );
  }
  if (
    process.env.ALLOW_INSECURE_INGEST_TOKENS !== 'true' &&
    evaluateIngestTokensHealth() !== 'OK'
  ) {
    throw new Error(
      'Refusing to start API in production with missing or insecure MBS_INGEST_TOKENS. Configure strong ingest bearer token(s).',
    );
  }
  if (
    process.env.ALLOW_INSECURE_CALL_WEBHOOK_SECRET !== 'true' &&
    evaluateCallWebhookSecretHealth() !== 'OK'
  ) {
    throw new Error(
      'Refusing to start API in production with missing or insecure CALL_WEBHOOK_SECRET. Configure a strong webhook secret.',
    );
  }
  if (
    process.env.ALLOW_INSECURE_INGEST_IP_HASH_SALT !== 'true' &&
    evaluateIngestIpHashSaltHealth() !== 'OK'
  ) {
    throw new Error(
      'Refusing to start API in production with missing or insecure MBS_IP_HASH_SALT. Configure a strong salt value.',
    );
  }
}

async function computeLiveSystemHealth(orgId: string): Promise<{
  generatedAt: string;
  status: 'OK' | 'WARN' | 'CRITICAL';
  metrics: {
    pendingOutbox: number;
    failedOutbox: number;
    stalePendingOutbox: number;
    pendingApprovals: number;
    failedExecutions1h: number;
    rateLimitedIngest1h: number;
    rateLimitedMobileLogin1h: number;
    rateLimitedMobileRefresh1h: number;
    rateLimitedMobileSyncPush1h: number;
    rateLimitedMobileSyncPull1h: number;
    mobileSyncPayloadRejected1h: number;
    rateLimitedCallWebhook1h: number;
    rateLimitedAgentPlaybook1h: number;
    playbookInflightLimitReached1h: number;
    playbookDuplicateInflight1h: number;
    playbookRequestTimeout1h: number;
    playbookPackLoadFailures1h: number;
    playbookPayloadRejected1h: number;
    playbookFailClosedBlocked1h: number;
    playbookGovernanceErrors1h: number;
    staleMediaUploadSessions: number;
    blockedExecutions24h: number;
    activeAgentRuns: number;
    killSwitchMode: string;
    backupAgeHours: number | null;
    backupIntegrityState: 'UNKNOWN' | 'OK' | 'INCOMPLETE';
    backupIntegrityMissingCount: number;
    backupManifestState: 'UNKNOWN' | 'OK' | 'INVALID';
    backupChecksumState: BackupChecksumState;
    backupArchiveState: BackupArchiveState;
    authJwtSecretState: 'OK' | 'INSECURE';
    ingestTokensState: SecretHealthState;
    callWebhookSecretState: SecretHealthState;
    ingestIpHashSaltState: SecretHealthState;
    restoreDrillAgeHours: number | null;
    restoreDrillStatus: string | null;
    restoreDrillLockStatus: string | null;
    restoreDrillLockAgeMinutes: number | null;
    remediateLockStatus: string | null;
    remediateLockAgeMinutes: number | null;
    loadSmokeAgeHours: number | null;
    loadSmokeStatus: string | null;
    loadSmokeSuccessPct: number | null;
    loadSmokeP95Seconds: number | null;
    loadSmokeTrendFailCount: number;
    loadSmokeTrendWindow: number;
  };
  thresholds: {
    maxPendingOutbox: number;
    maxFailedOutbox: number;
    maxStalePendingOutboxMinutes: number;
    maxStalePendingOutbox: number;
    maxPendingApprovals: number;
    maxFailedExecutions1h: number;
    maxRateLimitedIngest1h: number;
    maxRateLimitedMobileLogin1h: number;
    maxRateLimitedMobileRefresh1h: number;
    maxRateLimitedMobileSyncPush1h: number;
    maxRateLimitedMobileSyncPull1h: number;
    maxMobileSyncPayloadRejected1h: number;
    maxRateLimitedCallWebhook1h: number;
    maxRateLimitedAgentPlaybook1h: number;
    maxPlaybookInflightLimitReached1h: number;
    maxPlaybookDuplicateInflight1h: number;
    maxPlaybookRequestTimeout1h: number;
    maxPlaybookPackLoadFailures1h: number;
    maxPlaybookPayloadRejected1h: number;
    maxPlaybookFailClosedBlocked1h: number;
    maxPlaybookGovernanceErrors1h: number;
    maxStaleMediaUploadSessions: number;
    maxBackupAgeHours: number;
    maxRestoreDrillAgeHours: number;
    maxRestoreDrillLockAgeMinutes: number;
    maxRemediateLockAgeMinutes: number;
    maxLoadSmokeAgeHours: number;
    minLoadSmokeSuccessPct: number;
    maxLoadSmokeP95Seconds: number;
    maxLoadSmokeFailsWindow: number;
  };
  issues: HealthIssue[];
}> {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const staleMinutes = parsePositiveIntEnv('HEALTH_MAX_STALE_PENDING_OUTBOX_MINUTES', 15);
  const staleCutoff = new Date(now.getTime() - staleMinutes * 60 * 1000);

  const thresholds = {
    maxPendingOutbox: parsePositiveIntEnv('HEALTH_MAX_PENDING_OUTBOX', 200),
    maxFailedOutbox: parsePositiveIntEnv('HEALTH_MAX_FAILED_OUTBOX', 10),
    maxStalePendingOutboxMinutes: staleMinutes,
    maxStalePendingOutbox: parsePositiveIntEnv('HEALTH_MAX_STALE_PENDING_OUTBOX', 50),
    maxPendingApprovals: parsePositiveIntEnv('HEALTH_MAX_PENDING_APPROVALS', 100),
    maxFailedExecutions1h: parsePositiveIntEnv('HEALTH_MAX_FAILED_EXECUTIONS_1H', 25),
    maxRateLimitedIngest1h: parsePositiveIntEnv('HEALTH_MAX_RATE_LIMITED_INGEST_1H', 300),
    maxRateLimitedMobileLogin1h: parsePositiveIntEnv(
      'HEALTH_MAX_RATE_LIMITED_MOBILE_LOGIN_1H',
      300,
    ),
    maxRateLimitedMobileRefresh1h: parsePositiveIntEnv(
      'HEALTH_MAX_RATE_LIMITED_MOBILE_REFRESH_1H',
      300,
    ),
    maxRateLimitedMobileSyncPush1h: parsePositiveIntEnv(
      'HEALTH_MAX_RATE_LIMITED_MOBILE_SYNC_PUSH_1H',
      300,
    ),
    maxRateLimitedMobileSyncPull1h: parsePositiveIntEnv(
      'HEALTH_MAX_RATE_LIMITED_MOBILE_SYNC_PULL_1H',
      300,
    ),
    maxMobileSyncPayloadRejected1h: parsePositiveIntEnv(
      'HEALTH_MAX_MOBILE_SYNC_PAYLOAD_REJECTED_1H',
      300,
    ),
    maxRateLimitedCallWebhook1h: parsePositiveIntEnv(
      'HEALTH_MAX_RATE_LIMITED_CALL_WEBHOOK_1H',
      300,
    ),
    maxRateLimitedAgentPlaybook1h: parsePositiveIntEnv(
      'HEALTH_MAX_RATE_LIMITED_AGENT_PLAYBOOK_1H',
      300,
    ),
    maxPlaybookInflightLimitReached1h: parsePositiveIntEnv(
      'HEALTH_MAX_PLAYBOOK_INFLIGHT_LIMIT_REACHED_1H',
      120,
    ),
    maxPlaybookDuplicateInflight1h: parsePositiveIntEnv(
      'HEALTH_MAX_PLAYBOOK_DUPLICATE_INFLIGHT_1H',
      120,
    ),
    maxPlaybookRequestTimeout1h: parsePositiveIntEnv(
      'HEALTH_MAX_PLAYBOOK_REQUEST_TIMEOUT_1H',
      60,
    ),
    maxPlaybookPackLoadFailures1h: parsePositiveIntEnv(
      'HEALTH_MAX_PLAYBOOK_PACK_LOAD_FAILURES_1H',
      20,
    ),
    maxPlaybookPayloadRejected1h: parsePositiveIntEnv(
      'HEALTH_MAX_PLAYBOOK_PAYLOAD_REJECTED_1H',
      200,
    ),
    maxPlaybookFailClosedBlocked1h: parsePositiveIntEnv(
      'HEALTH_MAX_PLAYBOOK_FAIL_CLOSED_BLOCKED_1H',
      100,
    ),
    maxPlaybookGovernanceErrors1h: parsePositiveIntEnv(
      'HEALTH_MAX_PLAYBOOK_GOVERNANCE_ERRORS_1H',
      20,
    ),
    maxStaleMediaUploadSessions: parsePositiveIntEnv(
      'HEALTH_MAX_STALE_MEDIA_UPLOAD_SESSIONS',
      50,
    ),
    maxBackupAgeHours: parsePositiveIntEnv('HEALTH_MAX_BACKUP_AGE_HOURS', 30),
    maxRestoreDrillAgeHours: parsePositiveIntEnv('HEALTH_MAX_RESTORE_DRILL_AGE_HOURS', 192),
    maxRestoreDrillLockAgeMinutes: parsePositiveIntEnv(
      'HEALTH_MAX_RESTORE_DRILL_LOCK_AGE_MINUTES',
      120,
    ),
    maxRemediateLockAgeMinutes: parsePositiveIntEnv(
      'HEALTH_MAX_REMEDIATE_LOCK_AGE_MINUTES',
      30,
    ),
    maxLoadSmokeAgeHours: parsePositiveIntEnv('HEALTH_MAX_LOAD_SMOKE_AGE_HOURS', 192),
    minLoadSmokeSuccessPct: parsePositiveFloatEnv('HEALTH_MIN_LOAD_SMOKE_SUCCESS_PCT', 99),
    maxLoadSmokeP95Seconds: parsePositiveFloatEnv('HEALTH_MAX_LOAD_SMOKE_P95_SECONDS', 2.5),
    maxLoadSmokeFailsWindow: parsePositiveIntEnv('HEALTH_LOAD_SMOKE_MAX_FAILS_WINDOW', 2),
  };

  const [pendingOutbox, failedOutbox, stalePendingOutbox, pendingApprovals, failedExecutions1h, blockedExecutions24h, staleMediaUploadSessions, activeAgentRuns, latestSafetyState] =
    await Promise.all([
      prisma.eventOutbox.count({
        where: {
          orgId,
          status: OutboxStatus.PENDING,
        },
      }),
      prisma.eventOutbox.count({
        where: {
          orgId,
          status: OutboxStatus.FAILED,
        },
      }),
      prisma.eventOutbox.count({
        where: {
          orgId,
          status: OutboxStatus.PENDING,
          createdAt: { lt: staleCutoff },
        },
      }),
      prisma.approvalRequest.count({
        where: {
          orgId,
          status: ApprovalStatus.PENDING,
        },
      }),
      prisma.toolExecution.count({
        where: {
          orgId,
          status: ExecutionStatus.FAILED,
          createdAt: { gte: oneHourAgo },
        },
      }),
      prisma.toolExecution.count({
        where: {
          orgId,
          status: ExecutionStatus.BLOCKED,
          createdAt: { gte: twentyFourHoursAgo },
        },
      }),
      prisma.mediaUploadSession.count({
        where: {
          orgId,
          status: {
            in: ['INITIATED', 'FAILED'],
          },
          expiresAt: { lt: now },
        },
      }),
      prisma.agentRun.count({
        where: {
          orgId,
          status: 'RUNNING',
        },
      }),
      prisma.orgSafetyState.findUnique({
        where: { orgId },
        select: { mode: true },
      }),
    ]);
  const rateLimitedIngest1h = getRateLimitEventCount1h('ingest');
  const rateLimitedMobileLogin1h = getRateLimitEventCount1h('mobile_login');
  const rateLimitedMobileRefresh1h = getRateLimitEventCount1h('mobile_refresh');
  const rateLimitedMobileSyncPush1h = getRateLimitEventCount1h('mobile_sync_push');
  const rateLimitedMobileSyncPull1h = getRateLimitEventCount1h('mobile_sync_pull');
  const mobileSyncPayloadRejected1h = getMobileSyncPayloadRejectedEventCount1h();
  const rateLimitedCallWebhook1h = getRateLimitEventCount1h('call_webhook');
  const rateLimitedAgentPlaybook1h = getRateLimitEventCount1h('agent_playbook');
  const playbookInflightLimitReached1h = getPlaybookInflightLimitEventCount1h();
  const playbookDuplicateInflight1h = getPlaybookDuplicateInflightEventCount1h();
  const playbookRequestTimeout1h = getPlaybookRequestTimeoutEventCount1h();
  const playbookPackLoadFailures1h = getPlaybookPackLoadFailureEventCount1h();
  const playbookPayloadRejected1h = getPlaybookPayloadRejectedEventCount1h();
  const playbookFailClosedBlocked1h = getPlaybookFailClosedBlockedEventCount1h();
  const playbookGovernanceErrors1h = getPlaybookGovernanceErrorEventCount1h();

  let backupAgeHours: number | null = null;
  let backupIntegrityState: 'UNKNOWN' | 'OK' | 'INCOMPLETE' = 'UNKNOWN';
  let backupIntegrityMissingCount = 0;
  let backupManifestState: 'UNKNOWN' | 'OK' | 'INVALID' = 'UNKNOWN';
  let backupChecksumState: BackupChecksumState = 'UNKNOWN';
  let backupArchiveState: BackupArchiveState = 'UNKNOWN';
  const authJwtSecretState: 'OK' | 'INSECURE' = isJwtSecretInsecure(getJwtSecret())
    ? 'INSECURE'
    : 'OK';
  const ingestTokensState = evaluateIngestTokensHealth();
  const callWebhookSecretState = evaluateCallWebhookSecretHealth();
  const ingestIpHashSaltState = evaluateIngestIpHashSaltHealth();
  const backupDirConfig = resolveBackupDirConfig();
  const backupDir = backupDirConfig.path;
  let backupScanVisible = true;
  try {
    const entries = await readdir(backupDir, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.isDirectory() && /^[0-9]{8}T[0-9]{6}Z$/.test(entry.name))
      .map((entry) => join(backupDir, entry.name));
    let latestMtime = 0;
    let latestBackupPath: string | null = null;
    for (const candidate of candidates) {
      try {
        const info = await stat(candidate);
        if (info.mtimeMs > latestMtime) {
          latestMtime = info.mtimeMs;
          latestBackupPath = candidate;
        }
      } catch {
        // Ignore unreadable backup entry.
      }
    }
    if (latestMtime > 0) {
      backupAgeHours = Math.floor((Date.now() - latestMtime) / (60 * 60 * 1000));
      if (latestBackupPath) {
        const requiredFiles = ['postgres.sql.gz', 'minio-data.tgz', 'manifest.txt'] as const;
        const checks = await Promise.all(
          requiredFiles.map(async (name) => {
            try {
              const fileInfo = await stat(join(latestBackupPath as string, name));
              return fileInfo.size > 0;
            } catch {
              return false;
            }
          }),
        );
        backupIntegrityMissingCount = checks.filter((ok) => !ok).length;
        backupIntegrityState = backupIntegrityMissingCount > 0 ? 'INCOMPLETE' : 'OK';

        if (backupIntegrityState === 'OK') {
          try {
            const manifestText = await readFile(join(latestBackupPath, 'manifest.txt'), 'utf8');
            const manifestEntries = parseKeyValueText(manifestText);

            const manifestPostgresFile = manifestEntries.get('postgres_file') ?? '';
            const manifestPostgresSha = manifestEntries.get('postgres_sha256') ?? '';
            const manifestMinioFile = manifestEntries.get('minio_file') ?? '';
            const manifestMinioSha = manifestEntries.get('minio_sha256') ?? '';
            if (!manifestPostgresFile || !manifestPostgresSha || !manifestMinioFile || !manifestMinioSha) {
              backupManifestState = 'INVALID';
            } else {
              const referencedChecks = await Promise.all(
                [manifestPostgresFile, manifestMinioFile].map(async (name) => {
                  try {
                    const fileInfo = await stat(join(latestBackupPath as string, name));
                    return fileInfo.size > 0;
                  } catch {
                    return false;
                  }
                }),
              );
              backupManifestState = referencedChecks.every(Boolean) ? 'OK' : 'INVALID';
              if (backupManifestState === 'OK') {
                backupChecksumState = await evaluateBackupChecksums({
                  backupPath: latestBackupPath,
                  postgresFile: manifestPostgresFile,
                  postgresSha: manifestPostgresSha,
                  minioFile: manifestMinioFile,
                  minioSha: manifestMinioSha,
                });
                if (backupChecksumState === 'OK') {
                  backupArchiveState = await evaluateBackupArchiveState({
                    backupPath: latestBackupPath,
                    postgresFile: manifestPostgresFile,
                    minioFile: manifestMinioFile,
                    postgresSha: manifestPostgresSha,
                    minioSha: manifestMinioSha,
                  });
                } else if (backupChecksumState === 'MISMATCH' || backupChecksumState === 'UNAVAILABLE') {
                  backupArchiveState = 'UNKNOWN';
                }
              }
            }
          } catch {
            backupManifestState = 'INVALID';
          }
        }
      }
    }
  } catch {
    backupScanVisible = false;
    backupAgeHours = null;
    backupIntegrityState = 'UNKNOWN';
    backupIntegrityMissingCount = 0;
  }

  const issues: HealthIssue[] = [];
  if (pendingOutbox > thresholds.maxPendingOutbox) {
    issues.push({
      level: 'WARN',
      key: 'outbox_pending_high',
      message: `Pending outbox is high: ${pendingOutbox} (limit ${thresholds.maxPendingOutbox})`,
    });
  }
  if (failedOutbox > thresholds.maxFailedOutbox) {
    issues.push({
      level: 'WARN',
      key: 'outbox_failed_high',
      message: `Failed outbox is high: ${failedOutbox} (limit ${thresholds.maxFailedOutbox})`,
    });
  }
  if (stalePendingOutbox > thresholds.maxStalePendingOutbox) {
    issues.push({
      level: 'WARN',
      key: 'outbox_stale_pending_high',
      message: `Stale pending outbox is high: ${stalePendingOutbox} older than ${thresholds.maxStalePendingOutboxMinutes}m (limit ${thresholds.maxStalePendingOutbox})`,
    });
  }
  if (pendingApprovals > thresholds.maxPendingApprovals) {
    issues.push({
      level: 'WARN',
      key: 'pending_approvals_high',
      message: `Pending approvals are high: ${pendingApprovals} (limit ${thresholds.maxPendingApprovals})`,
    });
  }
  if (failedExecutions1h > thresholds.maxFailedExecutions1h) {
    issues.push({
      level: 'WARN',
      key: 'failed_executions_high',
      message: `Failed executions in 1h are high: ${failedExecutions1h} (limit ${thresholds.maxFailedExecutions1h})`,
    });
  }
  if (rateLimitedIngest1h > thresholds.maxRateLimitedIngest1h) {
    issues.push({
      level: 'WARN',
      key: 'ingest_rate_limited_high',
      message: `Ingest 429 events in 1h are high: ${rateLimitedIngest1h} (limit ${thresholds.maxRateLimitedIngest1h})`,
    });
  }
  if (rateLimitedMobileLogin1h > thresholds.maxRateLimitedMobileLogin1h) {
    issues.push({
      level: 'WARN',
      key: 'mobile_login_rate_limited_high',
      message: `Mobile PIN login 429 events in 1h are high: ${rateLimitedMobileLogin1h} (limit ${thresholds.maxRateLimitedMobileLogin1h})`,
    });
  }
  if (rateLimitedMobileRefresh1h > thresholds.maxRateLimitedMobileRefresh1h) {
    issues.push({
      level: 'WARN',
      key: 'mobile_refresh_rate_limited_high',
      message: `Mobile token refresh 429 events in 1h are high: ${rateLimitedMobileRefresh1h} (limit ${thresholds.maxRateLimitedMobileRefresh1h})`,
    });
  }
  if (rateLimitedMobileSyncPush1h > thresholds.maxRateLimitedMobileSyncPush1h) {
    issues.push({
      level: 'WARN',
      key: 'mobile_sync_push_rate_limited_high',
      message: `Mobile sync push 429 events in 1h are high: ${rateLimitedMobileSyncPush1h} (limit ${thresholds.maxRateLimitedMobileSyncPush1h})`,
    });
  }
  if (rateLimitedMobileSyncPull1h > thresholds.maxRateLimitedMobileSyncPull1h) {
    issues.push({
      level: 'WARN',
      key: 'mobile_sync_pull_rate_limited_high',
      message: `Mobile sync pull 429 events in 1h are high: ${rateLimitedMobileSyncPull1h} (limit ${thresholds.maxRateLimitedMobileSyncPull1h})`,
    });
  }
  if (mobileSyncPayloadRejected1h > thresholds.maxMobileSyncPayloadRejected1h) {
    issues.push({
      level: 'WARN',
      key: 'mobile_sync_payload_rejected_high',
      message: `Mobile sync payload rejections in 1h are high: ${mobileSyncPayloadRejected1h} (limit ${thresholds.maxMobileSyncPayloadRejected1h})`,
    });
  }
  if (rateLimitedCallWebhook1h > thresholds.maxRateLimitedCallWebhook1h) {
    issues.push({
      level: 'WARN',
      key: 'call_webhook_rate_limited_high',
      message: `Call webhook 429 events in 1h are high: ${rateLimitedCallWebhook1h} (limit ${thresholds.maxRateLimitedCallWebhook1h})`,
    });
  }
  if (rateLimitedAgentPlaybook1h > thresholds.maxRateLimitedAgentPlaybook1h) {
    issues.push({
      level: 'WARN',
      key: 'agent_playbook_rate_limited_high',
      message: `Agent playbook 429 events in 1h are high: ${rateLimitedAgentPlaybook1h} (limit ${thresholds.maxRateLimitedAgentPlaybook1h})`,
    });
  }
  if (
    playbookInflightLimitReached1h > thresholds.maxPlaybookInflightLimitReached1h
  ) {
    issues.push({
      level: 'WARN',
      key: 'agent_playbook_inflight_limit_high',
      message: `Agent playbook saturation events in 1h are high: ${playbookInflightLimitReached1h} (limit ${thresholds.maxPlaybookInflightLimitReached1h})`,
    });
  }
  if (playbookDuplicateInflight1h > thresholds.maxPlaybookDuplicateInflight1h) {
    issues.push({
      level: 'WARN',
      key: 'agent_playbook_duplicate_inflight_high',
      message: `Agent playbook duplicate in-flight rejections in 1h are high: ${playbookDuplicateInflight1h} (limit ${thresholds.maxPlaybookDuplicateInflight1h})`,
    });
  }
  if (playbookRequestTimeout1h > thresholds.maxPlaybookRequestTimeout1h) {
    issues.push({
      level: 'WARN',
      key: 'agent_playbook_timeout_high',
      message: `Agent playbook timeout events in 1h are high: ${playbookRequestTimeout1h} (limit ${thresholds.maxPlaybookRequestTimeout1h})`,
    });
  }
  if (playbookPackLoadFailures1h > thresholds.maxPlaybookPackLoadFailures1h) {
    issues.push({
      level: 'WARN',
      key: 'agent_playbook_pack_load_failed_high',
      message: `Agent playbook pack-load failures in 1h are high: ${playbookPackLoadFailures1h} (limit ${thresholds.maxPlaybookPackLoadFailures1h})`,
    });
  }
  if (playbookPayloadRejected1h > thresholds.maxPlaybookPayloadRejected1h) {
    issues.push({
      level: 'WARN',
      key: 'agent_playbook_payload_rejected_high',
      message: `Agent playbook payload rejections in 1h are high: ${playbookPayloadRejected1h} (limit ${thresholds.maxPlaybookPayloadRejected1h})`,
    });
  }
  if (playbookFailClosedBlocked1h > thresholds.maxPlaybookFailClosedBlocked1h) {
    issues.push({
      level: 'WARN',
      key: 'agent_playbook_fail_closed_high',
      message: `Agent playbook fail-closed denials in 1h are high: ${playbookFailClosedBlocked1h} (limit ${thresholds.maxPlaybookFailClosedBlocked1h})`,
    });
  }
  if (playbookGovernanceErrors1h > thresholds.maxPlaybookGovernanceErrors1h) {
    issues.push({
      level: 'WARN',
      key: 'agent_playbook_governance_unavailable_high',
      message: `Agent playbook governance gate errors in 1h are high: ${playbookGovernanceErrors1h} (limit ${thresholds.maxPlaybookGovernanceErrors1h})`,
    });
  }
  if (staleMediaUploadSessions > thresholds.maxStaleMediaUploadSessions) {
    issues.push({
      level: 'WARN',
      key: 'media_upload_sessions_stale_high',
      message: `Stale media upload sessions are high: ${staleMediaUploadSessions} expired-but-open sessions (limit ${thresholds.maxStaleMediaUploadSessions})`,
    });
  }
  if (
    latestSafetyState?.mode &&
    latestSafetyState.mode !== 'NORMAL'
  ) {
    issues.push({
      level: 'WARN',
      key: 'kill_switch_non_normal',
      message: `Kill switch mode is ${latestSafetyState.mode}`,
    });
  }
  if (backupAgeHours === null) {
    if (backupDirConfig.explicit) {
      issues.push({
        level: 'CRITICAL',
        key: backupScanVisible ? 'backup_missing' : 'backup_dir_missing',
        message: backupScanVisible
          ? `No backup snapshot directory found in ${backupDir}`
          : `Configured BACKUP_DIR is not readable: ${backupDir}`,
      });
    } else {
      issues.push({
        level: 'WARN',
        key: 'backup_visibility_unconfigured',
        message: `BACKUP_DIR is not configured or not readable (checked ${backupDir}); set BACKUP_DIR for strict backup health checks.`,
      });
    }
  } else if (backupAgeHours > thresholds.maxBackupAgeHours) {
    issues.push({
      level: 'CRITICAL',
      key: 'backup_stale',
      message: `Latest backup is stale: ${backupAgeHours}h (limit ${thresholds.maxBackupAgeHours}h)`,
    });
  }
  if (backupAgeHours !== null && backupIntegrityState === 'INCOMPLETE') {
    issues.push({
      level: 'CRITICAL',
      key: 'backup_incomplete',
      message: `Latest backup snapshot is incomplete (missing files: ${backupIntegrityMissingCount}).`,
    });
  }
  if (backupAgeHours !== null && backupManifestState === 'INVALID') {
    issues.push({
      level: 'CRITICAL',
      key: 'backup_manifest_invalid',
      message: 'Latest backup manifest is invalid or references missing payload files.',
    });
  }
  if (backupAgeHours !== null && backupChecksumState === 'MISMATCH') {
    issues.push({
      level: 'CRITICAL',
      key: 'backup_checksum_mismatch',
      message: 'Latest backup checksum validation failed against manifest.',
    });
  }
  if (backupAgeHours !== null && backupChecksumState === 'UNAVAILABLE') {
    issues.push({
      level: 'WARN',
      key: 'backup_checksum_unavailable',
      message: 'Unable to validate backup checksums on this node.',
    });
  }
  if (backupAgeHours !== null && backupArchiveState === 'CORRUPT') {
    issues.push({
      level: 'CRITICAL',
      key: 'backup_archive_corrupt',
      message: 'Latest backup archive structure validation failed.',
    });
  }
  if (backupAgeHours !== null && backupArchiveState === 'UNAVAILABLE') {
    issues.push({
      level: 'WARN',
      key: 'backup_archive_unavailable',
      message: 'Unable to validate backup archive structure on this node.',
    });
  }
  if (authJwtSecretState === 'INSECURE') {
    issues.push({
      level: 'CRITICAL',
      key: 'auth_jwt_secret_insecure',
      message: 'JWT_SECRET is default or too weak; set a strong 32+ character secret.',
    });
  }
  if (ingestTokensState === 'MISSING') {
    issues.push({
      level: 'WARN',
      key: 'ingest_tokens_missing',
      message: 'MBS_INGEST_TOKENS is not configured; website intake endpoints are unavailable.',
    });
  } else if (ingestTokensState === 'INSECURE') {
    issues.push({
      level: 'WARN',
      key: 'ingest_tokens_insecure',
      message: 'MBS_INGEST_TOKENS includes weak token values; rotate to strong random tokens.',
    });
  }
  if (callWebhookSecretState === 'MISSING') {
    issues.push({
      level: 'WARN',
      key: 'call_webhook_secret_missing',
      message: 'CALL_WEBHOOK_SECRET is not configured; call webhook ingestion is unavailable.',
    });
  } else if (callWebhookSecretState === 'INSECURE') {
    issues.push({
      level: 'WARN',
      key: 'call_webhook_secret_insecure',
      message: 'CALL_WEBHOOK_SECRET is too weak; rotate to a strong random secret.',
    });
  }
  if (ingestIpHashSaltState === 'MISSING') {
    issues.push({
      level: 'WARN',
      key: 'ingest_ip_hash_salt_missing',
      message:
        'MBS_IP_HASH_SALT is not configured; intake IP hashing uses an insecure default salt.',
    });
  } else if (ingestIpHashSaltState === 'INSECURE') {
    issues.push({
      level: 'WARN',
      key: 'ingest_ip_hash_salt_insecure',
      message:
        'MBS_IP_HASH_SALT is weak or default; rotate to a strong random salt value.',
    });
  }

  const restoreDrillStatus = await loadRestoreDrillStatus(now);
  const restoreDrillLockStatus = await loadRestoreDrillLockStatus(now);
  const remediateLockStatus = await loadRemediateLockStatus(now);
  if (restoreDrillStatus.state === 'MISSING') {
    issues.push({
      level: 'WARN',
      key: 'restore_drill_missing',
      message: `Restore drill marker not found at ${restoreDrillStatus.path}; run a restore drill.`,
    });
  } else if (restoreDrillStatus.state === 'INVALID') {
    issues.push({
      level: 'WARN',
      key: 'restore_drill_invalid',
      message: `Restore drill marker is invalid at ${restoreDrillStatus.path}; rerun restore drill.`,
    });
  } else if (restoreDrillStatus.state === 'FAILED') {
    issues.push({
      level: 'WARN',
      key: 'restore_drill_failed',
      message: `Restore drill marker reports failed status (${restoreDrillStatus.status ?? 'failed'}) at ${restoreDrillStatus.path}; rerun restore drill.`,
    });
  } else if (
    restoreDrillStatus.ageHours !== null &&
    restoreDrillStatus.ageHours > thresholds.maxRestoreDrillAgeHours
  ) {
    issues.push({
      level: 'WARN',
      key: 'restore_drill_stale',
      message: `Restore drill is stale: ${restoreDrillStatus.ageHours}h (limit ${thresholds.maxRestoreDrillAgeHours}h).`,
    });
  }
  if (restoreDrillLockStatus.state === 'STALE') {
    issues.push({
      level: 'WARN',
      key: 'restore_drill_lock_stale',
      message: `Restore drill lock appears stale at ${restoreDrillLockStatus.path}: ${restoreDrillLockStatus.ageMinutes}m (limit ${thresholds.maxRestoreDrillLockAgeMinutes}m).`,
    });
  }
  if (remediateLockStatus.state === 'STALE') {
    issues.push({
      level: 'WARN',
      key: 'remediate_lock_stale',
      message: `Health remediation lock appears stale at ${remediateLockStatus.path}: ${remediateLockStatus.ageMinutes}m (limit ${thresholds.maxRemediateLockAgeMinutes}m).`,
    });
  }

  const loadSmokeStatus = await loadLoadSmokeStatus(now);
  const loadSmokeTrend = await loadLoadSmokeTrend();
  if (loadSmokeStatus.state === 'MISSING') {
    issues.push({
      level: 'WARN',
      key: 'load_smoke_missing',
      message: `Load smoke marker not found at ${loadSmokeStatus.path}; run load smoke baseline.`,
    });
  } else if (loadSmokeStatus.state === 'INVALID') {
    issues.push({
      level: 'WARN',
      key: 'load_smoke_marker_invalid',
      message: `Load smoke marker is invalid at ${loadSmokeStatus.path}; rerun load smoke baseline.`,
    });
  } else {
    if (loadSmokeStatus.status && loadSmokeStatus.status.toLowerCase() !== 'success') {
      issues.push({
        level: 'WARN',
        key: 'load_smoke_failed',
        message: `Load smoke marker reports non-success status (${loadSmokeStatus.status}) at ${loadSmokeStatus.path}.`,
      });
    }
    if (
      loadSmokeStatus.ageHours !== null &&
      loadSmokeStatus.ageHours > thresholds.maxLoadSmokeAgeHours
    ) {
      issues.push({
        level: 'WARN',
        key: 'load_smoke_stale',
        message: `Load smoke baseline is stale: ${loadSmokeStatus.ageHours}h (limit ${thresholds.maxLoadSmokeAgeHours}h).`,
      });
    }
    if (
      loadSmokeStatus.successPct !== null &&
      loadSmokeStatus.successPct < thresholds.minLoadSmokeSuccessPct
    ) {
      issues.push({
        level: 'WARN',
        key: 'load_smoke_regressed',
        message: `Load smoke success rate is below threshold: ${loadSmokeStatus.successPct.toFixed(2)}% (min ${thresholds.minLoadSmokeSuccessPct}%).`,
      });
    }
    if (
      loadSmokeStatus.p95Seconds !== null &&
      loadSmokeStatus.p95Seconds > thresholds.maxLoadSmokeP95Seconds
    ) {
      issues.push({
        level: 'WARN',
        key: 'load_smoke_latency_high',
        message: `Load smoke p95 latency is high: ${loadSmokeStatus.p95Seconds.toFixed(3)}s (max ${thresholds.maxLoadSmokeP95Seconds}s).`,
      });
    }
  }
  if (loadSmokeTrend.window > 0 && loadSmokeTrend.failCount > thresholds.maxLoadSmokeFailsWindow) {
    issues.push({
      level: 'WARN',
      key: 'load_smoke_trend_failed',
      message: `Load smoke trend shows repeated failures: ${loadSmokeTrend.failCount}/${loadSmokeTrend.window} failing runs (max ${thresholds.maxLoadSmokeFailsWindow}).`,
    });
  }

  return {
    generatedAt: now.toISOString(),
    status: deriveOverallHealthStatus(issues),
    metrics: {
      pendingOutbox,
      failedOutbox,
      stalePendingOutbox,
      pendingApprovals,
      failedExecutions1h,
      rateLimitedIngest1h,
      rateLimitedMobileLogin1h,
      rateLimitedMobileRefresh1h,
      rateLimitedMobileSyncPush1h,
      rateLimitedMobileSyncPull1h,
      mobileSyncPayloadRejected1h,
      rateLimitedCallWebhook1h,
      rateLimitedAgentPlaybook1h,
      playbookInflightLimitReached1h,
      playbookDuplicateInflight1h,
      playbookRequestTimeout1h,
      playbookPackLoadFailures1h,
      playbookPayloadRejected1h,
      playbookFailClosedBlocked1h,
      playbookGovernanceErrors1h,
      staleMediaUploadSessions,
      blockedExecutions24h,
      activeAgentRuns,
      killSwitchMode: latestSafetyState?.mode ?? 'UNKNOWN',
      backupAgeHours,
      backupIntegrityState,
      backupIntegrityMissingCount,
      backupManifestState,
      backupChecksumState,
      backupArchiveState,
      authJwtSecretState,
      ingestTokensState,
      callWebhookSecretState,
      ingestIpHashSaltState,
      restoreDrillAgeHours: restoreDrillStatus.ageHours,
      restoreDrillStatus: restoreDrillStatus.status,
      restoreDrillLockStatus: restoreDrillLockStatus.state,
      restoreDrillLockAgeMinutes: restoreDrillLockStatus.ageMinutes,
      remediateLockStatus: remediateLockStatus.state,
      remediateLockAgeMinutes: remediateLockStatus.ageMinutes,
      loadSmokeAgeHours: loadSmokeStatus.ageHours,
      loadSmokeStatus: loadSmokeStatus.status,
      loadSmokeSuccessPct: loadSmokeStatus.successPct,
      loadSmokeP95Seconds: loadSmokeStatus.p95Seconds,
      loadSmokeTrendFailCount: loadSmokeTrend.failCount,
      loadSmokeTrendWindow: loadSmokeTrend.window,
    },
    thresholds,
    issues,
  };
}

function rangeStartDate(days: number, now: Date = new Date()): Date {
  const start = startOfUtcDay(now);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return start;
}

function utcDateKey(date: Date): string {
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function getExposureToday(orgId: string, at: Date = new Date()) {
  const activePolicy = await prisma.policy.findFirst({
    where: { orgId, isActive: true },
    orderBy: [{ version: 'desc' }, { createdAt: 'desc' }],
  });

  const policy = (activePolicy?.policyJson ?? {}) as Record<string, any>;
  const dailyExposure = policy?.financial?.dailyExposure as
    | {
        timezone?: string;
        limits?: Record<string, number>;
      }
    | undefined;

  const timezone = dailyExposure?.timezone ?? 'America/Denver';
  const dateKey = localDateKey(at, timezone);
  const limits = dailyExposure?.limits ?? {};
  const buckets = Object.entries(limits);

  if (buckets.length === 0) {
    return {
      date: dateKey,
      timezone,
      buckets: [],
      policy: activePolicy
        ? {
            id: activePolicy.id,
            name: activePolicy.name,
            version: activePolicy.version,
          }
        : null,
    };
  }

  const rows = await prisma.financialExposureDaily.findMany({
    where: {
      orgId,
      date: new Date(`${dateKey}T00:00:00.000Z`),
      bucket: { in: buckets.map(([bucket]) => bucket) },
    },
  });
  const usedByBucket = new Map(rows.map((row) => [row.bucket, row.usedCents]));

  return {
    date: dateKey,
    timezone,
    buckets: buckets.map(([bucket, limitValue]) => {
      const limitCents = Number(limitValue) || 0;
      const usedCents = usedByBucket.get(bucket) ?? 0;
      return {
        bucket,
        limitCents,
        usedCents,
        remainingCents: Math.max(0, limitCents - usedCents),
      };
    }),
    policy: activePolicy
      ? {
          id: activePolicy.id,
          name: activePolicy.name,
          version: activePolicy.version,
        }
      : null,
  };
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, nestedValue]) => {
        const lower = key.toLowerCase();
        if (
          lower.includes('secret') ||
          lower.includes('token') ||
          lower.includes('password') ||
          lower.includes('apikey') ||
          lower.includes('api_key')
        ) {
          return [key, '[REDACTED]'];
        }

        return [key, redactSecrets(nestedValue)];
      },
    );

    return Object.fromEntries(entries);
  }

  return value;
}

function getPayloadStringField(
  payload: unknown,
  key: 'leadId' | 'customerId',
): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }

  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function getStateStringField(stateJson: unknown, key: string): string | undefined {
  if (!stateJson || typeof stateJson !== 'object' || Array.isArray(stateJson)) {
    return undefined;
  }

  const value = (stateJson as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function getStoredDecision(outputPayload: unknown) {
  if (!outputPayload || typeof outputPayload !== 'object' || Array.isArray(outputPayload)) {
    return null;
  }

  const decision = (outputPayload as Record<string, unknown>).decision;
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    return null;
  }

  return decision;
}

function summarizePolicy(policy: { id: string; name: string; version: number; policyJson: unknown } | null) {
  if (!policy) {
    return null;
  }

  const json = (policy.policyJson ?? {}) as Record<string, any>;
  const autonomy = (json.autonomy ?? {}) as Record<string, any>;

  return {
    id: policy.id,
    name: policy.name,
    version: policy.version,
    autonomyEnabled: autonomy.enabled !== false,
    defaultMode: autonomy.defaultMode ?? null,
    maxRiskLevelAutonomous: autonomy.maxRiskLevelAutonomous ?? null,
    blockedToolsCount:
      (autonomy?.toolBlocks?.deny?.length ?? 0) +
      (autonomy?.toolBlocks?.denyIfAutonomous?.length ?? 0),
    timeWindowCount: autonomy?.timeWindows?.length ?? 0,
  };
}

function sanitizeQuoteOptionForViewer(
  option: Record<string, any>,
  access: { canSeeCostDetails: boolean; canSeeMarginDetails: boolean },
) {
  const base = {
    id: option.id,
    orgId: option.orgId,
    quoteId: option.quoteId,
    optionKey: option.optionKey,
    label: option.label,
    pricingMode: option.pricingMode,
    priceBeforeDiscountCents: option.priceBeforeDiscountCents,
    discountPctBps: option.discountPctBps,
    discountCents: option.discountCents,
    discountTotalCents: option.discountTotalCents,
    discountReason: option.discountReason,
    finalSellPriceCents: option.finalSellPriceCents,
    guardrailStatus: option.guardrailStatus,
    guardrailReasons: option.guardrailReasons,
    metadata: option.metadata,
    createdAt: option.createdAt,
    updatedAt: option.updatedAt,
  };

  if (access.canSeeCostDetails) {
    Object.assign(base, {
      cushionPct: option.cushionPct,
      equipmentAdjustedCents: option.equipmentAdjustedCents,
      materialsAdjustedCents: option.materialsAdjustedCents,
      laborTotalCents: option.laborTotalCents,
      adjustedCostCents: option.adjustedCostCents,
      profitFloorCents: option.profitFloorCents,
      accessAddOnCents: option.accessAddOnCents,
      basePriceCents: option.basePriceCents,
      salesCushionPct: option.salesCushionPct,
      rawCostTotalCents: option.rawCostTotalCents,
      equipmentSelection: option.equipmentSelection,
      materialsSelection: option.materialsSelection,
    });
  }

  if (access.canSeeMarginDetails) {
    Object.assign(base, {
      effectiveProfitCents: option.effectiveProfitCents,
      effectiveMarginBps: option.effectiveMarginBps,
    });
  }

  return base;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'api' });
});

app.get('/api/me', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, slug: true, name: true },
    });
    if (!org) {
      throw new Error('Organization not found');
    }

    const user = await resolveActorUser(req, orgId);
    if (!user) {
      res.status(404).json({ error: 'No active user found for organization' });
      return;
    }

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

    const roles = roleLinks.map((link) => link.role.name);
    const permissions = [...new Set(roleLinks.flatMap((link) =>
      link.role.rolePermissions.map((rp) => rp.permission.key),
    ))].sort();

    res.json({
      org,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        actorType: user.actorType,
      },
      roles,
      permissions,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.get('/api/users/lead-owners', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireAnyPermission(req, orgId, [
      'crm:lead:read',
      'crm:lead:write',
      'crm:read',
      'crm:write',
      'crm:*',
      '*',
    ]);

    const users = await prisma.user.findMany({
      where: {
        orgId,
        isActive: true,
        actorType: ActorType.HUMAN,
      },
      include: {
        userRoles: {
          include: {
            role: true,
          },
        },
      },
      orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
      take: 200,
    });

    const ownerCandidates = users
      .map((user) => {
        const roleNames = user.userRoles.map((link) => link.role.name.toLowerCase());
        const allowed = roleNames.some((role) =>
          role === 'owner' ||
          role === 'admin' ||
          role === 'sales_rep' ||
          role === 'dispatcher' ||
          role.includes('manager'),
        );
        return {
          id: user.id,
          name: user.name,
          email: user.email,
          roles: roleNames,
          allowed,
        };
      })
      .filter((row) => row.allowed)
      .map(({ allowed: _allowed, ...rest }) => rest);

    res.json({ users: ownerCandidates });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/auth/mobile/pin/login', async (req, res) => {
  try {
    const parsed = mobilePinLoginSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        code: 'AUTH_PIN_INVALID_PAYLOAD',
        message: 'Invalid mobile PIN login payload',
        details: zodIssues(parsed.error),
      });
      return;
    }
    const input = parsed.data;
    const sourceIp = getIngestSourceIp(req);
    if (!applyMobileLoginRateLimit(input.identifier, sourceIp)) {
      recordRateLimitEvent('mobile_login');
      const retryAfterSeconds = getRateLimitRetryAfterSeconds(
        'MOBILE_PIN_RATE_LIMIT_WINDOW_MS',
        300000,
      );
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({
        code: 'AUTH_PIN_RATE_LIMITED',
        message: 'Too many PIN login attempts. Please try again shortly.',
        recoverable: true,
        retryAfterSeconds,
      });
      return;
    }
    const org = await prisma.organization.findUnique({
      where: { slug: input.orgSlug },
      select: { id: true, slug: true, name: true },
    });
    if (!org) {
      res.status(401).json({
        code: 'AUTH_INVALID_CREDENTIALS',
        message: 'Invalid organization, identifier, or PIN.',
        recoverable: true,
      });
      return;
    }

    const execution = await registry.execute(
      'auth.mobile.pin.login',
      {
        orgSlug: input.orgSlug,
        identifier: input.identifier,
        pin: input.pin,
        deviceId: input.deviceId,
        deviceName: input.deviceName,
      },
      {
        orgId: org.id,
        actorType: ActorType.HUMAN,
        actorLabel: 'api-mobile-pin-login',
        isAutonomous: false,
        reason: 'Mobile PIN login',
      },
    );

    if (execution.status !== 'EXECUTED') {
      const message =
        execution.status === 'BLOCKED'
          ? execution.reason
          : execution.status === 'FAILED'
            ? execution.error
            : 'Login request queued for approval and cannot proceed';
      res.status(401).json({
        code:
          execution.status === 'FAILED'
            ? execution.errorCode ?? 'AUTH_LOGIN_FAILED'
            : execution.status === 'QUEUED_APPROVAL'
              ? 'AUTH_LOGIN_REQUIRES_APPROVAL'
              : 'AUTH_LOGIN_BLOCKED',
        message,
        recoverable: execution.status === 'FAILED' ? execution.recoverable ?? true : false,
      });
      return;
    }

    const output = getExecutionOutputObject(execution.output);
    const authenticated = output.authenticated === true;
    if (!authenticated) {
      res.status(401).json({
        code: typeof output.code === 'string' ? output.code : 'AUTH_INVALID_CREDENTIALS',
        message:
          typeof output.message === 'string'
            ? output.message
            : 'Invalid organization, identifier, or PIN.',
        recoverable:
          typeof output.recoverable === 'boolean' ? output.recoverable : true,
        lockedUntil:
          typeof output.lockedUntil === 'string'
            ? output.lockedUntil
            : null,
        failedAttempts:
          typeof output.failedAttempts === 'number'
            ? output.failedAttempts
            : undefined,
      });
      return;
    }

    const user = (output.user && typeof output.user === 'object' && !Array.isArray(output.user))
      ? (output.user as Record<string, unknown>)
      : {};
    const userId = typeof user.id === 'string' ? user.id : null;
    if (!userId) {
      throw new Error('PIN login tool did not return user id');
    }

    const roles = Array.isArray(output.roles)
      ? output.roles.map((value) => String(value))
      : [];
    const permissions = Array.isArray(output.permissions)
      ? output.permissions.map((value) => String(value))
      : [];
    const mobilePinVersion = deriveMobilePinVersion(
      typeof user.mobilePinUpdatedAt === 'string' ? user.mobilePinUpdatedAt : null,
    );

    const accessTokenPayload: MobileAccessJwtPayload = {
      type: 'mobile_access',
      sub: userId,
      orgId: org.id,
      orgSlug: org.slug,
      deviceId: input.deviceId,
      pinVersion: mobilePinVersion,
    };
    const access = issueMobileAccessToken(accessTokenPayload);
    const refreshToken = issueMobileRefreshToken({
      sub: userId,
      orgId: org.id,
      orgSlug: org.slug,
      deviceId: input.deviceId,
      pinVersion: mobilePinVersion,
    });

    res.json({
      accessToken: access.token,
      refreshToken,
      expiresAt: access.expiresAt,
      org: {
        id: org.id,
        slug: org.slug,
        name: org.name,
      },
      user: {
        id: userId,
        email: typeof user.email === 'string' ? user.email : null,
        name: typeof user.name === 'string' ? user.name : null,
        actorType: typeof user.actorType === 'string' ? user.actorType : 'HUMAN',
        mobilePinResetRequired: user.mobilePinResetRequired === true,
      },
      roles,
      permissions,
      device: {
        id: input.deviceId,
        name: input.deviceName ?? null,
      },
    });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/auth/mobile/refresh', async (req, res) => {
  try {
    const parsed = mobileTokenRefreshSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        code: 'AUTH_REFRESH_INVALID_PAYLOAD',
        message: 'Invalid mobile refresh payload',
        details: zodIssues(parsed.error),
      });
      return;
    }
    const input = parsed.data;
    const sourceIp = getIngestSourceIp(req);
    if (!applyMobileRefreshRateLimit(input.deviceId, sourceIp)) {
      recordRateLimitEvent('mobile_refresh');
      const retryAfterSeconds = getRateLimitRetryAfterSeconds(
        'MOBILE_REFRESH_RATE_LIMIT_WINDOW_MS',
        300000,
      );
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({
        code: 'AUTH_REFRESH_RATE_LIMITED',
        message: 'Too many refresh attempts. Please try again shortly.',
        recoverable: true,
        retryAfterSeconds,
      });
      return;
    }

    let refreshPayload: MobileRefreshJwtPayload;
    try {
      refreshPayload = verifyMobileRefreshToken(input.refreshToken);
    } catch {
      res.status(401).json({
        code: 'AUTH_REFRESH_INVALID_TOKEN',
        message: 'Invalid or expired refresh token',
        recoverable: true,
      });
      return;
    }

    if (refreshPayload.deviceId !== input.deviceId) {
      res.status(403).json({
        code: 'AUTH_REFRESH_DEVICE_MISMATCH',
        message: 'Refresh token is bound to a different deviceId',
        recoverable: true,
      });
      return;
    }

    const user = await prisma.user.findFirst({
      where: {
        id: refreshPayload.sub,
        orgId: refreshPayload.orgId,
        isActive: true,
        actorType: ActorType.HUMAN,
      },
      include: {
        organization: {
          select: {
            id: true,
            slug: true,
            name: true,
          },
        },
        userRoles: {
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
        },
        mobileClients: {
          where: {
            deviceId: input.deviceId,
          },
          select: {
            id: true,
          },
          take: 1,
        },
      },
    });

    if (!user || user.organization.slug !== refreshPayload.orgSlug) {
      res.status(401).json({
        code: 'AUTH_REFRESH_SESSION_INVALID',
        message: 'Mobile user session no longer valid',
        recoverable: false,
      });
      return;
    }
    const currentPinVersion = deriveMobilePinVersion(user.mobilePinUpdatedAt);
    if (currentPinVersion !== refreshPayload.pinVersion) {
      res.status(401).json({
        code: 'AUTH_REFRESH_PIN_STATE_CHANGED',
        message: 'PIN was changed. Please sign in again.',
        recoverable: true,
      });
      return;
    }
    if (!Array.isArray(user.mobileClients) || user.mobileClients.length === 0) {
      res.status(401).json({
        code: 'AUTH_REFRESH_SESSION_INVALID',
        message: 'Mobile user session no longer valid',
        recoverable: false,
      });
      return;
    }

    const roles = user.userRoles.map((link) => link.role.name);
    const permissions = [...new Set(user.userRoles.flatMap((link) =>
      link.role.rolePermissions.map((rp) => rp.permission.key),
    ))].sort();

    const access = issueMobileAccessToken({
      type: 'mobile_access',
      sub: user.id,
      orgId: user.organization.id,
      orgSlug: user.organization.slug,
      deviceId: input.deviceId,
      pinVersion: currentPinVersion,
    });
    const refreshToken = issueMobileRefreshToken({
      sub: user.id,
      orgId: user.organization.id,
      orgSlug: user.organization.slug,
      deviceId: input.deviceId,
      pinVersion: currentPinVersion,
    });

    res.json({
      accessToken: access.token,
      refreshToken,
      expiresAt: access.expiresAt,
      org: {
        id: user.organization.id,
        slug: user.organization.slug,
        name: user.organization.name,
      },
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        actorType: user.actorType,
        mobilePinResetRequired: user.mobilePinResetRequired,
      },
      roles,
      permissions,
      device: {
        id: input.deviceId,
      },
    });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/admin/users/:id/pin/set', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['auth:mobile:pin:set', '*']);
    const parsed = mobilePinSetSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        code: 'AUTH_PIN_SET_INVALID_PAYLOAD',
        message: 'Invalid mobile PIN set payload',
        details: zodIssues(parsed.error),
      });
      return;
    }
    const input = parsed.data;

    const result = await registry.execute(
      'auth.mobile.pin.set',
      {
        userId: req.params.id,
        newPin: input.newPin,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-admin-pin-set',
        isAutonomous: false,
        reason: input.reason ?? 'Admin set mobile PIN',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 200
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/admin/users/:id/pin/reset', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['auth:mobile:pin:reset', '*']);
    const parsed = mobilePinResetSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        code: 'AUTH_PIN_RESET_INVALID_PAYLOAD',
        message: 'Invalid mobile PIN reset payload',
        details: zodIssues(parsed.error),
      });
      return;
    }
    const input = parsed.data;

    const result = await registry.execute(
      'auth.mobile.pin.reset',
      {
        userId: req.params.id,
        temporaryPin: input.temporaryPin,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-admin-pin-reset',
        isAutonomous: false,
        reason: input.reason ?? 'Admin reset mobile PIN',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 200
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/mobile/sync/push', async (req, res) => {
  try {
    const mobileSession = await requireMobileSession(req);
    const orgId = mobileSession.orgId;
    const grantedPermissions = await resolveUserPermissions(mobileSession.user.id);
    const canSync = ['mobile:sync', '*'].some((required) =>
      grantedPermissions.some((granted) => permissionCovers(required, granted)),
    );
    if (!canSync) {
      res.status(403).json(
        mobileSyncEndpointErrorResponse({
          status: 403,
          message: 'Forbidden: missing required permissions (mobile:sync)',
          defaultCode: 'MOBILE_SYNC_PUSH_ERROR',
        }),
      );
      return;
    }
    const parsed = mobileSyncPushSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: 'MOBILE_SYNC_INVALID_PAYLOAD',
          message: 'Invalid mobile sync push payload',
          details: zodIssues(parsed.error),
        },
      });
      return;
    }
    const input = parsed.data;
    if (mobileSession.deviceId !== input.deviceId) {
      res
        .status(403)
        .json(
          mobileDeviceMismatchResponse({
            tokenDeviceId: mobileSession.deviceId,
            requestDeviceId: input.deviceId,
          }),
        );
      return;
    }
    const syncPushSourceIp = getIngestSourceIp(req);
    if (
      !applyMobileSyncPushRateLimit({
        userId: mobileSession.user.id,
        deviceId: input.deviceId,
        ip: syncPushSourceIp,
      })
    ) {
      recordRateLimitEvent('mobile_sync_push');
      const retryAfterSeconds = getRateLimitRetryAfterSeconds(
        'MOBILE_SYNC_PUSH_RATE_LIMIT_WINDOW_MS',
        60000,
      );
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({
        error: {
          code: 'MOBILE_SYNC_PUSH_RATE_LIMITED',
          message: 'Mobile sync push rate limit exceeded. Retry shortly.',
          recoverable: true,
          retryAfterSeconds,
        },
      });
      return;
    }
    const payloadLimits = getMobileSyncPayloadLimits();
    const runtimeLimits = getMobileSyncRuntimeLimits();
    if (input.actions.length > payloadLimits.maxActionsPerPush) {
      recordMobileSyncPayloadRejectedEvent();
      res.status(413).json({
        error: {
          code: 'MOBILE_SYNC_TOO_MANY_ACTIONS',
          message: 'Sync push includes more actions than allowed in one request',
          details: {
            maxActionsPerPush: payloadLimits.maxActionsPerPush,
            receivedActions: input.actions.length,
          },
        },
      });
      return;
    }

    const duplicateActionIds = new Set<string>();
    const seenActionIds = new Set<string>();
    for (const action of input.actions) {
      if (seenActionIds.has(action.clientActionId)) {
        duplicateActionIds.add(action.clientActionId);
        continue;
      }
      seenActionIds.add(action.clientActionId);
    }
    if (duplicateActionIds.size > 0) {
      res.status(400).json({
        error: {
          code: 'MOBILE_SYNC_DUPLICATE_ACTION_IDS',
          message: 'Push payload contains duplicate clientActionId values',
          details: {
            duplicateActionIds: [...duplicateActionIds].sort((a, b) =>
              a.localeCompare(b),
            ),
          },
        },
      });
      return;
    }

    const oversizedActions: Array<{ clientActionId: string; payloadBytes: number }> = [];
    const invalidActionShapes: Array<{
      clientActionId: string;
      reason: 'MAX_DEPTH_EXCEEDED' | 'MAX_KEYS_EXCEEDED';
      actualDepth: number;
      actualKeys: number;
    }> = [];
    let totalPayloadBytes = 0;
    for (const action of input.actions) {
      const payloadBytes = jsonUtf8ByteLength(action.payload);
      totalPayloadBytes += payloadBytes;
      if (payloadBytes > payloadLimits.maxActionPayloadBytes) {
        oversizedActions.push({
          clientActionId: action.clientActionId,
          payloadBytes,
        });
      }
      const shapeViolation = inspectJsonShape({
        value: action.payload,
        maxDepth: payloadLimits.maxActionPayloadDepth,
        maxKeys: payloadLimits.maxActionPayloadKeys,
      });
      if (shapeViolation) {
        invalidActionShapes.push({
          clientActionId: action.clientActionId,
          reason: shapeViolation.reason,
          actualDepth: shapeViolation.actualDepth,
          actualKeys: shapeViolation.actualKeys,
        });
      }
    }
    if (oversizedActions.length > 0) {
      recordMobileSyncPayloadRejectedEvent();
      res.status(413).json({
        error: {
          code: 'MOBILE_SYNC_PAYLOAD_TOO_LARGE',
          message: 'One or more action payloads exceed size limits',
          details: {
            maxActionPayloadBytes: payloadLimits.maxActionPayloadBytes,
            oversizedActions,
          },
        },
      });
      return;
    }
    if (invalidActionShapes.length > 0) {
      recordMobileSyncPayloadRejectedEvent();
      res.status(400).json({
        error: {
          code: 'MOBILE_SYNC_PAYLOAD_SHAPE_INVALID',
          message: 'One or more action payloads exceed shape limits',
          details: {
            maxActionPayloadDepth: payloadLimits.maxActionPayloadDepth,
            maxActionPayloadKeys: payloadLimits.maxActionPayloadKeys,
            invalidActionShapes,
          },
        },
      });
      return;
    }
    if (totalPayloadBytes > payloadLimits.maxBatchPayloadBytes) {
      recordMobileSyncPayloadRejectedEvent();
      res.status(413).json({
        error: {
          code: 'MOBILE_SYNC_BATCH_PAYLOAD_TOO_LARGE',
          message: 'Combined action payload size exceeds batch limit',
          details: {
            maxBatchPayloadBytes: payloadLimits.maxBatchPayloadBytes,
            totalPayloadBytes,
          },
        },
      });
      return;
    }

    await upsertMobileClient({
      orgId,
      userId: mobileSession.user.id,
      deviceId: input.deviceId,
      deviceName:
        typeof req.header('x-device-name') === 'string'
          ? req.header('x-device-name') ?? null
          : null,
    });

    const results: Array<{
      clientActionId: string;
      status: 'APPLIED' | 'FAILED';
      output?: unknown;
      error?: string;
      errorCode?: string;
      recoverable?: boolean;
    }> = [];

    for (const action of input.actions) {
      const normalizedPayload =
        action.payload && typeof action.payload === 'object' && !Array.isArray(action.payload)
          ? action.payload
          : {};
      const pushInProgressResult = () => {
        results.push({
          clientActionId: action.clientActionId,
          status: 'FAILED',
          error: 'Action is already being processed for this device. Retry shortly.',
          errorCode: 'MOBILE_SYNC_ACTION_IN_PROGRESS',
          recoverable: true,
        });
      };
      let existing = await prisma.clientAction.findUnique({
        where: {
          orgId_userId_deviceId_clientActionId: {
            orgId,
            userId: mobileSession.user.id,
            deviceId: input.deviceId,
            clientActionId: action.clientActionId,
          },
        },
      });
      let claimedByThisRequest = false;

      if (!existing) {
        const initialClaimMarker = buildPendingClaimMarker();
        try {
          existing = await prisma.clientAction.create({
            data: {
              orgId,
              userId: mobileSession.user.id,
              deviceId: input.deviceId,
              clientActionId: action.clientActionId,
              toolName: action.toolName,
              payloadJson: normalizedPayload as unknown as Prisma.InputJsonValue,
              status: ClientActionStatus.PENDING,
              error: initialClaimMarker,
            },
          });
          claimedByThisRequest = true;
        } catch (createError) {
          if (!isPrismaUniqueConstraintError(createError)) {
            throw createError;
          }
          existing = await prisma.clientAction.findUnique({
            where: {
              orgId_userId_deviceId_clientActionId: {
                orgId,
                userId: mobileSession.user.id,
                deviceId: input.deviceId,
                clientActionId: action.clientActionId,
              },
            },
          });
        }
      }

      if (!existing) {
        results.push({
          clientActionId: action.clientActionId,
          status: 'FAILED',
          error: 'Unable to resolve client action record',
          errorCode: 'MOBILE_SYNC_ACTION_STATE_ERROR',
          recoverable: true,
        });
        continue;
      }

      if (existing) {
        const existingPayloadCanonical = canonicalJson(existing.payloadJson);
        const incomingPayloadCanonical = canonicalJson(normalizedPayload);
        const idempotencyConflict =
          existing.toolName !== action.toolName ||
          existingPayloadCanonical !== incomingPayloadCanonical;
        if (idempotencyConflict) {
          results.push({
            clientActionId: action.clientActionId,
            status: 'FAILED',
            error:
              'clientActionId was previously used with different toolName or payload',
            errorCode: 'MOBILE_SYNC_IDEMPOTENCY_CONFLICT',
            recoverable: false,
          });
          continue;
        }
      }

      if (existing?.status === ClientActionStatus.APPLIED) {
        results.push({
          clientActionId: action.clientActionId,
          status: 'APPLIED',
          output: existing.resultJson ?? null,
        });
        continue;
      }

      if (existing?.status === ClientActionStatus.FAILED) {
        const priorResult =
          existing.resultJson && typeof existing.resultJson === 'object' && !Array.isArray(existing.resultJson)
            ? (existing.resultJson as Record<string, unknown>)
            : {};
        const priorRecoverable =
          typeof priorResult.recoverable === 'boolean'
            ? priorResult.recoverable
            : false;
        if (priorRecoverable) {
          const recovered = await recoverPendingClientAction({
            orgId,
            clientActionId: action.clientActionId,
          });
          if (recovered) {
            await prisma.clientAction.update({
              where: {
                orgId_userId_deviceId_clientActionId: {
                  orgId,
                  userId: mobileSession.user.id,
                  deviceId: input.deviceId,
                  clientActionId: action.clientActionId,
                },
              },
              data: {
                status: recovered.clientActionStatus,
                resultJson: recovered.resultJson,
                appliedAt: new Date(),
                error: recovered.error,
              },
            });
            results.push(recovered.result);
            continue;
          }
          const promoted = await prisma.clientAction.updateMany({
            where: {
              id: existing.id,
              status: ClientActionStatus.FAILED,
            },
            data: {
              status: ClientActionStatus.PENDING,
              error: null,
              appliedAt: null,
            },
          });
          if (promoted.count !== 1) {
            pushInProgressResult();
            continue;
          }
          existing = await prisma.clientAction.findUnique({
            where: {
              orgId_userId_deviceId_clientActionId: {
                orgId,
                userId: mobileSession.user.id,
                deviceId: input.deviceId,
                clientActionId: action.clientActionId,
              },
            },
          });
          if (!existing) {
            results.push({
              clientActionId: action.clientActionId,
              status: 'FAILED',
              error: 'Unable to resolve promoted client action state',
              errorCode: 'MOBILE_SYNC_ACTION_STATE_ERROR',
              recoverable: true,
            });
            continue;
          }
          claimedByThisRequest = false;
        } else {
          results.push({
            clientActionId: action.clientActionId,
            status: 'FAILED',
            error: existing.error ?? 'Action previously failed',
            errorCode:
              typeof priorResult.errorCode === 'string'
                ? priorResult.errorCode
                : 'MOBILE_SYNC_ACTION_PREVIOUSLY_FAILED',
            recoverable:
              typeof priorResult.recoverable === 'boolean'
                ? priorResult.recoverable
                : false,
          });
          continue;
        }
      }

      if (existing?.status === ClientActionStatus.PENDING) {
        const recovered = await recoverPendingClientAction({
          orgId,
          clientActionId: action.clientActionId,
        });
        if (recovered) {
          await prisma.clientAction.update({
            where: {
              orgId_userId_deviceId_clientActionId: {
                orgId,
                userId: mobileSession.user.id,
                deviceId: input.deviceId,
                clientActionId: action.clientActionId,
              },
            },
            data: {
              status: recovered.clientActionStatus,
              resultJson: recovered.resultJson,
              appliedAt: new Date(),
              error: recovered.error,
            },
          });
          results.push(recovered.result);
          continue;
        }
        if (!claimedByThisRequest) {
          const claim = await claimPendingClientAction({
            id: existing.id,
            existingError: existing.error,
            staleAfterSeconds: runtimeLimits.pendingClaimStaleSeconds,
          });
          if (!claim.claimed) {
            pushInProgressResult();
            continue;
          }
        }
      }
      try {
        const execution = await runWithTimeout(
          () =>
            registry.execute(action.toolName, normalizedPayload as Record<string, unknown>, {
              orgId,
              actorType: ActorType.HUMAN,
              actorUserId: mobileSession.user.id,
              actorLabel: `mobile-sync:${input.deviceId}`,
              clientActionId: action.clientActionId,
              isAutonomous: false,
              reason:
                action.reason ??
                `Mobile offline replay for ${action.toolName}`,
            }),
          runtimeLimits.maxActionExecutionMs,
        );

        if (execution.status === 'EXECUTED' || execution.status === 'QUEUED_APPROVAL') {
          const resultPayload = execution as unknown as Prisma.InputJsonValue;
          await prisma.clientAction.update({
            where: {
              orgId_userId_deviceId_clientActionId: {
                orgId,
                userId: mobileSession.user.id,
                deviceId: input.deviceId,
                clientActionId: action.clientActionId,
              },
            },
            data: {
              status: ClientActionStatus.APPLIED,
              resultJson: resultPayload,
              appliedAt: new Date(),
              error: null,
            },
          });

          results.push({
            clientActionId: action.clientActionId,
            status: 'APPLIED',
            output: execution,
          });
          continue;
        }

        const message =
          execution.status === 'BLOCKED'
            ? execution.reason
            : execution.error;
        const errorCode =
          execution.status === 'FAILED'
            ? execution.errorCode ?? 'TOOL_FAILED'
            : execution.status === 'BLOCKED'
              ? 'TOOL_BLOCKED'
              : undefined;
        const recoverable =
          execution.status === 'FAILED'
            ? execution.recoverable ?? false
            : execution.status === 'BLOCKED'
              ? false
              : undefined;

        await prisma.clientAction.update({
          where: {
            orgId_userId_deviceId_clientActionId: {
              orgId,
              userId: mobileSession.user.id,
              deviceId: input.deviceId,
              clientActionId: action.clientActionId,
            },
          },
          data: {
            status: ClientActionStatus.FAILED,
            resultJson: execution as unknown as Prisma.InputJsonValue,
            error: message,
            appliedAt: new Date(),
          },
        });

        results.push({
          clientActionId: action.clientActionId,
          status: 'FAILED',
          error: message,
          errorCode,
          recoverable,
        });
      } catch (actionError) {
        const errorMessage =
          actionError instanceof Error ? actionError.message : 'Unknown action error';
        const timeoutMs =
          actionError instanceof AsyncTimeoutError
            ? actionError.timeoutMs
            : undefined;
        const errorCode = actionError instanceof AsyncTimeoutError
          ? 'MOBILE_SYNC_ACTION_TIMEOUT'
          : errorMessage.startsWith('Tool not found:')
            ? 'TOOL_NOT_FOUND'
            : 'MOBILE_SYNC_ACTION_EXCEPTION';
        const recoverable = actionError instanceof AsyncTimeoutError ? true : false;
        const failurePayload = {
          status: 'FAILED',
          error: errorMessage,
          errorCode,
          recoverable,
          timeoutMs,
        } as const;

        await prisma.clientAction.update({
          where: {
            orgId_userId_deviceId_clientActionId: {
              orgId,
              userId: mobileSession.user.id,
              deviceId: input.deviceId,
              clientActionId: action.clientActionId,
            },
          },
          data: {
            status: ClientActionStatus.FAILED,
            resultJson: failurePayload as unknown as Prisma.InputJsonValue,
            error: errorMessage,
            appliedAt: new Date(),
          },
        });

        results.push({
          clientActionId: action.clientActionId,
          status: 'FAILED',
          error: errorMessage,
          errorCode,
          recoverable,
        });
      }
    }

    res.json({ results });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res
      .status(status)
      .json(
        mobileSyncEndpointErrorResponse({
          status,
          message,
          defaultCode: 'MOBILE_SYNC_PUSH_ERROR',
        }),
      );
  }
});

app.post('/api/mobile/sync/pull', async (req, res) => {
  try {
    const mobileSession = await requireMobileSession(req);
    const orgId = mobileSession.orgId;
    const grantedPermissions = await resolveUserPermissions(mobileSession.user.id);
    const canSync = ['mobile:sync', '*'].some((required) =>
      grantedPermissions.some((granted) => permissionCovers(required, granted)),
    );
    if (!canSync) {
      res.status(403).json(
        mobileSyncEndpointErrorResponse({
          status: 403,
          message: 'Forbidden: missing required permissions (mobile:sync)',
          defaultCode: 'MOBILE_SYNC_PULL_ERROR',
        }),
      );
      return;
    }
    const parsed = mobileSyncPullSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: 'MOBILE_SYNC_INVALID_PAYLOAD',
          message: 'Invalid mobile sync pull payload',
          details: zodIssues(parsed.error),
        },
      });
      return;
    }
    const input = parsed.data;
    if (mobileSession.deviceId !== input.deviceId) {
      res
        .status(403)
        .json(
          mobileDeviceMismatchResponse({
            tokenDeviceId: mobileSession.deviceId,
            requestDeviceId: input.deviceId,
          }),
        );
      return;
    }
    const syncPullSourceIp = getIngestSourceIp(req);
    if (
      !applyMobileSyncPullRateLimit({
        userId: mobileSession.user.id,
        deviceId: input.deviceId,
        ip: syncPullSourceIp,
      })
    ) {
      recordRateLimitEvent('mobile_sync_pull');
      const retryAfterSeconds = getRateLimitRetryAfterSeconds(
        'MOBILE_SYNC_PULL_RATE_LIMIT_WINDOW_MS',
        60000,
      );
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({
        error: {
          code: 'MOBILE_SYNC_PULL_RATE_LIMITED',
          message: 'Mobile sync pull rate limit exceeded. Retry shortly.',
          recoverable: true,
          retryAfterSeconds,
        },
      });
      return;
    }
    const cursorLimits = getMobileSyncCursorLimits();
    const oversizedCursorFields: Array<{
      field: 'auditCursor' | 'outboxCursor';
      cursorBytes: number;
    }> = [];
    const rawAuditCursor = input.cursors?.auditCursor;
    if (typeof rawAuditCursor === 'string') {
      const bytes = Buffer.byteLength(rawAuditCursor, 'utf8');
      if (bytes > cursorLimits.maxCursorBytes) {
        oversizedCursorFields.push({
          field: 'auditCursor',
          cursorBytes: bytes,
        });
      }
    }
    const rawOutboxCursor = input.cursors?.outboxCursor;
    if (typeof rawOutboxCursor === 'string') {
      const bytes = Buffer.byteLength(rawOutboxCursor, 'utf8');
      if (bytes > cursorLimits.maxCursorBytes) {
        oversizedCursorFields.push({
          field: 'outboxCursor',
          cursorBytes: bytes,
        });
      }
    }
    if (oversizedCursorFields.length > 0) {
      res.status(413).json({
        error: {
          code: 'MOBILE_SYNC_CURSOR_TOO_LARGE',
          message: 'One or more mobile sync cursors exceed size limits',
          details: {
            maxCursorBytes: cursorLimits.maxCursorBytes,
            oversizedCursorFields,
          },
          recoverable: true,
        },
      });
      return;
    }
    const pullLimits = getMobileSyncPullLimits();

    await upsertMobileClient({
      orgId,
      userId: mobileSession.user.id,
      deviceId: input.deviceId,
      deviceName:
        typeof req.header('x-device-name') === 'string'
          ? req.header('x-device-name') ?? null
          : null,
    });

    const storedCursors = await prisma.mobileSyncCursor.findMany({
      where: {
        orgId,
        userId: mobileSession.user.id,
        deviceId: input.deviceId,
        cursorType: {
          in: [MobileSyncCursorType.AUDITLOG, MobileSyncCursorType.OUTBOX],
        },
      },
    });
    const storedAuditCursor = storedCursors.find((row) => row.cursorType === MobileSyncCursorType.AUDITLOG)?.cursorValue;
    const storedOutboxCursor = storedCursors.find((row) => row.cursorType === MobileSyncCursorType.OUTBOX)?.cursorValue;

    const now = new Date();
    const fallbackStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const maxFutureSkewSeconds = parsePositiveIntValue(
      process.env.MOBILE_SYNC_MAX_CURSOR_FUTURE_SKEW_SECONDS,
      300,
    );
    const auditCursor =
      parseMobileEventCursor(storedAuditCursor) ??
      sanitizeMobileEventCursor(
        parseMobileEventCursor(input.cursors?.auditCursor),
        now,
        maxFutureSkewSeconds,
      ) ??
      { ts: fallbackStart, ids: [] };
    const outboxCursor =
      parseMobileEventCursor(storedOutboxCursor) ??
      sanitizeMobileEventCursor(
        parseMobileEventCursor(input.cursors?.outboxCursor),
        now,
        maxFutureSkewSeconds,
      ) ??
      { ts: fallbackStart, ids: [] };
    const auditBoundaryFilter =
      auditCursor.ids.length > 0
        ? {
            AND: [
              { createdAt: auditCursor.ts },
              { id: { notIn: auditCursor.ids } },
            ],
          }
        : { createdAt: auditCursor.ts };
    const outboxBoundaryFilter =
      outboxCursor.ids.length > 0
        ? {
            AND: [
              { createdAt: outboxCursor.ts },
              { id: { notIn: outboxCursor.ids } },
            ],
          }
        : { createdAt: outboxCursor.ts };

    const [auditEvents, outboxEvents] = await Promise.all([
      prisma.auditLog.findMany({
        where: {
          orgId,
          OR: [
            { createdAt: { gt: auditCursor.ts } },
            auditBoundaryFilter,
          ],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: pullLimits.maxAuditEvents,
      }),
      prisma.eventOutbox.findMany({
        where: {
          orgId,
          OR: [
            { createdAt: { gt: outboxCursor.ts } },
            outboxBoundaryFilter,
          ],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: pullLimits.maxOutboxEvents,
      }),
    ]);
    const auditHasMore = auditEvents.length >= pullLimits.maxAuditEvents;
    const outboxHasMore = outboxEvents.length >= pullLimits.maxOutboxEvents;

    const nextAuditCursor: MobileEventCursor =
      auditEvents.length > 0
        ? (() => {
            const lastCreatedAt = auditEvents[auditEvents.length - 1].createdAt;
            const idsAtLastTs = auditEvents
              .filter((row) => row.createdAt.getTime() === lastCreatedAt.getTime())
              .map((row) => row.id);
            return {
              ts: lastCreatedAt,
              ids: mergeCursorIds(auditCursor, idsAtLastTs, lastCreatedAt),
            };
          })()
        : auditCursor;
    const nextOutboxCursor: MobileEventCursor =
      outboxEvents.length > 0
        ? (() => {
            const lastCreatedAt = outboxEvents[outboxEvents.length - 1].createdAt;
            const idsAtLastTs = outboxEvents
              .filter((row) => row.createdAt.getTime() === lastCreatedAt.getTime())
              .map((row) => row.id);
            return {
              ts: lastCreatedAt,
              ids: mergeCursorIds(outboxCursor, idsAtLastTs, lastCreatedAt),
            };
          })()
        : outboxCursor;

    const [roleNames, openTimeEditRequests] = await Promise.all([
      resolveUserRoleNames(mobileSession.user.id),
      prisma.timeEditRequest.findMany({
        where: {
          orgId,
          status: 'PENDING',
        },
        orderBy: { createdAt: 'desc' },
        take: pullLimits.maxTimeEditRequests,
      }),
    ]);

    const canDispatch = roleNames.some((role) =>
      role.includes('dispatch') || role.includes('admin') || role.includes('owner') || role.includes('manager'),
    );
    const canReviewEdits = roleNames.some((role) =>
      role.includes('dispatch') || role.includes('admin') || role.includes('owner') || role.includes('manager'),
    );

    const todayDate = parseDateOnlyInput(new Date());
    const [todaySchedule, dispatchDay] = await Promise.all([
      buildTodayScheduleReadModel({
        orgId,
        userId: mobileSession.user.id,
        dateKey: todayDate,
        maxAppointments: pullLimits.maxTodayAppointments,
        maxTimeEntries: pullLimits.maxTodayTimeEntries,
      }),
      canDispatch
        ? buildDispatchDayReadModel({
            orgId,
            dateKey: todayDate,
            maxAppointments: pullLimits.maxDispatchAppointments,
          })
        : Promise.resolve(undefined),
    ]);

    const newAuditCursorValue = encodeMobileEventCursor(nextAuditCursor);
    const newOutboxCursorValue = encodeMobileEventCursor(nextOutboxCursor);

    await prisma.mobileSyncCursor.upsert({
      where: {
        orgId_userId_deviceId_cursorType: {
          orgId,
          userId: mobileSession.user.id,
          deviceId: input.deviceId,
          cursorType: MobileSyncCursorType.AUDITLOG,
        },
      },
      update: {
        cursorValue: newAuditCursorValue,
      },
      create: {
        orgId,
        userId: mobileSession.user.id,
        deviceId: input.deviceId,
        cursorType: MobileSyncCursorType.AUDITLOG,
        cursorValue: newAuditCursorValue,
      },
    });

    await prisma.mobileSyncCursor.upsert({
      where: {
        orgId_userId_deviceId_cursorType: {
          orgId,
          userId: mobileSession.user.id,
          deviceId: input.deviceId,
          cursorType: MobileSyncCursorType.OUTBOX,
        },
      },
      update: {
        cursorValue: newOutboxCursorValue,
      },
      create: {
        orgId,
        userId: mobileSession.user.id,
        deviceId: input.deviceId,
        cursorType: MobileSyncCursorType.OUTBOX,
        cursorValue: newOutboxCursorValue,
      },
    });

    res.json({
      newCursors: {
        auditCursor: toCursorValue(nextAuditCursor.ts),
        outboxCursor: toCursorValue(nextOutboxCursor.ts),
      },
      events: {
        audit: auditEvents.map((row) => ({
          id: row.id,
          actorType: row.actorType,
          actorUserId: row.actorUserId,
          action: row.action,
          entityType: row.entityType,
          entityId: row.entityId,
          metadata: row.metadata,
          createdAt: row.createdAt.toISOString(),
        })),
        outbox: outboxEvents.map((row) => ({
          id: row.id,
          eventType: row.eventType,
          payload: row.payload,
          status: row.status,
          createdAt: row.createdAt.toISOString(),
        })),
      },
      pageInfo: {
        auditHasMore,
        outboxHasMore,
        limits: {
          maxAuditEvents: pullLimits.maxAuditEvents,
          maxOutboxEvents: pullLimits.maxOutboxEvents,
          maxTimeEditRequests: pullLimits.maxTimeEditRequests,
          maxTodayAppointments: pullLimits.maxTodayAppointments,
          maxTodayTimeEntries: pullLimits.maxTodayTimeEntries,
          maxDispatchAppointments: pullLimits.maxDispatchAppointments,
        },
      },
      readModels: {
        todaySchedule,
        dispatchDay,
        entities: {
          timeEditRequests: canReviewEdits ? openTimeEditRequests : [],
          me: {
            userId: mobileSession.user.id,
            roles: roleNames,
            permissions: grantedPermissions,
          },
        },
      },
    });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res
      .status(status)
      .json(
        mobileSyncEndpointErrorResponse({
          status,
          message,
          defaultCode: 'MOBILE_SYNC_PULL_ERROR',
        }),
      );
  }
});

app.post('/api/tools/:toolName/execute', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const actor = await getActor(req, orgId);
    const isAutonomous = req.body?.isAutonomous === true;

    const result = await registry.execute(
      req.params.toolName,
      req.body?.payload ?? {},
      {
        orgId,
        actorType: actor.actorType,
        actorUserId: actor.actorUserId,
        actorLabel: actor.actorLabel,
        isAutonomous,
        policyId: req.body?.policyId,
        agentRunId: req.body?.agentRunId,
        reason: req.body?.reason,
      },
    );

    res.status(200).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.post('/api/tools/:toolName/explain', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const actor = await getActor(req, orgId);
    const payload =
      req.body?.payload &&
      typeof req.body.payload === 'object' &&
      !Array.isArray(req.body.payload)
        ? (req.body.payload as Record<string, unknown>)
        : {};
    const contextInput =
      req.body?.context &&
      typeof req.body.context === 'object' &&
      !Array.isArray(req.body.context)
        ? (req.body.context as Record<string, unknown>)
        : {};

    const explain = await registry.explain(
      req.params.toolName,
      payload,
      {
        orgId,
        actorType: actor.actorType,
        actorUserId: actor.actorUserId,
        actorLabel: actor.actorLabel,
        isAutonomous: req.body?.isAutonomous === true,
        policyId:
          typeof req.body?.policyId === 'string' ? req.body.policyId : undefined,
        agentRunId:
          typeof contextInput.agentRunId === 'string'
            ? contextInput.agentRunId
            : typeof req.body?.agentRunId === 'string'
              ? req.body.agentRunId
              : undefined,
        reason: typeof req.body?.reason === 'string' ? req.body.reason : undefined,
        endpointAllowsCritical: contextInput.endpointAllowsCritical === true,
        version:
          typeof req.body?.version === 'string' ? req.body.version : undefined,
      },
    );

    res.json(explain);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message.includes('Tool not found')) {
      res.status(404).json({ error: message });
      return;
    }
    res.status(400).json({ error: message });
  }
});

app.get('/api/approvals', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const status =
      typeof req.query.status === 'string'
        ? (req.query.status as ApprovalStatus)
        : ApprovalStatus.PENDING;

    const approvals = await prisma.approvalRequest.findMany({
      where: {
        orgId,
        status,
      },
      include: {
        toolDefinition: true,
        decisions: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    res.json({ approvals });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.get('/api/control-room/kpis', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const now = new Date();
    const dayStart = startOfUtcDay(now);

    const [leadsToday, estimatesSentToday, approvalsPending, runs, safetyState, exposure] =
      await Promise.all([
        prisma.lead.count({
          where: {
            orgId,
            createdAt: { gte: dayStart },
          },
        }),
        prisma.toolExecution.count({
          where: {
            orgId,
            status: ExecutionStatus.EXECUTED,
            createdAt: { gte: dayStart },
            toolDefinition: {
              name: 'billing.invoice.issue',
            },
          },
        }),
        prisma.approvalRequest.count({
          where: {
            orgId,
            status: ApprovalStatus.PENDING,
          },
        }),
        prisma.agentRun.findMany({
          where: { orgId },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
        prisma.orgSafetyState.findUnique({
          where: { orgId },
        }),
        getExposureToday(orgId, now),
      ]);

    const hasRunning = runs.some((run) => run.status === 'RUNNING');
    const hasPaused = runs.some((run) => run.status === 'PAUSED_FOR_APPROVALS');
    const agentStatus =
      safetyState?.mode && safetyState.mode !== 'NORMAL'
        ? 'AUTONOMY_OFF'
        : hasRunning
          ? 'RUNNING'
          : hasPaused
            ? 'PAUSED'
            : 'IDLE';

    const exposureRemaining = Object.fromEntries(
      exposure.buckets.map((bucket) => [bucket.bucket, bucket.remainingCents]),
    );

    res.json({
      generatedAt: now.toISOString(),
      kpis: {
        leadsToday,
        estimatesSentToday,
        approvalsPending,
        agentStatus,
        exposureRemaining,
      },
      exposure,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.get('/api/geo/summary', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireOwnerAdminOrManager(req, orgId);

    const days = parseRangeDays(req.query.range, 7);
    const start = rangeStartDate(days);

    const rows = await prisma.geoRollupDaily.findMany({
      where: {
        orgId,
        date: {
          gte: start,
        },
      },
      orderBy: [{ date: 'asc' }],
    });

    const totals = {
      leadsCount: 0,
      jobsCount: 0,
      revenueCents: 0,
      spendCents: 0,
      reviewsCount: 0,
      referralsCount: 0,
    };

    const byDateMap = new Map<
      string,
      {
        date: string;
        leadsCount: number;
        jobsCount: number;
        revenueCents: number;
        spendCents: number;
        reviewsCount: number;
        referralsCount: number;
        closeRatePct: number | null;
      }
    >();

    for (const row of rows) {
      const dateKey = utcDateKey(row.date);
      const existing =
        byDateMap.get(dateKey) ??
        {
          date: dateKey,
          leadsCount: 0,
          jobsCount: 0,
          revenueCents: 0,
          spendCents: 0,
          reviewsCount: 0,
          referralsCount: 0,
          closeRatePct: null,
        };

      existing.leadsCount += row.leadsCount;
      existing.jobsCount += row.jobsCount;
      existing.revenueCents += row.revenueCents;
      existing.spendCents += row.spendCents;
      existing.reviewsCount += row.reviewsCount;
      existing.referralsCount += row.referralsCount;
      byDateMap.set(dateKey, existing);

      totals.leadsCount += row.leadsCount;
      totals.jobsCount += row.jobsCount;
      totals.revenueCents += row.revenueCents;
      totals.spendCents += row.spendCents;
      totals.reviewsCount += row.reviewsCount;
      totals.referralsCount += row.referralsCount;
    }

    const byDate = Array.from(byDateMap.values()).map((row) => ({
      ...row,
      closeRatePct:
        row.leadsCount > 0
          ? Math.round((row.jobsCount / row.leadsCount) * 10000) / 100
          : null,
    }));

    res.json({
      rangeDays: days,
      fromDate: utcDateKey(start),
      toDate: utcDateKey(startOfUtcDay(new Date())),
      totals: {
        ...totals,
        closeRatePct:
          totals.leadsCount > 0
            ? Math.round((totals.jobsCount / totals.leadsCount) * 10000) / 100
            : null,
      },
      byDate,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.get('/api/geo/heatmap', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireOwnerAdminOrManager(req, orgId);

    const days = parseRangeDays(req.query.range, 30);
    const precision =
      typeof req.query.precision === 'string' && req.query.precision === 'geohash5'
        ? 'geohash5'
        : 'zip';
    const start = rangeStartDate(days);

    const rows = await prisma.geoRollupDaily.findMany({
      where: {
        orgId,
        date: {
          gte: start,
        },
      },
      orderBy: [{ date: 'asc' }],
    });

    const points = new Map<
      string,
      {
        key: string;
        zip: string | null;
        city: string | null;
        geohashPrefix: string | null;
        leadsCount: number;
        jobsCount: number;
        revenueCents: number;
        spendCents: number;
        reviewsCount: number;
        referralsCount: number;
        closeRatePct: number | null;
      }
    >();

    for (const row of rows) {
      const groupKey = precision === 'zip' ? row.zip ?? 'UNKNOWN' : row.geohashPrefix;
      const existing =
        points.get(groupKey) ??
        {
          key: groupKey,
          zip: row.zip,
          city: row.city,
          geohashPrefix: row.geohashPrefix,
          leadsCount: 0,
          jobsCount: 0,
          revenueCents: 0,
          spendCents: 0,
          reviewsCount: 0,
          referralsCount: 0,
          closeRatePct: null,
        };

      existing.leadsCount += row.leadsCount;
      existing.jobsCount += row.jobsCount;
      existing.revenueCents += row.revenueCents;
      existing.spendCents += row.spendCents;
      existing.reviewsCount += row.reviewsCount;
      existing.referralsCount += row.referralsCount;
      if (!existing.city && row.city) {
        existing.city = row.city;
      }

      points.set(groupKey, existing);
    }

    const data = Array.from(points.values()).map((point) => ({
      ...point,
      closeRatePct:
        point.leadsCount > 0
          ? Math.round((point.jobsCount / point.leadsCount) * 10000) / 100
          : null,
    }));

    res.json({
      rangeDays: days,
      fromDate: utcDateKey(start),
      precision,
      points: data,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.get('/api/geo/areas/top', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireOwnerAdminOrManager(req, orgId);

    const metric =
      typeof req.query.metric === 'string' &&
      ['revenue', 'leads', 'closeRate'].includes(req.query.metric)
        ? req.query.metric
        : 'revenue';
    const days = parseRangeDays(req.query.range, 30);
    const start = rangeStartDate(days);
    const splitDate = new Date(start.getTime());
    splitDate.setUTCDate(splitDate.getUTCDate() + Math.max(1, Math.floor(days / 2)));

    const rows = await prisma.geoRollupDaily.findMany({
      where: {
        orgId,
        date: {
          gte: start,
        },
      },
      orderBy: [{ date: 'asc' }],
    });

    const byZip = new Map<
      string,
      {
        zip: string;
        city: string | null;
        leadsCount: number;
        jobsCount: number;
        revenueCents: number;
        spendCents: number;
        reviewsCount: number;
        referralsCount: number;
        previousMetricValue: number;
        currentMetricValue: number;
      }
    >();

    const metricValueForRow = (row: (typeof rows)[number]) => {
      if (metric === 'revenue') {
        return row.revenueCents;
      }
      if (metric === 'leads') {
        return row.leadsCount;
      }
      return row.leadsCount > 0 ? (row.jobsCount / row.leadsCount) * 100 : 0;
    };

    for (const row of rows) {
      const zip = row.zip ?? 'UNKNOWN';
      const existing =
        byZip.get(zip) ??
        {
          zip,
          city: row.city ?? null,
          leadsCount: 0,
          jobsCount: 0,
          revenueCents: 0,
          spendCents: 0,
          reviewsCount: 0,
          referralsCount: 0,
          previousMetricValue: 0,
          currentMetricValue: 0,
        };

      existing.leadsCount += row.leadsCount;
      existing.jobsCount += row.jobsCount;
      existing.revenueCents += row.revenueCents;
      existing.spendCents += row.spendCents;
      existing.reviewsCount += row.reviewsCount;
      existing.referralsCount += row.referralsCount;

      const value = metricValueForRow(row);
      if (row.date < splitDate) {
        existing.previousMetricValue += value;
      } else {
        existing.currentMetricValue += value;
      }

      if (!existing.city && row.city) {
        existing.city = row.city;
      }
      byZip.set(zip, existing);
    }

    const items = Array.from(byZip.values()).map((entry) => {
      const closeRatePct =
        entry.leadsCount > 0
          ? Math.round((entry.jobsCount / entry.leadsCount) * 10000) / 100
          : null;
      const selectedMetricValue =
        metric === 'revenue'
          ? entry.revenueCents
          : metric === 'leads'
            ? entry.leadsCount
            : closeRatePct ?? 0;
      const trendDelta = entry.currentMetricValue - entry.previousMetricValue;
      const trendPct =
        entry.previousMetricValue > 0
          ? Math.round((trendDelta / entry.previousMetricValue) * 10000) / 100
          : null;

      return {
        zip: entry.zip,
        city: entry.city,
        leadsCount: entry.leadsCount,
        jobsCount: entry.jobsCount,
        revenueCents: entry.revenueCents,
        spendCents: entry.spendCents,
        reviewsCount: entry.reviewsCount,
        referralsCount: entry.referralsCount,
        closeRatePct,
        metric,
        metricValue: selectedMetricValue,
        trend: {
          delta: Math.round(trendDelta * 100) / 100,
          percent: trendPct,
          direction: trendDelta > 0 ? 'up' : trendDelta < 0 ? 'down' : 'flat',
        },
      };
    });

    items.sort((a, b) => b.metricValue - a.metricValue);

    res.json({
      metric,
      rangeDays: days,
      fromDate: utcDateKey(start),
      areas: items.slice(0, 10),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.get('/api/sales/overview', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const actor = await getActor(req, orgId);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [leads, recentActorExecutions] = await Promise.all([
      prisma.lead.findMany({
        where: { orgId },
        orderBy: [{ score: 'desc' }, { updatedAt: 'desc' }],
        take: 100,
      }),
      actor.actorUserId
        ? prisma.toolExecution.findMany({
            where: {
              orgId,
              actorUserId: actor.actorUserId,
            },
            orderBy: { createdAt: 'desc' },
            take: 200,
          })
        : Promise.resolve([]),
    ]);

    const touchedLeadIds = new Set(
      recentActorExecutions
        .map((execution) => getPayloadStringField(execution.inputPayload, 'leadId'))
        .filter((leadId): leadId is string => Boolean(leadId)),
    );

    const myLeads =
      touchedLeadIds.size > 0
        ? leads.filter((lead) => touchedLeadIds.has(lead.id)).slice(0, 12)
        : leads.slice(0, 12);
    const staleLeads = leads
      .filter((lead) => lead.updatedAt < dayAgo)
      .slice(0, 12);
    const followUpsDue = leads
      .filter((lead) => lead.status !== 'WON' && lead.updatedAt < dayAgo)
      .slice(0, 8);

    res.json({
      myLeads,
      staleLeads,
      followUpsDue,
      suggestions: [
        'Review stale leads and schedule next follow-up touchpoints.',
        'Create estimates for high-score leads with no recent quote activity.',
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.get('/api/sales/intake-queue', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireAnyPermission(req, orgId, [
      'crm:read',
      'crm:write',
      'crm:task:write',
    ]);

    const takeRaw = Number(req.query.limit ?? 100);
    const take = Number.isFinite(takeRaw) ? Math.min(Math.max(takeRaw, 1), 300) : 100;
    const statusQuery =
      typeof req.query.status === 'string' && req.query.status.trim().length > 0
        ? req.query.status.trim().toUpperCase()
        : undefined;

    const events = await prisma.websiteIntakeEvent.findMany({
      where: {
        orgId,
        ...(statusQuery === 'RECEIVED' ||
        statusQuery === 'PROCESSED' ||
        statusQuery === 'FAILED'
          ? { status: statusQuery }
          : {}),
      },
      include: {
        lead: true,
      },
      orderBy: { createdAt: 'desc' },
      take,
    });

    const leadIds = [...new Set(events.map((event) => event.leadId).filter(Boolean))] as string[];
    const tasks = leadIds.length
      ? await prisma.task.findMany({
          where: {
            orgId,
            queue: 'SALES',
            leadId: {
              in: leadIds,
            },
            status: {
              in: ['OPEN', 'IN_PROGRESS'],
            },
          },
          orderBy: [{ dueAt: 'asc' }],
        })
      : [];

    const nextTaskByLeadId = new Map<string, (typeof tasks)[number]>();
    for (const task of tasks) {
      if (task.leadId && !nextTaskByLeadId.has(task.leadId)) {
        nextTaskByLeadId.set(task.leadId, task);
      }
    }

    const queue = events.map((event) => {
      const nextTask = event.leadId ? nextTaskByLeadId.get(event.leadId) : undefined;
      return {
        id: event.id,
        type: event.type,
        status: event.status,
        createdAt: event.createdAt,
        processedAt: event.processedAt,
        errorMessage: event.errorMessage,
        lead: event.lead
          ? {
              id: event.lead.id,
              fullName: event.lead.fullName,
              email: event.lead.email,
              phone: event.lead.phone,
              leadSource: event.lead.leadSource,
              status: event.lead.status,
              updatedAt: event.lead.updatedAt,
            }
          : null,
        nextTask: nextTask
          ? {
              id: nextTask.id,
              kind: nextTask.kind,
              priority: nextTask.priority,
              dueAt: nextTask.dueAt,
              status: nextTask.status,
              overdue: nextTask.dueAt.getTime() < Date.now(),
            }
          : null,
      };
    });

    res.json({ queue });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/api/sales/tasks', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireAnyPermission(req, orgId, [
      'crm:read',
      'crm:write',
      'crm:task:write',
    ]);

    const takeRaw = Number(req.query.limit ?? 100);
    const take = Number.isFinite(takeRaw) ? Math.min(Math.max(takeRaw, 1), 300) : 100;
    const statusQuery =
      typeof req.query.status === 'string' && req.query.status.trim().length > 0
        ? req.query.status.trim().toUpperCase()
        : undefined;
    const queue = typeof req.query.queue === 'string' && req.query.queue.trim().length > 0
      ? req.query.queue.trim().toUpperCase()
      : 'SALES';

    const tasks = await prisma.task.findMany({
      where: {
        orgId,
        queue,
        ...(statusQuery === 'OPEN' ||
        statusQuery === 'IN_PROGRESS' ||
        statusQuery === 'COMPLETED' ||
        statusQuery === 'CANCELLED'
          ? { status: statusQuery }
          : {}),
      },
      include: {
        lead: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            status: true,
            leadSource: true,
          },
        },
      },
      orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }],
      take,
    });

    const now = Date.now();
    res.json({
      tasks: tasks.map((task) => ({
        ...task,
        overdue: task.dueAt.getTime() < now && task.status !== 'COMPLETED',
        dueSoon:
          task.status !== 'COMPLETED' &&
          task.dueAt.getTime() >= now &&
          task.dueAt.getTime() - now <= 60 * 60 * 1000,
      })),
    });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/api/leads', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireAnyPermission(req, orgId, [
      'crm:lead:read',
      'crm:read',
      'crm:write',
      'crm:*',
      '*',
    ]);
    const take = Number(req.query.limit ?? 100);
    const status =
      typeof req.query.status === 'string' ? req.query.status : undefined;
    const ownerUserId =
      typeof req.query.ownerUserId === 'string' && req.query.ownerUserId.trim().length > 0
        ? req.query.ownerUserId.trim()
        : undefined;
    const leadType =
      typeof req.query.leadType === 'string' && req.query.leadType.trim().length > 0
        ? req.query.leadType.trim().toUpperCase()
        : undefined;
    const slaStatusFilter =
      typeof req.query.slaStatus === 'string' && req.query.slaStatus.trim().length > 0
        ? req.query.slaStatus.trim().toUpperCase()
        : undefined;
    const search =
      typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const leadSource =
      typeof req.query.leadSource === 'string' ? req.query.leadSource.trim() : '';
    const websiteOnly = req.query.websiteOnly === 'true';
    const websiteFilter = websiteOnly
      ? {
          OR: [
            { leadSource: { equals: 'website', mode: 'insensitive' as const } },
            {
              websiteIntakeEvents: {
                some: {},
              },
            },
          ],
        }
      : null;
    const searchFilter = search
      ? {
          OR: [
            { fullName: { contains: search, mode: 'insensitive' as const } },
            { email: { contains: search, mode: 'insensitive' as const } },
            { phone: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : null;

    const [policy, leads] = await Promise.all([
      prisma.leadSlaPolicy.findUnique({
        where: { orgId },
        select: { dueSoonMinutes: true },
      }),
      prisma.lead.findMany({
        where: {
          orgId,
          ...(status ? { status } : {}),
          ...(ownerUserId ? { ownerUserId } : {}),
          ...(leadType && leadType in LeadType
            ? { leadType: leadType as LeadType }
            : {}),
          ...(leadSource ? { leadSource } : {}),
          ...(websiteFilter && searchFilter
            ? { AND: [websiteFilter, searchFilter] }
            : websiteFilter ?? searchFilter ?? {}),
        },
        include: {
          ownerUser: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          salesTasks: {
            where: {
              isNextAction: true,
              status: {
                in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS],
              },
            },
            orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
            take: 1,
          },
        },
        orderBy: [{ updatedAt: 'desc' }],
        take: Number.isNaN(take) ? 100 : Math.min(take, 300),
      }),
    ]);

    const dueSoonMinutes =
      typeof policy?.dueSoonMinutes === 'number' && Number.isFinite(policy.dueSoonMinutes)
        ? Math.max(1, Math.floor(policy.dueSoonMinutes))
        : 60;
    const now = new Date();
    const leadViews = leads.map((lead) => {
      const stage = normalizeLeadStage(lead.stage);
      const sla = evaluateLeadSlaStatus(lead.nextTouchDueAt, dueSoonMinutes, now);
      return {
        ...lead,
        stage,
        slaStatus: sla.slaStatus,
        slaMinutesUntilDue: sla.minutesUntilDue,
        nextActionTask: lead.salesTasks[0] ?? null,
      };
    });

    const filtered =
      slaStatusFilter === 'OK' || slaStatusFilter === 'DUE_SOON' || slaStatusFilter === 'OVERDUE'
        ? leadViews.filter((lead) => lead.slaStatus === slaStatusFilter)
        : leadViews;

    res.json({
      leads: filtered,
      meta: {
        dueSoonMinutes,
      },
    });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/leads/web', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const actor = await getActor(req, orgId);

    const leadResult = await registry.execute(
      'crm.lead.create',
      {
        fullName: req.body?.fullName,
        email: req.body?.email,
        phone: req.body?.phone,
        notes: req.body?.notes,
        status: 'NEW',
      },
      {
        orgId,
        actorType: actor.actorType,
        actorUserId: actor.actorUserId,
        actorLabel: actor.actorLabel,
        isAutonomous: false,
      },
    );

    if (leadResult.status !== 'EXECUTED') {
      res.status(202).json({
        leadExecution: leadResult,
      });
      return;
    }

    const leadOutput =
      (leadResult.output as { lead?: { id?: string } })?.lead ?? null;
    const leadId = leadOutput?.id;
    if (!leadId) {
      res.status(200).json({
        leadExecution: leadResult,
        attributionExecution: null,
      });
      return;
    }

    const attributionResult = await registry.execute(
      'marketing.attribution.capture',
      {
        leadId,
        sourceType: req.body?.sourceType ?? 'WEB_FORM',
        utmSource: req.body?.utmSource,
        utmMedium: req.body?.utmMedium,
        utmCampaign: req.body?.utmCampaign,
        utmContent: req.body?.utmContent,
        utmTerm: req.body?.utmTerm,
        gclid: req.body?.gclid,
        gbraid: req.body?.gbraid,
        wbraid: req.body?.wbraid,
        fbclid: req.body?.fbclid,
        landingUrl: req.body?.landingUrl,
        referrerUrl: req.body?.referrerUrl,
        userAgent: req.header('user-agent'),
        ipHash: req.body?.ipHash,
        metadata: req.body?.metadata ?? {},
      },
      {
        orgId,
        actorType: actor.actorType,
        actorUserId: actor.actorUserId,
        actorLabel: actor.actorLabel,
        isAutonomous: false,
      },
    );

    res.status(201).json({
      leadId,
      leadExecution: leadResult,
      attributionExecution: attributionResult,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.post('/api/intake/contact', async (req, res) => {
  let intakeEventId: string | null = null;
  let orgId = '';
  let leadId: string | null = null;

  try {
    const auth = authenticateIntakeRequest(req);
    const parsed = contactIntakeSchema.parse(req.body ?? {});
    orgId = await getOrgId(req);
    const systemActorUserId = await resolveSystemActorUserId(orgId);
    if (!systemActorUserId) {
      throw new Error('No system actor available for intake execution');
    }

    const intakeEvent = await prisma.websiteIntakeEvent.create({
      data: {
        orgId,
        type: 'CONTACT',
        payload: parsed,
        status: 'RECEIVED',
        sourceIpHash: auth.sourceIpHash,
        userAgent: req.header('user-agent') ?? null,
      },
    });
    intakeEventId = intakeEvent.id;

    const leadResult = await registry.execute(
      'crm.lead.upsertFromWebsite',
      {
        firstName: parsed.firstName,
        lastName: parsed.lastName,
        email: parsed.email,
        phone: parsed.phone,
        address: parsed.address,
        city: parsed.city,
        state: parsed.state,
        zip: parsed.zip,
        serviceType: parsed.serviceType,
        preferredDate: parsed.preferredDate,
        preferredTime: parsed.preferredTime,
        message: parsed.message,
        source: 'website_contact',
        leadSource: 'website',
      },
      {
        orgId,
        actorType: ActorType.SYSTEM,
        actorUserId: systemActorUserId,
        actorLabel: 'website-intake',
        isAutonomous: false,
        reason: 'Website contact intake',
      },
    );
    ensureToolExecuted(leadResult, 'crm.lead.upsertFromWebsite');

    const leadOutput = getExecutionOutputObject(leadResult.output);
    const leadObject = getExecutionOutputObject(leadOutput.lead);
    const resolvedLeadId =
      typeof leadOutput.leadId === 'string'
        ? leadOutput.leadId
        : typeof leadObject.id === 'string'
          ? leadObject.id
          : '';
    if (!resolvedLeadId) {
      throw new Error('crm.lead.upsertFromWebsite did not return leadId');
    }
    leadId = resolvedLeadId;

    if (
      hasAttributionData({
        utmSource: parsed.utmSource,
        utmMedium: parsed.utmMedium,
        utmCampaign: parsed.utmCampaign,
        utmContent: parsed.utmContent,
        utmTerm: parsed.utmTerm,
        gclid: parsed.gclid,
        gbraid: parsed.gbraid,
        wbraid: parsed.wbraid,
        fbclid: parsed.fbclid,
        landingUrl: parsed.landingUrl,
        referrerUrl: parsed.referrerUrl,
        visitorId: parsed.visitorId,
      })
    ) {
      const attributionResult = await registry.execute(
        'crm.attribution.captureFromWebsite',
        {
          leadId,
          sourceType: 'WEB_FORM',
          utmSource: parsed.utmSource,
          utmMedium: parsed.utmMedium,
          utmCampaign: parsed.utmCampaign,
          utmContent: parsed.utmContent,
          utmTerm: parsed.utmTerm,
          gclid: parsed.gclid,
          gbraid: parsed.gbraid,
          wbraid: parsed.wbraid,
          fbclid: parsed.fbclid,
          landingUrl: parsed.landingUrl,
          referrerUrl: parsed.referrerUrl,
          visitorId: parsed.visitorId,
          userAgent: req.header('user-agent') ?? undefined,
          ipHash: auth.sourceIpHash,
          metadata: {
            source: 'website_contact',
            intakeEventId,
          },
        },
        {
          orgId,
          actorType: ActorType.SYSTEM,
          actorUserId: systemActorUserId,
          actorLabel: 'website-intake',
          isAutonomous: false,
          reason: 'Capture website contact attribution',
        },
      );
      ensureToolExecuted(attributionResult, 'crm.attribution.captureFromWebsite');
    }

    const timelineResult = await registry.execute(
      'crm.timeline.add',
      {
        leadId,
        type: 'WEBSITE_CONTACT_SUBMITTED',
        message: 'Website contact submitted',
        metadata: {
          intakeEventId,
          source: 'website_contact',
          serviceType: parsed.serviceType,
          preferredDate: parsed.preferredDate,
          preferredTime: parsed.preferredTime,
        },
      },
      {
        orgId,
        actorType: ActorType.SYSTEM,
        actorUserId: systemActorUserId,
        actorLabel: 'website-intake',
        isAutonomous: false,
        reason: 'Website contact timeline entry',
      },
    );
    ensureToolExecuted(timelineResult, 'crm.timeline.add');

    const taskResult = await registry.execute(
      'crm.task.createSalesSla',
      {
        leadId,
        kind: 'CONTACT',
        dueInMinutes: 30,
        priority: 'MEDIUM',
        queue: 'SALES',
        metadata: {
          intakeEventId,
          source: 'website_contact',
        },
      },
      {
        orgId,
        actorType: ActorType.SYSTEM,
        actorUserId: systemActorUserId,
        actorLabel: 'website-intake',
        isAutonomous: false,
        reason: 'Create CONTACT sales SLA task',
      },
    );
    ensureToolExecuted(taskResult, 'crm.task.createSalesSla');

    const taskOutput = getExecutionOutputObject(taskResult.output);
    const taskObject = getExecutionOutputObject(taskOutput.task);
    const taskId =
      typeof taskOutput.taskId === 'string'
        ? taskOutput.taskId
        : typeof taskObject.id === 'string'
          ? taskObject.id
          : '';
    if (!taskId) {
      throw new Error('crm.task.createSalesSla did not return taskId');
    }

    if (intakeEventId) {
      await prisma.websiteIntakeEvent.update({
        where: { id: intakeEventId },
        data: {
          status: 'PROCESSED',
          leadId,
          processedAt: new Date(),
        },
      });
    }

    res.status(201).json({
      intakeEventId,
      leadId,
      taskId,
    });
  } catch (error) {
    if (intakeEventId && orgId) {
      await prisma.websiteIntakeEvent.update({
        where: { id: intakeEventId },
        data: {
          status: 'FAILED',
          leadId,
          errorMessage:
            error instanceof Error ? error.message : 'Unknown intake error',
        },
      });
    }
    const status = (error as Error & { status?: number }).status ?? 400;
    applyRetryAfterHeader(
      res,
      status,
      (error as Error & { retryAfterSeconds?: number }).retryAfterSeconds,
    );
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/intake/price-match', async (req, res) => {
  let intakeEventId: string | null = null;
  let orgId = '';
  let leadId: string | null = null;

  try {
    const auth = authenticateIntakeRequest(req);
    const parsed = priceMatchIntakeSchema.parse(req.body ?? {});
    orgId = await getOrgId(req);
    const systemActorUserId = await resolveSystemActorUserId(orgId);
    if (!systemActorUserId) {
      throw new Error('No system actor available for intake execution');
    }

    const intakeEvent = await prisma.websiteIntakeEvent.create({
      data: {
        orgId,
        type: 'PRICE_MATCH',
        payload: parsed,
        status: 'RECEIVED',
        sourceIpHash: auth.sourceIpHash,
        userAgent: req.header('user-agent') ?? null,
      },
    });
    intakeEventId = intakeEvent.id;

    const splitName = splitFullName(parsed.lead.name);
    const leadUpsertResult = await registry.execute(
      'crm.lead.upsertFromWebsite',
      {
        firstName: splitName.firstName,
        lastName: splitName.lastName,
        fullName: parsed.lead.name,
        email: parsed.lead.email,
        phone: parsed.lead.phone,
        address: parsed.lead.address,
        serviceType: parsed.lead.serviceType,
        message: parsed.competitor.notes,
        source: parsed.source,
        leadSource: 'website',
      },
      {
        orgId,
        actorType: ActorType.SYSTEM,
        actorUserId: systemActorUserId,
        actorLabel: 'website-intake',
        isAutonomous: false,
        reason: 'Website price match intake',
      },
    );
    ensureToolExecuted(leadUpsertResult, 'crm.lead.upsertFromWebsite');

    const leadOutput = getExecutionOutputObject(leadUpsertResult.output);
    const leadObject = getExecutionOutputObject(leadOutput.lead);
    const resolvedLeadId =
      typeof leadOutput.leadId === 'string'
        ? leadOutput.leadId
        : typeof leadObject.id === 'string'
          ? leadObject.id
          : '';
    if (!resolvedLeadId) {
      throw new Error('crm.lead.upsertFromWebsite did not return leadId');
    }
    leadId = resolvedLeadId;

    if (parsed.attribution && hasAttributionData(parsed.attribution)) {
      const attributionResult = await registry.execute(
        'crm.attribution.captureFromWebsite',
        {
          leadId,
          sourceType: 'WEB_FORM',
          ...parsed.attribution,
          userAgent: req.header('user-agent') ?? undefined,
          ipHash: auth.sourceIpHash,
          metadata: {
            source: parsed.source,
            intakeEventId,
          },
        },
        {
          orgId,
          actorType: ActorType.SYSTEM,
          actorUserId: systemActorUserId,
          actorLabel: 'website-intake',
          isAutonomous: false,
          reason: 'Capture website price-match attribution',
        },
      );
      ensureToolExecuted(attributionResult, 'crm.attribution.captureFromWebsite');
    }

    let attachmentRefId: string | null = null;
    if (parsed.attachment) {
      const provider = parsed.attachment.provider === 'S3' ? 'S3' : 'URL';
      const derivedObjectKey =
        parsed.attachment.objectKey ?? parsed.attachment.key ?? undefined;
      const attachmentCreateResult = await registry.execute(
        'crm.attachmentRef.create',
        {
          provider,
          bucket: parsed.attachment.bucket,
          objectKey: derivedObjectKey,
          url: parsed.attachment.url,
          fileName:
            parsed.attachment.fileName ??
            (derivedObjectKey
              ? derivedObjectKey.split('/').pop() ?? 'price-match-attachment'
              : 'price-match-attachment'),
          mimeType: parsed.attachment.mimeType,
          sizeBytes: parsed.attachment.sizeBytes,
          checksumSha256: parsed.attachment.checksumSha256,
          metadata: {
            source: parsed.source,
            key: parsed.attachment.key ?? null,
            intakeEventId,
          },
        },
        {
          orgId,
          actorType: ActorType.SYSTEM,
          actorUserId: systemActorUserId,
          actorLabel: 'website-intake',
          isAutonomous: false,
          reason: 'Create price-match attachment reference',
        },
      );
      ensureToolExecuted(attachmentCreateResult, 'crm.attachmentRef.create');
      const attachmentOutput = getExecutionOutputObject(attachmentCreateResult.output);
      const attachmentObject = getExecutionOutputObject(attachmentOutput.attachmentRef);
      attachmentRefId =
        typeof attachmentOutput.attachmentRefId === 'string'
          ? attachmentOutput.attachmentRefId
          : typeof attachmentObject.id === 'string'
            ? attachmentObject.id
            : null;
    }

    const priceMatchResult = await registry.execute(
      'crm.priceMatch.create',
      {
        leadId,
        competitorName: parsed.competitor.name,
        competitorPriceCents: parsed.competitor.priceCents,
        notes: parsed.competitor.notes,
        serviceType: parsed.lead.serviceType,
        attachmentRefId: attachmentRefId ?? undefined,
        metadata: {
          source: parsed.source,
          intakeEventId,
        },
      },
      {
        orgId,
        actorType: ActorType.SYSTEM,
        actorUserId: systemActorUserId,
        actorLabel: 'website-intake',
        isAutonomous: false,
        reason: 'Create website price match request',
      },
    );
    ensureToolExecuted(priceMatchResult, 'crm.priceMatch.create');
    const priceMatchOutput = getExecutionOutputObject(priceMatchResult.output);
    const priceMatchObject = getExecutionOutputObject(priceMatchOutput.priceMatchRequest);
    const priceMatchRequestId =
      typeof priceMatchOutput.priceMatchRequestId === 'string'
        ? priceMatchOutput.priceMatchRequestId
        : typeof priceMatchObject.id === 'string'
          ? priceMatchObject.id
          : '';
    if (!priceMatchRequestId) {
      throw new Error('crm.priceMatch.create did not return priceMatchRequestId');
    }

    const timelineResult = await registry.execute(
      'crm.timeline.add',
      {
        leadId,
        type: 'PRICE_MATCH_SUBMITTED',
        message: 'Price match request submitted',
        metadata: {
          intakeEventId,
          source: parsed.source,
          competitorName: parsed.competitor.name,
          competitorPriceCents: parsed.competitor.priceCents ?? null,
          attachmentRefId,
        },
      },
      {
        orgId,
        actorType: ActorType.SYSTEM,
        actorUserId: systemActorUserId,
        actorLabel: 'website-intake',
        isAutonomous: false,
        reason: 'Website price-match timeline entry',
      },
    );
    ensureToolExecuted(timelineResult, 'crm.timeline.add');

    const taskResult = await registry.execute(
      'crm.task.createSalesSla',
      {
        leadId,
        kind: 'PRICE_MATCH',
        dueInMinutes: 10,
        priority: 'HIGH',
        queue: 'SALES',
        metadata: {
          intakeEventId,
          source: parsed.source,
          priceMatchRequestId,
        },
      },
      {
        orgId,
        actorType: ActorType.SYSTEM,
        actorUserId: systemActorUserId,
        actorLabel: 'website-intake',
        isAutonomous: false,
        reason: 'Create PRICE_MATCH sales SLA task',
      },
    );
    ensureToolExecuted(taskResult, 'crm.task.createSalesSla');
    const taskOutput = getExecutionOutputObject(taskResult.output);
    const taskObject = getExecutionOutputObject(taskOutput.task);
    const taskId =
      typeof taskOutput.taskId === 'string'
        ? taskOutput.taskId
        : typeof taskObject.id === 'string'
          ? taskObject.id
          : '';
    if (!taskId) {
      throw new Error('crm.task.createSalesSla did not return taskId');
    }

    if (intakeEventId) {
      await prisma.websiteIntakeEvent.update({
        where: { id: intakeEventId },
        data: {
          status: 'PROCESSED',
          leadId,
          processedAt: new Date(),
        },
      });
    }

    res.status(201).json({
      intakeEventId,
      leadId,
      taskId,
      priceMatchRequestId,
      attachmentRefId,
    });
  } catch (error) {
    if (intakeEventId && orgId) {
      await prisma.websiteIntakeEvent.update({
        where: { id: intakeEventId },
        data: {
          status: 'FAILED',
          leadId,
          errorMessage:
            error instanceof Error ? error.message : 'Unknown intake error',
        },
      });
    }
    const status = (error as Error & { status?: number }).status ?? 400;
    applyRetryAfterHeader(
      res,
      status,
      (error as Error & { retryAfterSeconds?: number }).retryAfterSeconds,
    );
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/api/intake/events', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireOwnerOrAdmin(req, orgId);

    const takeRaw = Number(req.query.limit ?? 100);
    const take = Number.isFinite(takeRaw) ? Math.min(Math.max(takeRaw, 1), 500) : 100;
    const type =
      typeof req.query.type === 'string' && req.query.type.trim().length > 0
        ? req.query.type.trim().toUpperCase()
        : undefined;
    const status =
      typeof req.query.status === 'string' && req.query.status.trim().length > 0
        ? req.query.status.trim().toUpperCase()
        : undefined;

    const events = await prisma.websiteIntakeEvent.findMany({
      where: {
        orgId,
        ...(type === 'CONTACT' || type === 'PRICE_MATCH' ? { type } : {}),
        ...(status === 'RECEIVED' || status === 'PROCESSED' || status === 'FAILED'
          ? { status }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take,
    });

    res.json({ events });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/api/leads/pipeline', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireAnyPermission(req, orgId, [
      'crm:lead:read',
      'crm:read',
      'crm:write',
      'crm:*',
      '*',
    ]);

    const ownerUserId =
      typeof req.query.ownerUserId === 'string' && req.query.ownerUserId.trim().length > 0
        ? req.query.ownerUserId.trim()
        : undefined;
    const leadType =
      typeof req.query.leadType === 'string' && req.query.leadType.trim().length > 0
        ? req.query.leadType.trim().toUpperCase()
        : undefined;
    const slaStatusFilter =
      typeof req.query.slaStatus === 'string' && req.query.slaStatus.trim().length > 0
        ? req.query.slaStatus.trim().toUpperCase()
        : undefined;
    const overdueOnly = req.query.overdue === 'true';

    const [policy, leads] = await Promise.all([
      prisma.leadSlaPolicy.findUnique({
        where: { orgId },
        select: { dueSoonMinutes: true },
      }),
      prisma.lead.findMany({
        where: {
          orgId,
          ...(ownerUserId ? { ownerUserId } : {}),
          ...(leadType && leadType in LeadType
            ? { leadType: leadType as LeadType }
            : {}),
        },
        include: {
          ownerUser: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          salesTasks: {
            where: {
              isNextAction: true,
              status: {
                in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS],
              },
            },
            orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
            take: 1,
          },
        },
        orderBy: [{ updatedAt: 'desc' }],
        take: 500,
      }),
    ]);
    const leadIds = leads.map((lead) => lead.id);
    const siteCounts =
      leadIds.length > 0
        ? await prisma.leadSite.groupBy({
            by: ['leadId'],
            where: {
              orgId,
              leadId: { in: leadIds },
            },
            _count: {
              leadId: true,
            },
          })
        : [];
    const siteCountMap = new Map<string, number>(
      siteCounts.map((row) => [row.leadId, row._count.leadId]),
    );

    const dueSoonMinutes =
      typeof policy?.dueSoonMinutes === 'number' && Number.isFinite(policy.dueSoonMinutes)
        ? Math.max(1, Math.floor(policy.dueSoonMinutes))
        : 60;
    const now = new Date();

    const leadViews = leads
      .map((lead) => {
        const stage = normalizeLeadStage(lead.stage);
        const sla = evaluateLeadSlaStatus(lead.nextTouchDueAt, dueSoonMinutes, now);
        const siteCount = siteCountMap.get(lead.id) ?? 0;
        return {
          ...lead,
          stage,
          slaStatus: sla.slaStatus,
          slaMinutesUntilDue: sla.minutesUntilDue,
          siteCount,
          commercialNeedsSite:
            (lead.leadType === LeadType.COMMERCIAL || lead.leadType === LeadType.RESIDENTIAL_MULTI_PROPERTY) &&
            siteCount === 0,
          nextActionTask: lead.salesTasks[0] ?? null,
        };
      })
      .filter((lead) => {
        if (overdueOnly && lead.slaStatus !== 'OVERDUE') {
          return false;
        }
        if (
          (slaStatusFilter === 'OK' || slaStatusFilter === 'DUE_SOON' || slaStatusFilter === 'OVERDUE') &&
          lead.slaStatus !== slaStatusFilter
        ) {
          return false;
        }
        return true;
      });

    const columns = LEAD_PIPELINE_STAGES.map((stage) => {
      const stageLeads = leadViews.filter((lead) => normalizeLeadStage(lead.stage) === stage);
      return {
        stage,
        count: stageLeads.length,
        leadIds: stageLeads.map((lead) => lead.id),
      };
    });

    const ownersMap = new Map<string, { id: string; name: string | null; email: string }>();
    for (const lead of leadViews) {
      if (lead.ownerUser?.id) {
        ownersMap.set(lead.ownerUser.id, {
          id: lead.ownerUser.id,
          name: lead.ownerUser.name,
          email: lead.ownerUser.email,
        });
      }
    }

    res.json({
      dueSoonMinutes,
      leads: leadViews,
      columns,
      owners: [...ownersMap.values()],
      totals: {
        all: leadViews.length,
        overdue: leadViews.filter((lead) => lead.slaStatus === 'OVERDUE').length,
        dueSoon: leadViews.filter((lead) => lead.slaStatus === 'DUE_SOON').length,
      },
    });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/leads/profile/upsert', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['crm:lead:write', 'crm:write', 'crm:*', '*']);
    const payload =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};

    const result = await registry.execute(
      'lead.profile.upsert',
      payload,
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-lead-care',
        isAutonomous: false,
        reason:
          typeof payload.reason === 'string' && payload.reason.trim().length > 0
            ? payload.reason.trim()
            : 'Upsert lead profile',
      },
    );

    res.status(executionStatusCode(result, 201)).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/leads/:id/sites', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['crm:lead:write', 'crm:write', 'crm:*', '*']);
    const payload =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    const leadId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const result = await registry.execute(
      'lead.site.upsert',
      {
        ...payload,
        leadId,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-lead-care',
        isAutonomous: false,
        reason:
          typeof payload.reason === 'string' && payload.reason.trim().length > 0
            ? payload.reason.trim()
            : 'Upsert lead site',
      },
    );

    res.status(executionStatusCode(result, 201)).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.patch('/api/leads/:id/stage', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['crm:lead:write', 'crm:write', 'crm:*', '*']);
    const payload =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    const leadId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const result = await registry.execute(
      'lead.stage.update',
      {
        ...payload,
        leadId,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-lead-care',
        isAutonomous: false,
        reason:
          typeof payload.reason === 'string' && payload.reason.trim().length > 0
            ? payload.reason.trim()
            : 'Update lead stage',
      },
    );

    res.status(executionStatusCode(result, 200)).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.patch('/api/leads/:id/owner', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['crm:lead:write', 'crm:write', 'crm:*', '*']);
    const payload =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    const leadId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const result = await registry.execute(
      'lead.owner.assign',
      {
        ...payload,
        leadId,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-lead-care',
        isAutonomous: false,
        reason:
          typeof payload.reason === 'string' && payload.reason.trim().length > 0
            ? payload.reason.trim()
            : 'Assign lead owner',
      },
    );

    res.status(executionStatusCode(result, 200)).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/leads/:id/touch', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['crm:lead:write', 'crm:write', 'crm:*', '*']);
    const payload =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    const leadId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const result = await registry.execute(
      'lead.touch.record',
      {
        ...payload,
        leadId,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-lead-care',
        isAutonomous: false,
        reason: 'Record lead touch',
      },
    );

    res.status(executionStatusCode(result, 201)).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/leads/:id/next-action', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['crm:task:write', 'crm:lead:write', 'crm:write', 'crm:*', '*']);
    const payload =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    const leadId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const result = await registry.execute(
      'lead.nextAction.set',
      {
        ...payload,
        leadId,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-lead-care',
        isAutonomous: false,
        reason: 'Set lead next action',
      },
    );

    res.status(executionStatusCode(result, 201)).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/leads/:id/nurture', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['crm:lead:write', 'crm:write', 'crm:*', '*']);
    const payload =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    const leadId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const result = await registry.execute(
      'lead.nurture.enroll',
      {
        ...payload,
        leadId,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-lead-care',
        isAutonomous: false,
        reason: 'Enroll lead in nurture cadence',
      },
    );

    res.status(executionStatusCode(result, 201)).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/api/leads/:id/sla', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['crm:lead:read', 'crm:read', 'crm:write', 'crm:*', '*']);
    const leadId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const result = await registry.execute(
      'lead.sla.evaluate',
      { leadId },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-lead-care',
        isAutonomous: false,
        reason: 'Evaluate lead SLA',
      },
    );

    res.status(executionStatusCode(result, 200)).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/api/leads/:id/sites', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireAnyPermission(req, orgId, ['crm:lead:read', 'crm:read', 'crm:write', 'crm:*', '*']);
    const leadId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const sites = await prisma.leadSite.findMany({
      where: {
        orgId,
        leadId,
      },
      orderBy: [{ createdAt: 'asc' }],
    });

    res.json({ sites });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/api/leads/:id/next-action', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireAnyPermission(req, orgId, ['crm:lead:read', 'crm:task:read', 'crm:read', 'crm:write', 'crm:*', '*']);
    const leadId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const task = await prisma.task.findFirst({
      where: {
        orgId,
        leadId,
        isNextAction: true,
        status: {
          in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS],
        },
      },
      include: {
        assignedToUser: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
      orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
    });

    res.json({ task });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/api/leads/:id', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireAnyPermission(req, orgId, ['crm:lead:read', 'crm:read', 'crm:write', 'crm:*', '*']);
    const lead = await prisma.lead.findFirst({
      where: {
        orgId,
        id: req.params.id,
      },
      include: {
        ownerUser: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        sites: {
          orderBy: { createdAt: 'asc' },
        },
        salesTasks: {
          where: {
            isNextAction: true,
            status: {
              in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS],
            },
          },
          include: {
            assignedToUser: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
          orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
          take: 1,
        },
      },
    });

    if (!lead) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }

    const dueSoonMinutes =
      (await prisma.leadSlaPolicy.findUnique({
        where: { orgId },
        select: { dueSoonMinutes: true },
      }))?.dueSoonMinutes ?? 60;
    const sla = evaluateLeadSlaStatus(lead.nextTouchDueAt, dueSoonMinutes);

    res.json({
      lead: {
        ...lead,
        stage: normalizeLeadStage(lead.stage),
        slaStatus: sla.slaStatus,
        slaMinutesUntilDue: sla.minutesUntilDue,
        nextActionTask: lead.salesTasks[0] ?? null,
      },
    });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/api/leads/:id/attribution', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const leadId = req.params.id;
    const takeRaw = Number(req.query.limit ?? 30);
    const take = Number.isFinite(takeRaw) ? Math.min(Math.max(takeRaw, 1), 200) : 30;

    const events = await prisma.attributionEvent.findMany({
      where: {
        orgId,
        leadId,
      },
      orderBy: { capturedAt: 'desc' },
      take,
    });

    res.json({ events });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.get('/api/leads/:id/price-match', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const leadId = req.params.id;
    await requireAnyPermission(req, orgId, [
      'crm:read',
      'crm:write',
      'crm:lead:write',
    ]);
    const takeRaw = Number(req.query.limit ?? 30);
    const take = Number.isFinite(takeRaw) ? Math.min(Math.max(takeRaw, 1), 200) : 30;

    const requests = await prisma.priceMatchRequest.findMany({
      where: {
        orgId,
        leadId,
      },
      include: {
        attachmentRef: true,
      },
      orderBy: { createdAt: 'desc' },
      take,
    });

    res.json({ requests });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/api/leads/:id/timeline', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const leadId = req.params.id;
    const take = Number(req.query.limit ?? 100);

    const [executions, callEvents, attributionEvents, timelineEvents] = await Promise.all([
      prisma.toolExecution.findMany({
        where: { orgId },
        include: { toolDefinition: true },
        orderBy: { createdAt: 'desc' },
        take: 400,
      }),
      prisma.callEvent.findMany({
        where: {
          orgId,
          matchedLeadId: leadId,
        },
        orderBy: { startedAt: 'desc' },
        take: 150,
      }),
      prisma.attributionEvent.findMany({
        where: {
          orgId,
          leadId,
        },
        orderBy: { capturedAt: 'desc' },
        take: 150,
      }),
      prisma.timelineEvent.findMany({
        where: {
          orgId,
          leadId,
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
    ]);

    const executionTimeline = executions
      .filter((execution) => {
        const payloadLeadId = getPayloadStringField(
          execution.inputPayload,
          'leadId',
        );
        const payloadCustomerId = getPayloadStringField(
          execution.inputPayload,
          'customerId',
        );
        return payloadLeadId === leadId || payloadCustomerId === leadId;
      })
      .map((entry) => ({
        ...entry,
        timelineKind: 'TOOL_EXECUTION',
        timelineAt: entry.createdAt,
      }));

    const callTimeline = callEvents.map((entry) => ({
      id: `call_${entry.id}`,
      timelineKind: 'CALL_EVENT',
      timelineAt: entry.startedAt,
      createdAt: entry.createdAt,
      status: entry.answered ? 'ANSWERED' : 'MISSED',
      summary: `${entry.direction} ${entry.fromNumber} -> ${entry.toNumber}`,
      callEvent: entry,
    }));

    const attributionTimeline = attributionEvents.map((entry) => ({
      id: `attrib_${entry.id}`,
      timelineKind: 'ATTRIBUTION_EVENT',
      timelineAt: entry.capturedAt,
      createdAt: entry.capturedAt,
      status: entry.sourceType,
      summary: `${entry.utmSource ?? 'direct'} / ${entry.utmCampaign ?? 'no-campaign'}`,
      attributionEvent: entry,
    }));

    const crmTimeline = timelineEvents.map((entry) => ({
      id: `timeline_${entry.id}`,
      timelineKind: 'CRM_TIMELINE_EVENT',
      timelineAt: entry.createdAt,
      createdAt: entry.createdAt,
      status: entry.type,
      summary: entry.message,
      timelineEvent: entry,
    }));

    const timeline = [
      ...executionTimeline,
      ...callTimeline,
      ...attributionTimeline,
      ...crmTimeline,
    ]
      .sort((a, b) => new Date(b.timelineAt).getTime() - new Date(a.timelineAt).getTime())
      .slice(0, Number.isNaN(take) ? 100 : Math.min(take, 200));

    res.json({ timeline });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.post('/api/system-assessments', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, [
      'crm:write',
      'crm:*',
      '*',
    ]);

    const payload =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};

    const result = await registry.execute(
      'crm.assessment.create',
      payload,
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-system-assessment',
        isAutonomous: false,
        reason: 'Create system assessment',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 201
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/api/system-assessments/:id', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['crm:read', 'crm:write', 'crm:*', '*']);

    const assessment = await prisma.systemAssessment.findFirst({
      where: {
        orgId,
        id: req.params.id,
      },
      include: {
        assessmentAttachments: {
          where: { orgId },
          include: {
            attachmentRef: true,
          },
          orderBy: { createdAt: 'desc' },
        },
        equipmentLookupRuns: {
          where: { orgId },
          include: {
            selectedSpec: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
        quotes: {
          where: { orgId },
          include: {
            options: {
              orderBy: { optionKey: 'asc' },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
      },
    });

    if (!assessment) {
      res.status(404).json({ error: 'System assessment not found' });
      return;
    }

    const roleNames = await resolveUserRoleNames(access.user.id);
    const canSeeCostDetails = userHasPermission(access.permissions, 'pricebook:cost:read');
    const canSeeMarginDetails = roleNames.some(
      (role) => role === 'owner' || role === 'admin',
    );

    res.json({
      assessment: {
        ...assessment,
        quotes: assessment.quotes.map((quote) => ({
          ...quote,
          options: quote.options.map((option) =>
            sanitizeQuoteOptionForViewer(option as unknown as Record<string, any>, {
              canSeeCostDetails,
              canSeeMarginDetails,
            }),
          ),
        })),
      },
    });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/system-assessments/:id/update', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['crm:write', 'crm:*', '*']);
    const assessmentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const payload =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};

    const result = await registry.execute(
      'crm.assessment.update',
      {
        ...payload,
        assessmentId,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-system-assessment',
        isAutonomous: false,
        reason: 'Update system assessment sizing/verification',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 200
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/assessments/:id/install-pricing-inputs', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['crm:write', 'crm:*', '*']);
    const assessmentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const payload =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};

    const result = await registry.execute(
      'crm.assessment.updateInstallPricingInputs',
      {
        ...payload,
        assessmentId,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-install-pricing-inputs',
        isAutonomous: false,
        reason: 'Update install pricing assessment inputs',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 200
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/quotes/install/generate', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['crm:write', 'crm:*', '*']);
    const payload =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};

    const result = await registry.execute(
      'crm.quote.generateInstallOptions',
      payload,
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-install-quote-generate',
        isAutonomous: false,
        reason:
          typeof payload.reason === 'string' && payload.reason.trim().length > 0
            ? payload.reason.trim()
            : 'Generate install quote options',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 201
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/quotes/options/:id/discount', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, [
      'pricing:discount:apply_pct',
      'pricing:discount:apply_cents',
      'pricing:discount:override_limits',
      '*',
    ]);
    const quoteOptionId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const payload =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};

    const result = await registry.execute(
      'crm.quote.applyDiscount',
      {
        ...payload,
        quoteOptionId,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-install-quote-discount',
        isAutonomous: false,
        reason:
          typeof payload.reason === 'string' && payload.reason.trim().length > 0
            ? payload.reason.trim()
            : 'Apply install quote discount',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 200
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/quotes/options/:id/override-block', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const ownerAccess = await requireOwnerOrAdmin(req, orgId);
    const quoteOptionId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const payload =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};

    const result = await registry.execute(
      'system.pricing.overrideBlock',
      {
        ...payload,
        quoteOptionId,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: ownerAccess.user.id,
        actorLabel: 'api-pricing-override',
        isAutonomous: false,
        reason:
          typeof payload.reason === 'string' && payload.reason.trim().length > 0
            ? payload.reason.trim()
            : 'Override pricing block',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 200
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/api/pricebook/categories', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireAnyPermission(req, orgId, [
      'crm:service_quote:read',
      'crm:read',
      'crm:write',
      'crm:*',
      '*',
    ]);

    const categories = await prisma.pricebookCategory.findMany({
      where: { orgId },
      orderBy: [{ name: 'asc' }],
    });
    res.json({ categories });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.get('/api/pricebook/items', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireAnyPermission(req, orgId, [
      'crm:service_quote:read',
      'crm:read',
      'crm:write',
      'crm:*',
      '*',
    ]);

    const activeOnly = req.query.active !== 'false';
    const search =
      typeof req.query.search === 'string' ? req.query.search.trim() : '';

    const items = await prisma.pricebookItem.findMany({
      where: {
        orgId,
        ...(activeOnly ? { active: true } : {}),
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { description: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: {
        category: true,
      },
      orderBy: [{ category: { name: 'asc' } }, { name: 'asc' }],
    });

    res.json({
      items: items.map((item) => ({
        id: item.id,
        categoryId: item.categoryId,
        categoryName: item.category.name,
        categorySlug: item.category.slug,
        kind: item.kind,
        name: item.name,
        description: item.description,
        unitType: item.unitType,
        defaultSellCents: item.defaultSellCents,
        active: item.active,
        tags: item.tags,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.get('/api/service/bundles', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireAnyPermission(req, orgId, [
      'crm:service_quote:read',
      'crm:read',
      'crm:write',
      'crm:*',
      '*',
    ]);

    const activeOnly = req.query.active !== 'false';
    const templates = await prisma.serviceBundleTemplate.findMany({
      where: {
        orgId,
        ...(activeOnly ? { active: true } : {}),
      },
      orderBy: [{ name: 'asc' }],
    });

    const allItemIds = new Set<string>();
    for (const bundle of templates) {
      const base = Array.isArray(bundle.baseItemIds) ? bundle.baseItemIds : [];
      const addOns = Array.isArray(bundle.recommendedAddOnItemIds)
        ? bundle.recommendedAddOnItemIds
        : [];
      for (const raw of [...base, ...addOns]) {
        if (typeof raw === 'string' && raw.trim().length > 0) {
          allItemIds.add(raw.trim());
        }
      }
    }

    const items = allItemIds.size
      ? await prisma.pricebookItem.findMany({
          where: {
            orgId,
            id: { in: [...allItemIds] },
          },
          include: {
            category: true,
          },
        })
      : [];
    const itemById = new Map(items.map((item) => [item.id, item]));

    res.json({
      bundles: templates.map((bundle) => {
        const baseItemIds = Array.isArray(bundle.baseItemIds)
          ? bundle.baseItemIds.filter((value): value is string => typeof value === 'string')
          : [];
        const recommendedAddOnItemIds = Array.isArray(bundle.recommendedAddOnItemIds)
          ? bundle.recommendedAddOnItemIds.filter((value): value is string => typeof value === 'string')
          : [];
        return {
          id: bundle.id,
          name: bundle.name,
          active: bundle.active,
          includeDiagnostic: bundle.includeDiagnostic,
          defaultLaborHours: bundle.defaultLaborHours,
          baseItemIds,
          recommendedAddOnItemIds,
          baseItems: baseItemIds
            .map((itemId) => itemById.get(itemId))
            .filter((item): item is NonNullable<typeof item> => Boolean(item))
            .map((item) => ({
              id: item.id,
              name: item.name,
              categorySlug: item.category.slug,
              kind: item.kind,
              defaultSellCents: item.defaultSellCents,
            })),
          recommendedAddOns: recommendedAddOnItemIds
            .map((itemId) => itemById.get(itemId))
            .filter((item): item is NonNullable<typeof item> => Boolean(item))
            .map((item) => ({
              id: item.id,
              name: item.name,
              categorySlug: item.category.slug,
              kind: item.kind,
              defaultSellCents: item.defaultSellCents,
            })),
        };
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.post('/api/quotes/service/bundle', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, [
      'crm:service_quote:write',
      'crm:write',
      'crm:*',
      '*',
    ]);
    const payload =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};

    const result = await registry.execute(
      'crm.serviceQuote.createFromBundle',
      payload,
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-service-quote',
        isAutonomous: false,
        reason: 'Create service quote from bundle',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 201
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/quotes/service/:id/line-items', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, [
      'crm:service_quote:write',
      'crm:write',
      'crm:*',
      '*',
    ]);

    const body =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};

    const result = await registry.execute(
      'crm.serviceQuote.addLineItem',
      {
        ...body,
        quoteId: req.params.id,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-service-quote',
        isAutonomous: false,
        reason: 'Add service quote line item',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 200
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.delete('/api/quotes/service/line-items/:lineItemId', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, [
      'crm:service_quote:write',
      'crm:write',
      'crm:*',
      '*',
    ]);

    const result = await registry.execute(
      'crm.serviceQuote.removeLineItem',
      {
        quoteLineItemId: req.params.lineItemId,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-service-quote',
        isAutonomous: false,
        reason: 'Remove service quote line item',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 200
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/quotes/service/:id/labor-hours', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, [
      'crm:service_quote:write',
      'crm:write',
      'crm:*',
      '*',
    ]);
    const body =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};

    const result = await registry.execute(
      'crm.serviceQuote.setLaborHours',
      {
        quoteId: req.params.id,
        laborHours: body.laborHours,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-service-quote',
        isAutonomous: false,
        reason: 'Set service quote labor hours',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 200
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/quotes/service/:id/timing', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, [
      'crm:service_quote:write',
      'crm:write',
      'crm:*',
      '*',
    ]);
    const body =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};

    const result = await registry.execute(
      'crm.serviceQuote.setTiming',
      {
        quoteId: req.params.id,
        timing: body.timing,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-service-quote',
        isAutonomous: false,
        reason: 'Set service quote timing',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 200
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/quotes/service/:id/discount', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, [
      'pricing:discount:apply_pct',
      'pricing:discount:apply_cents',
      'pricing:discount:override_limits',
      '*',
    ]);
    const body =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};

    const result = await registry.execute(
      'crm.serviceQuote.applyDiscount',
      {
        quoteId: req.params.id,
        discountPctBps: body.discountPctBps,
        discountCents: body.discountCents,
        reason: body.reason,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-service-quote',
        isAutonomous: false,
        reason:
          typeof body.reason === 'string' && body.reason.trim().length > 0
            ? body.reason.trim()
            : 'Apply service quote discount',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 200
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/quotes/service/:id/override-block', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const ownerAccess = await requireOwnerOrAdmin(req, orgId);
    const body =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};

    const result = await registry.execute(
      'system.pricing.overrideBlock',
      {
        quoteId: req.params.id,
        reason: body.reason,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: ownerAccess.user.id,
        actorLabel: 'api-service-quote',
        isAutonomous: false,
        reason:
          typeof body.reason === 'string' && body.reason.trim().length > 0
            ? body.reason.trim()
            : 'Owner override service quote pricing block',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 200
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/api/quotes/service/:id', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireAnyPermission(req, orgId, [
      'crm:service_quote:read',
      'crm:read',
      'crm:write',
      'crm:*',
      '*',
    ]);

    const quote = await prisma.quote.findFirst({
      where: {
        orgId,
        id: req.params.id,
        kind: 'SERVICE',
      },
      include: {
        lead: true,
        customer: true,
        lineItems: {
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });
    if (!quote) {
      res.status(404).json({ error: 'Service quote not found' });
      return;
    }

    const metadata = (quote.metadata ?? {}) as Record<string, unknown>;
    const servicePricing = (metadata.servicePricing ?? {}) as Record<string, unknown>;
    const recommendedAddOnItemIds = Array.isArray(servicePricing.recommendedAddOnItemIds)
      ? servicePricing.recommendedAddOnItemIds.filter((value): value is string => typeof value === 'string')
      : [];

    const recommendedAddOns = recommendedAddOnItemIds.length
      ? await prisma.pricebookItem.findMany({
          where: {
            orgId,
            id: { in: recommendedAddOnItemIds },
          },
          include: {
            category: true,
          },
          orderBy: { name: 'asc' },
        })
      : [];

    res.json({
      quote: {
        ...quote,
        lineItems: quote.lineItems,
        recommendedAddOns: recommendedAddOns.map((item) => ({
          id: item.id,
          name: item.name,
          kind: item.kind,
          defaultSellCents: item.defaultSellCents,
          categorySlug: item.category.slug,
        })),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.get('/api/admin/pricebook/categories', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireOwnerOrAdmin(req, orgId);
    const categories = await prisma.pricebookCategory.findMany({
      where: { orgId },
      orderBy: [{ name: 'asc' }],
    });
    res.json({ categories });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/api/admin/pricebook/items', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireOwnerOrAdmin(req, orgId);
    const items = await prisma.pricebookItem.findMany({
      where: { orgId },
      include: {
        category: true,
      },
      orderBy: [{ category: { name: 'asc' } }, { name: 'asc' }],
    });
    res.json({ items });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/api/admin/bundles', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireOwnerOrAdmin(req, orgId);
    const bundles = await prisma.serviceBundleTemplate.findMany({
      where: { orgId },
      orderBy: [{ name: 'asc' }],
    });
    res.json({ bundles });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/admin/pricebook/categories', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const ownerAccess = await requireOwnerOrAdmin(req, orgId);
    const payload =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};

    const result = await registry.execute(
      'admin.pricebook.upsertCategory',
      payload,
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: ownerAccess.user.id,
        actorLabel: 'api-admin-pricebook',
        isAutonomous: false,
        reason: 'Upsert pricebook category',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 200
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/admin/pricebook/items', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const ownerAccess = await requireOwnerOrAdmin(req, orgId);
    const payload =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};

    const result = await registry.execute(
      'admin.pricebook.upsertItem',
      payload,
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: ownerAccess.user.id,
        actorLabel: 'api-admin-pricebook',
        isAutonomous: false,
        reason: 'Upsert pricebook item',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 200
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/admin/bundles', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const ownerAccess = await requireOwnerOrAdmin(req, orgId);
    const payload =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};

    const result = await registry.execute(
      'admin.bundleTemplates.upsert',
      payload,
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: ownerAccess.user.id,
        actorLabel: 'api-admin-bundles',
        isAutonomous: false,
        reason: 'Upsert service bundle template',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 200
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post(
  '/api/system-assessments/:id/nameplate-photo',
  assessmentNameplateUpload.single('file'),
  async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const access = await requireAnyPermission(req, orgId, [
        'crm:attachment:write',
        'crm:write',
        'crm:*',
        '*',
      ]);

      if (!req.file) {
        res.status(400).json({ error: 'file is required (multipart/form-data)' });
        return;
      }

      const assessmentId = Array.isArray(req.params.id)
        ? req.params.id[0]
        : req.params.id;
      const assessment = await prisma.systemAssessment.findFirst({
        where: {
          orgId,
          id: assessmentId,
        },
        select: { id: true },
      });
      if (!assessment) {
        res.status(404).json({ error: 'System assessment not found' });
        return;
      }

      const file = req.file;
      const originalName = file.originalname || 'nameplate-photo.jpg';
      const extension = extname(originalName).toLowerCase() || '.jpg';
      const safeExtension = extension.startsWith('.') ? extension : '.jpg';
      const objectKey = `assessments/${assessmentId}/nameplate/${Date.now()}-${randomUUID()}${safeExtension}`;

      const uploaded = await putObject({
        objectKey,
        body: file.buffer,
        contentType: file.mimetype || 'image/jpeg',
        metadata: {
          source: 'nameplate_capture',
          orgId,
          assessmentId,
          uploadedByUserId: access.user.id,
        },
      });

      const checksumSha256 = uploaded.checksumSha256 ?? (await computeChecksum(file.buffer));
      const attachmentResult = await registry.execute(
        'crm.attachmentRef.create',
        {
          provider: 'S3',
          bucket: uploaded.bucket,
          objectKey: uploaded.objectKey,
          fileName: originalName,
          mimeType: file.mimetype || 'image/jpeg',
          sizeBytes: file.size,
          checksumSha256,
          metadata: {
            source: 'nameplate_capture',
            assessmentId,
          },
        },
        {
          orgId,
          actorType: ActorType.HUMAN,
          actorUserId: access.user.id,
          actorLabel: 'api-nameplate-capture',
          isAutonomous: false,
          reason: 'Create attachment ref for nameplate photo',
        },
      );
      ensureToolExecuted(attachmentResult, 'crm.attachmentRef.create');

      const attachmentOutput = getExecutionOutputObject(attachmentResult.output);
      const attachmentObject = getExecutionOutputObject(attachmentOutput.attachmentRef);
      const attachmentRefId =
        typeof attachmentOutput.attachmentRefId === 'string'
          ? attachmentOutput.attachmentRefId
          : typeof attachmentObject.id === 'string'
            ? attachmentObject.id
            : '';
      if (!attachmentRefId) {
        throw new Error('AttachmentRef creation returned no attachmentRefId');
      }

      const attachResult = await registry.execute(
        'crm.assessment.attachment.add',
        {
          assessmentId,
          attachmentRefId,
          kind: 'NAMEPLATE_PHOTO',
        },
        {
          orgId,
          actorType: ActorType.HUMAN,
          actorUserId: access.user.id,
          actorLabel: 'api-nameplate-capture',
          isAutonomous: false,
          reason: 'Attach nameplate photo to system assessment',
        },
      );

      const statusCode =
        attachResult.status === 'EXECUTED'
          ? 201
          : attachResult.status === 'BLOCKED'
            ? 403
            : 202;

      res.status(statusCode).json({
        attachmentResult,
        attachResult,
        attachmentRefId,
        objectKey: uploaded.objectKey,
      });
    } catch (error) {
      const status = (error as Error & { status?: number }).status ?? 400;
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(status).json({ error: message });
    }
  },
);

app.get('/api/customers', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const take = Number(req.query.limit ?? 100);
    const search =
      typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const customers = await prisma.customer.findMany({
      where: {
        orgId,
        ...(search
          ? {
              OR: [
                { fullName: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
                { phone: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { fullName: 'asc' },
      take: Number.isNaN(take) ? 100 : Math.min(take, 200),
    });

    res.json({ customers });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.get('/api/jobs', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const take = Number(req.query.limit ?? 100);
    const search =
      typeof req.query.search === 'string' ? req.query.search.trim() : '';

    const jobs = await prisma.job.findMany({
      where: {
        orgId,
        ...(search
          ? {
              OR: [
                { title: { contains: search, mode: 'insensitive' } },
                { status: { contains: search, mode: 'insensitive' } },
                {
                  customer: {
                    fullName: { contains: search, mode: 'insensitive' },
                  },
                },
              ],
            }
          : {}),
      },
      include: {
        customer: true,
      },
      orderBy: [{ updatedAt: 'desc' }],
      take: Number.isNaN(take) ? 100 : Math.min(take, 200),
    });

    res.json({ jobs });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.get('/api/comms/threads', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireAnyPermission(req, orgId, ['comms:read', 'comms:triage', '*']);

    const filter =
      typeof req.query.filter === 'string'
        ? req.query.filter.trim().toUpperCase()
        : 'ALL';
    const takeRaw = Number(req.query.limit ?? 50);
    const take =
      Number.isFinite(takeRaw) && takeRaw > 0
        ? Math.min(Math.floor(takeRaw), 200)
        : 50;

    const threads = await prisma.commsThread.findMany({
      where: { orgId },
      include: {
        entityLinks: {
          orderBy: { createdAt: 'desc' },
        },
        messages: {
          orderBy: { sentAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { lastMessageAt: 'desc' },
      take,
    });

    const rows = threads
      .map((thread) => {
        const latestMessage = thread.messages[0] ?? null;
        const linked = thread.entityLinks.length > 0;
        const needsTriage =
          !linked || latestMessage?.direction === 'INBOUND' && latestMessage?.triagedAt === null;

        return {
          id: thread.id,
          channel: thread.channel,
          subject: thread.subject,
          externalThreadId: thread.externalThreadId,
          participants: commsParticipantsFromJson(thread.participantsJson),
          lastMessageAt: thread.lastMessageAt.toISOString(),
          latestMessage: latestMessage
            ? {
                id: latestMessage.id,
                direction: latestMessage.direction,
                status: latestMessage.status,
                bodyText: latestMessage.bodyText,
                snippet: latestMessage.snippet,
                sentAt: latestMessage.sentAt.toISOString(),
                triagedAt: latestMessage.triagedAt?.toISOString() ?? null,
              }
            : null,
          links: thread.entityLinks.map((link) => ({
            id: link.id,
            entityType: link.entityType,
            entityId: link.entityId,
            confidence: link.confidence,
            reason: link.reason,
          })),
          linked,
          needsTriage,
        };
      })
      .filter((row) => {
        if (filter === 'NEEDS_TRIAGE' || filter === 'UNLINKED') {
          return row.needsTriage;
        }
        if (filter === 'LINKED') {
          return row.linked;
        }
        return true;
      });

    res.json({ threads: rows });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/api/comms/threads/:id', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireAnyPermission(req, orgId, ['comms:read', 'comms:triage', '*']);

    const thread = await prisma.commsThread.findFirst({
      where: {
        orgId,
        id: req.params.id,
      },
      include: {
        entityLinks: {
          orderBy: { createdAt: 'desc' },
        },
        messages: {
          orderBy: { sentAt: 'asc' },
          take: 300,
        },
        outboundDrafts: {
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
      },
    });

    if (!thread) {
      res.status(404).json({ error: 'Comms thread not found' });
      return;
    }

    res.json({
      thread: {
        id: thread.id,
        channel: thread.channel,
        subject: thread.subject,
        externalThreadId: thread.externalThreadId,
        participants: commsParticipantsFromJson(thread.participantsJson),
        lastMessageAt: thread.lastMessageAt.toISOString(),
      },
      messages: thread.messages.map((message) => ({
        id: message.id,
        channel: message.channel,
        direction: message.direction,
        status: message.status,
        sentAt: message.sentAt.toISOString(),
        bodyText: message.bodyText,
        bodyHtml: message.bodyHtml,
        snippet: message.snippet,
        from: commsParticipantsFromJson(message.fromJson),
        to: commsParticipantsFromJson(message.toJson),
        triagedAt: message.triagedAt?.toISOString() ?? null,
      })),
      links: thread.entityLinks.map((link) => ({
        id: link.id,
        entityType: link.entityType,
        entityId: link.entityId,
        confidence: link.confidence,
        reason: link.reason,
      })),
      drafts: thread.outboundDrafts.map((draft) => ({
        id: draft.id,
        status: draft.status,
        channel: draft.channel,
        subject: draft.subject,
        bodyText: draft.bodyText,
        error: draft.error,
        createdAt: draft.createdAt.toISOString(),
        approvedAt: draft.approvedAt?.toISOString() ?? null,
        sentAt: draft.sentAt?.toISOString() ?? null,
      })),
    });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/comms/sync/imessage', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['comms:sync', '*']);

    const result = await registry.execute(
      'comms.imessage.sync',
      {
        accountId: req.body?.accountId,
        externalAccountId: req.body?.externalAccountId,
        displayName: req.body?.displayName,
        fullSync: req.body?.fullSync,
        batchSize: req.body?.batchSize,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-comms-sync-imessage',
        isAutonomous: false,
        reason: typeof req.body?.reason === 'string' ? req.body.reason : 'Manual iMessage sync',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 200
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/comms/sync/gmail', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['comms:sync', '*']);

    const result = await registry.execute(
      'comms.gmail.sync',
      {
        accountId: req.body?.accountId,
        externalAccountId: req.body?.externalAccountId,
        displayName: req.body?.displayName,
        fullSync: req.body?.fullSync,
        batchSize: req.body?.batchSize,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-comms-sync-gmail',
        isAutonomous: false,
        reason: typeof req.body?.reason === 'string' ? req.body.reason : 'Manual Gmail sync',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 200
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/comms/threads/:id/link', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['comms:triage', '*']);

    const result = await registry.execute(
      'comms.thread.link',
      {
        threadId: req.params.id,
        entityType: req.body?.entityType,
        entityId: req.body?.entityId,
        confidence: req.body?.confidence,
        reason: req.body?.reason,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-comms-thread-link',
        isAutonomous: false,
        reason: typeof req.body?.reason === 'string' ? req.body.reason : 'Link communications thread',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 200
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/comms/threads/:id/create-lead', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['comms:triage', 'crm:write', '*']);

    const thread = await prisma.commsThread.findFirst({
      where: { id: req.params.id, orgId },
      include: {
        messages: {
          where: {
            direction: 'INBOUND',
          },
          orderBy: { sentAt: 'desc' },
          take: 1,
        },
      },
    });
    if (!thread) {
      res.status(404).json({ error: 'Comms thread not found' });
      return;
    }

    const participants = commsParticipantsFromJson(thread.participantsJson);
    const bestParticipant = participants.find((participant) => participant.email || participant.phone || participant.raw) ?? null;
    const latestInbound = thread.messages[0] ?? null;
    const inferredName =
      (bestParticipant?.name && bestParticipant.name.trim().length > 0
        ? bestParticipant.name.trim()
        : bestParticipant?.email || bestParticipant?.phone || bestParticipant?.raw || 'Inbound Contact');

    const leadResult = await registry.execute(
      'crm.lead.create',
      {
        fullName: inferredName,
        email: bestParticipant?.email ?? undefined,
        phone: bestParticipant?.phone ?? bestParticipant?.raw ?? undefined,
        status: 'NEW',
        notes: latestInbound?.bodyText ?? latestInbound?.snippet ?? 'Lead created from communications triage.',
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-comms-create-lead',
        isAutonomous: false,
        reason: 'Create lead from communications thread',
      },
    );
    ensureToolExecuted(leadResult, 'crm.lead.create');
    const leadOutput = getExecutionOutputObject(leadResult.output);
    const leadObject =
      leadOutput.lead && typeof leadOutput.lead === 'object' && !Array.isArray(leadOutput.lead)
        ? (leadOutput.lead as Record<string, unknown>)
        : null;
    const leadId = typeof leadObject?.id === 'string' ? leadObject.id : null;
    if (!leadId) {
      throw new Error('crm.lead.create did not return lead id');
    }

    const linkResult = await registry.execute(
      'comms.thread.link',
      {
        threadId: thread.id,
        entityType: 'LEAD',
        entityId: leadId,
        confidence: 1,
        reason: 'Linked by operator after creating lead from inbox thread',
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-comms-thread-link',
        isAutonomous: false,
        reason: 'Link communications thread to newly created lead',
      },
    );
    ensureToolExecuted(linkResult, 'comms.thread.link');

    if (latestInbound?.id) {
      await registry.execute(
        'comms.message.markTriaged',
        { messageId: latestInbound.id },
        {
          orgId,
          actorType: ActorType.HUMAN,
          actorUserId: access.user.id,
          actorLabel: 'api-comms-mark-triaged',
          isAutonomous: false,
          reason: 'Mark inbound message triaged after linking lead',
        },
      );
    }

    res.status(201).json({
      leadId,
      threadId: thread.id,
    });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/api/comms/drafts', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireAnyPermission(req, orgId, ['comms:read', 'comms:write', 'comms:send', '*']);

    const statusQuery =
      typeof req.query.status === 'string' ? req.query.status.trim().toUpperCase() : '';
    const status = ['DRAFT', 'QUEUED_APPROVAL', 'SENT', 'FAILED'].includes(statusQuery)
      ? statusQuery
      : undefined;
    const takeRaw = Number(req.query.limit ?? 100);
    const take =
      Number.isFinite(takeRaw) && takeRaw > 0
        ? Math.min(Math.floor(takeRaw), 300)
        : 100;

    const drafts = await prisma.outboundDraft.findMany({
      where: {
        orgId,
        ...(status ? { status: status as CommsStatus } : {}),
      },
      include: {
        thread: {
          select: {
            id: true,
            channel: true,
            subject: true,
            participantsJson: true,
            externalThreadId: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take,
    });

    res.json({
      drafts: drafts.map((draft) => ({
        id: draft.id,
        threadId: draft.threadId,
        channel: draft.channel,
        status: draft.status,
        subject: draft.subject,
        bodyText: draft.bodyText,
        to: commsParticipantsFromJson(draft.toJson),
        requiresApproval: draft.requiresApproval,
        approvedAt: draft.approvedAt?.toISOString() ?? null,
        sentAt: draft.sentAt?.toISOString() ?? null,
        error: draft.error,
        createdAt: draft.createdAt.toISOString(),
        thread: {
          id: draft.thread.id,
          channel: draft.thread.channel,
          subject: draft.thread.subject,
          participants: commsParticipantsFromJson(draft.thread.participantsJson),
          externalThreadId: draft.thread.externalThreadId,
        },
      })),
    });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/comms/drafts', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['comms:write', '*']);

    const threadId = typeof req.body?.threadId === 'string' ? req.body.threadId.trim() : '';
    if (!threadId) {
      res.status(400).json({ error: 'threadId is required' });
      return;
    }

    const thread = await prisma.commsThread.findFirst({
      where: { id: threadId, orgId },
      select: { id: true, channel: true, participantsJson: true },
    });
    if (!thread) {
      res.status(404).json({ error: 'Comms thread not found' });
      return;
    }

    const to =
      Array.isArray(req.body?.to) && req.body.to.length > 0
        ? req.body.to
        : commsParticipantsFromJson(thread.participantsJson);

    const result = await registry.execute(
      'comms.draft.create',
      {
        threadId: thread.id,
        channel: typeof req.body?.channel === 'string' ? req.body.channel.trim().toUpperCase() : thread.channel,
        to,
        subject: req.body?.subject,
        bodyText: req.body?.bodyText,
        bodyHtml: req.body?.bodyHtml,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-comms-draft-create',
        isAutonomous: false,
        reason: typeof req.body?.reason === 'string' ? req.body.reason : 'Create outbound comms draft',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 201
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/comms/drafts/:id/update', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['comms:write', '*']);

    const result = await registry.execute(
      'comms.draft.update',
      {
        draftId: req.params.id,
        subject: req.body?.subject,
        bodyText: req.body?.bodyText,
        bodyHtml: req.body?.bodyHtml,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-comms-draft-update',
        isAutonomous: false,
        reason: typeof req.body?.reason === 'string' ? req.body.reason : 'Edit outbound draft',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 200
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/comms/drafts/:id/approve-send', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['comms:send', '*']);
    const headerRequestId =
      typeof req.header('x-idempotency-key') === 'string'
        ? req.header('x-idempotency-key')?.trim()
        : '';
    const bodyRequestId =
      typeof req.body?.requestId === 'string' ? req.body.requestId.trim() : '';
    const requestId = headerRequestId || bodyRequestId || undefined;

    const result = await registry.execute(
      'comms.draft.approveAndSend',
      {
        draftId: req.params.id,
        requestId,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-comms-draft-approve-send',
        isAutonomous: false,
        reason: typeof req.body?.reason === 'string' ? req.body.reason : 'Approve and send outbound draft',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 200
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/api/dispatch/day', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, [
      'scheduling:read',
      'scheduling:write',
      'jobs:*',
      '*',
    ]);

    const date = parseDateOnlyInput(req.query.date);
    const result = await registry.execute(
      'scheduling.appointment.listForDay',
      { date },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-dispatch-day',
        isAutonomous: false,
      },
    );

    ensureToolExecuted(result, 'scheduling.appointment.listForDay');
    const output = getExecutionOutputObject(result.output);
    res.json(output);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/api/dispatch/techs', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireAnyPermission(req, orgId, ['scheduling:read', 'scheduling:write', 'jobs:*', '*']);

    const users = await prisma.user.findMany({
      where: {
        orgId,
        isActive: true,
        actorType: ActorType.HUMAN,
      },
      include: {
        userRoles: {
          include: {
            role: true,
          },
        },
      },
      orderBy: [{ name: 'asc' }, { email: 'asc' }],
    });

    const techs = users
      .map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        roles: user.userRoles.map((link) => link.role.name.toLowerCase()),
      }))
      .filter((user) =>
        user.roles.some((role) => role.includes('tech') || role.includes('dispatch') || role.includes('install')),
      );

    res.json({ techs });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/api/scheduling/availability', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['scheduling:read', 'scheduling:write', 'jobs:*', '*']);

    const requestedType = typeof req.query.type === 'string' ? req.query.type.trim().toUpperCase() : 'SERVICE_ESTIMATE';
    const type = requestedType === 'INSTALL' ? 'INSTALL' : 'SERVICE_ESTIMATE';
    const startDate = parseDateOnlyInput(req.query.start);
    const endDate = parseDateOnlyInput(req.query.end, new Date(new Date(`${startDate}T00:00:00.000Z`).getTime() + 6 * 24 * 60 * 60 * 1000));

    const result = await registry.execute(
      'scheduling.blocks.listAvailability',
      {
        type,
        startDate,
        endDate,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-scheduling-availability',
        isAutonomous: false,
      },
    );

    ensureToolExecuted(result, 'scheduling.blocks.listAvailability');
    const output = getExecutionOutputObject(result.output);
    res.json(output);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/scheduling/settings', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['scheduling:write', 'system:*', '*']);

    const payload =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};

    const result = await registry.execute(
      'scheduling.settings.update',
      payload,
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-scheduling-settings',
        isAutonomous: false,
        reason: 'Dispatcher settings update',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 200
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/appointments/:id/assign-tech', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['scheduling:write', 'jobs:*', '*']);

    const techUserId = typeof req.body?.techUserId === 'string' ? req.body.techUserId.trim() : '';
    if (!techUserId) {
      res.status(400).json({ error: 'techUserId is required' });
      return;
    }

    const result = await registry.execute(
      'scheduling.appointment.assignTech',
      {
        appointmentId: req.params.id,
        techUserId,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-appointment-assign-tech',
        isAutonomous: false,
        reason: 'Assign technician to appointment',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 200
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/appointments/:id/reschedule', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['scheduling:write', 'jobs:*', '*']);

    const date = typeof req.body?.date === 'string' ? req.body.date.trim() : '';
    const timeBlockCode = typeof req.body?.timeBlockCode === 'string' ? req.body.timeBlockCode.trim() : '';
    if (!date || !timeBlockCode) {
      res.status(400).json({ error: 'date and timeBlockCode are required' });
      return;
    }

    const result = await registry.execute(
      'scheduling.appointment.reschedule',
      {
        appointmentId: req.params.id,
        date,
        timeBlockCode,
        notes: req.body?.notes,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-appointment-reschedule',
        isAutonomous: false,
        reason: 'Reschedule appointment',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 200
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/appointments/:id/cancel', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['scheduling:write', 'jobs:*', '*']);

    const result = await registry.execute(
      'scheduling.appointment.cancel',
      {
        appointmentId: req.params.id,
        reason: req.body?.reason,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-appointment-cancel',
        isAutonomous: false,
        reason: typeof req.body?.reason === 'string' ? req.body.reason : 'Cancel appointment',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 200
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/media/upload/initiate', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['media:write', 'crm:write', 'jobs:*', '*']);
    const parsed = mediaUploadSessionInitiateSchema.parse(req.body ?? {});
    const sessionKey = parsed.sessionKey?.trim() || randomUUID();

    const result = await registry.execute(
      'media.uploadSession.start',
      {
        ...parsed,
        sessionKey,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-media-upload-initiate',
        isAutonomous: false,
        reason: 'Start idempotent media upload session',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 201
        : result.status === 'BLOCKED'
          ? 403
          : 202;

    if (result.status !== 'EXECUTED') {
      res.status(statusCode).json(result);
      return;
    }

    const output = getExecutionOutputObject(result.output);
    const idempotent = Boolean(output.idempotent);

    res.status(idempotent ? 200 : statusCode).json({
      ...result,
      sessionKey,
      output,
    });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/api/media/upload/session/:sessionKey', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireAnyPermission(req, orgId, ['media:read', 'media:write', 'crm:read', 'jobs:*', '*']);

    const rawSessionKey = decodeURIComponent(req.params.sessionKey ?? '').trim();
    if (rawSessionKey.length < 8 || rawSessionKey.length > 128) {
      res.status(400).json({ error: 'Invalid sessionKey' });
      return;
    }

    const session = await prisma.mediaUploadSession.findUnique({
      where: {
        orgId_sessionKey: {
          orgId,
          sessionKey: rawSessionKey,
        },
      },
    });

    if (!session) {
      res.status(404).json({ error: 'Upload session not found' });
      return;
    }

    const attachment = session.attachmentId
      ? await prisma.attachment.findFirst({
          where: {
            id: session.attachmentId,
            orgId,
          },
        })
      : null;

    res.json({
      session,
      attachment,
    });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post(['/api/media/upload', '/api/media/photos'], mediaPhotoUpload.single('file'), async (req, res) => {
  let orgId = '';
  let actorUserId = '';
  let sessionKey = '';
  let ownerType = '';
  let ownerId = '';
  let attachmentId = '';
  const uploadedObjects: Array<{ bucket: string; objectKey: string }> = [];

  const cleanupUploadedObjects = async () => {
    for (const uploaded of uploadedObjects) {
      try {
        await deleteStorageObject(uploaded);
      } catch {
        // Best-effort cleanup on partial upload failures.
      }
    }
  };

  try {
    orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['media:write', 'crm:write', 'jobs:*', '*']);
    actorUserId = access.user.id;

    if (!req.file) {
      res.status(400).json({ error: 'file is required (multipart/form-data)' });
      return;
    }

    ownerType = typeof req.body?.ownerType === 'string' ? req.body.ownerType.trim().toUpperCase() : '';
    ownerId = typeof req.body?.ownerId === 'string' ? req.body.ownerId.trim() : '';
    if ((ownerType !== 'QUOTE' && ownerType !== 'JOB') || !ownerId) {
      res.status(400).json({ error: 'ownerType (QUOTE|JOB) and ownerId are required' });
      return;
    }

    const tagRaw = typeof req.body?.tag === 'string' ? req.body.tag.trim().toUpperCase() : 'OTHER';
    const allowedTags = new Set(['BEFORE', 'AFTER', 'EQUIPMENT_PLATE', 'RECEIPT', 'PROBLEM', 'INSTALL', 'OTHER']);
    const tag = allowedTags.has(tagRaw) ? tagRaw : 'OTHER';
    sessionKey = resolveMediaSessionKey(req);

    const sessionResult = await registry.execute(
      'media.uploadSession.start',
      {
        sessionKey,
        ownerType,
        ownerId,
        tag,
        caption: req.body?.caption,
        fileName: req.file.originalname || 'photo.jpg',
        mimeType: req.file.mimetype || 'application/octet-stream',
        sizeBytes: req.file.size,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-media-upload-start',
        isAutonomous: false,
        reason: 'Start idempotent media upload session',
      },
    );

    if (sessionResult.status !== 'EXECUTED') {
      const statusCode =
        sessionResult.status === 'BLOCKED'
          ? 403
          : 202;
      res.status(statusCode).json(sessionResult);
      return;
    }

    const sessionOutput = getExecutionOutputObject(sessionResult.output);
    const session = getExecutionOutputObject(sessionOutput.session);
    attachmentId =
      typeof session.attachmentId === 'string' && session.attachmentId.trim().length > 0
        ? session.attachmentId
        : randomUUID();

    if (session.status === 'COMPLETED') {
      const existingAttachment = await prisma.attachment.findFirst({
        where: {
          id: attachmentId,
          orgId,
        },
      });
      if (existingAttachment) {
        res.status(200).json({
          status: 'EXECUTED',
          idempotent: true,
          sessionKey,
          output: {
            attachment: existingAttachment,
          },
        });
        return;
      }
    }

    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');

    const derivatives = await buildPhotoDerivatives(
      req.file.buffer,
      req.file.originalname || 'photo.jpg',
      req.file.mimetype || 'application/octet-stream',
    );

    const basePrefix = `org/${orgId}/${year}/${month}/${attachmentId}`;
    const originalObjectKey = `${basePrefix}/original.jpg`;
    const displayObjectKey = `${basePrefix}/display.jpg`;
    const thumbObjectKey = `${basePrefix}/thumb.jpg`;
    const checksumSha256 = await computeChecksum(derivatives.originalJpeg);

    const originalStored = await putObject({
      objectKey: originalObjectKey,
      body: derivatives.originalJpeg,
      contentType: 'image/jpeg',
      checksumSha256,
      metadata: {
        orgId,
        ownerType,
        ownerId,
        variant: 'original',
        source: 'media_photo_upload',
        uploadedByUserId: access.user.id,
      },
    });
    uploadedObjects.push({
      bucket: originalStored.bucket,
      objectKey: originalStored.objectKey,
    });

    const displayStored = await putObject({
      objectKey: displayObjectKey,
      body: derivatives.displayJpeg,
      contentType: 'image/jpeg',
      metadata: {
        orgId,
        ownerType,
        ownerId,
        variant: 'display',
        source: 'media_photo_upload',
        uploadedByUserId: access.user.id,
      },
    });
    uploadedObjects.push({
      bucket: displayStored.bucket,
      objectKey: displayStored.objectKey,
    });

    const thumbStored = await putObject({
      objectKey: thumbObjectKey,
      body: derivatives.thumbJpeg,
      contentType: 'image/jpeg',
      metadata: {
        orgId,
        ownerType,
        ownerId,
        variant: 'thumb',
        source: 'media_photo_upload',
        uploadedByUserId: access.user.id,
      },
    });
    uploadedObjects.push({
      bucket: thumbStored.bucket,
      objectKey: thumbStored.objectKey,
    });

    const uploadResult = await registry.execute(
      'media.photo.upload',
      {
        attachmentId,
        ownerType,
        ownerId,
        tag,
        caption: req.body?.caption,
        kind: ownerType === 'QUOTE' ? 'QUOTE_PHOTO' : 'JOB_PHOTO',
        fileName: req.file.originalname || 'photo.jpg',
        bucket: originalStored.bucket,
        objectKey: originalStored.objectKey,
        displayObjectKey,
        thumbObjectKey,
        mimeType: 'image/jpeg',
        sizeBytes: derivatives.originalJpeg.length,
        checksumSha256,
        width: derivatives.width,
        height: derivatives.height,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-media-upload',
        isAutonomous: false,
        reason: 'Upload governed quote/job photo',
      },
    );

    if (uploadResult.status !== 'EXECUTED') {
      await cleanupUploadedObjects();
      await registry.execute(
        'media.uploadSession.fail',
        {
          sessionKey,
          errorMessage:
            uploadResult.status === 'BLOCKED'
              ? uploadResult.reason
              : uploadResult.status === 'FAILED'
                ? uploadResult.error
                : 'Upload queued approval unexpectedly',
        },
        {
          orgId,
          actorType: ActorType.HUMAN,
          actorUserId: access.user.id,
          actorLabel: 'api-media-upload-fail',
          isAutonomous: false,
          reason: 'Record media upload session failure',
        },
      );

      const statusCode =
        uploadResult.status === 'BLOCKED'
          ? 403
          : 202;
      res.status(statusCode).json(uploadResult);
      return;
    }

    const completeResult = await registry.execute(
      'media.uploadSession.complete',
      {
        sessionKey,
        attachmentId,
        bucket: originalStored.bucket,
        objectKey: originalStored.objectKey,
        displayObjectKey,
        thumbObjectKey,
        fileName: req.file.originalname || 'photo.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: derivatives.originalJpeg.length,
        checksumSha256,
        width: derivatives.width ?? undefined,
        height: derivatives.height ?? undefined,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-media-upload-complete',
        isAutonomous: false,
        reason: 'Finalize idempotent media upload session',
      },
    );

    if (completeResult.status !== 'EXECUTED') {
      const detail =
        completeResult.status === 'BLOCKED'
          ? completeResult.reason
          : completeResult.status === 'FAILED'
            ? completeResult.error
            : 'queued approval';
      throw new Error(`media.uploadSession.complete returned ${completeResult.status}: ${detail}`);
    }

    res.status(201).json({
      ...uploadResult,
      sessionKey,
      storage: {
        bucket: originalStored.bucket,
        originalObjectKey: originalStored.objectKey,
        displayObjectKey: displayStored.objectKey,
        thumbObjectKey: thumbStored.objectKey,
      },
    });
  } catch (error) {
    if (orgId && actorUserId && sessionKey) {
      try {
        await registry.execute(
          'media.uploadSession.fail',
          {
            sessionKey,
            errorMessage: error instanceof Error ? error.message : 'Unknown media upload error',
          },
          {
            orgId,
            actorType: ActorType.HUMAN,
            actorUserId,
            actorLabel: 'api-media-upload-fail',
            isAutonomous: false,
            reason: 'Record media upload session failure',
          },
        );
      } catch {
        // Best effort only.
      }
    }

    await cleanupUploadedObjects();
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message, sessionKey: sessionKey || undefined });
  }
});

app.get('/api/quotes/:id/media', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['media:read', 'media:write', 'crm:read', 'crm:write', 'crm:*', '*']);

    const includeDeleted = String(req.query.includeDeleted ?? '').toLowerCase() === 'true';
    const result = await registry.execute(
      'media.list',
      {
        ownerType: 'QUOTE',
        ownerId: req.params.id,
        includeDeleted,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-media-list-quote',
        isAutonomous: false,
      },
    );

    ensureToolExecuted(result, 'media.list');
    const output = getExecutionOutputObject(result.output);
    res.json(output);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/api/jobs/:id/media', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['media:read', 'media:write', 'jobs:*', 'crm:read', '*']);

    const includeDeleted = String(req.query.includeDeleted ?? '').toLowerCase() === 'true';
    const result = await registry.execute(
      'media.list',
      {
        ownerType: 'JOB',
        ownerId: req.params.id,
        includeDeleted,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-media-list-job',
        isAutonomous: false,
      },
    );

    ensureToolExecuted(result, 'media.list');
    const output = getExecutionOutputObject(result.output);
    res.json(output);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/api/media', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['media:read', 'media:write', 'crm:read', 'jobs:*', '*']);

    const ownerType = typeof req.query.ownerType === 'string' ? req.query.ownerType.trim().toUpperCase() : '';
    const ownerId = typeof req.query.ownerId === 'string' ? req.query.ownerId.trim() : '';
    if ((ownerType !== 'QUOTE' && ownerType !== 'JOB') || !ownerId) {
      res.status(400).json({ error: 'ownerType (QUOTE|JOB) and ownerId are required' });
      return;
    }

    const includeDeleted = String(req.query.includeDeleted ?? '').toLowerCase() === 'true';

    const result = await registry.execute(
      'media.list',
      {
        ownerType,
        ownerId,
        includeDeleted,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-media-list',
        isAutonomous: false,
      },
    );

    ensureToolExecuted(result, 'media.list');
    const output = getExecutionOutputObject(result.output);
    res.json(output);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/api/media/:id/file', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireAnyPermission(req, orgId, ['media:read', 'media:write', 'crm:read', 'crm:write', 'jobs:*', '*']);

    const variantRaw = typeof req.query.variant === 'string' ? req.query.variant.trim().toLowerCase() : 'display';
    const variant = variantRaw === 'thumb' || variantRaw === 'display' || variantRaw === 'original'
      ? variantRaw
      : 'display';

    const attachment = await prisma.attachment.findFirst({
      where: {
        id: req.params.id,
        orgId,
        deletedAt: null,
      },
      select: {
        id: true,
        fileName: true,
        mimeType: true,
        bucket: true,
        objectKey: true,
        displayObjectKey: true,
        thumbObjectKey: true,
      },
    });

    if (!attachment) {
      res.status(404).json({ error: 'Media attachment not found' });
      return;
    }

    const objectKey =
      variant === 'thumb'
        ? attachment.thumbObjectKey ?? attachment.displayObjectKey ?? attachment.objectKey
        : variant === 'original'
          ? attachment.objectKey
          : attachment.displayObjectKey ?? attachment.objectKey;

    const object = await getStorageObject({
      bucket: attachment.bucket,
      objectKey,
    });

    res.setHeader('Content-Type', object.contentType ?? attachment.mimeType ?? 'application/octet-stream');
    if (typeof object.contentLength === 'number') {
      res.setHeader('Content-Length', String(object.contentLength));
    }
    res.setHeader('Cache-Control', 'private, max-age=120');
    res.setHeader('X-Media-Variant', variant);

    object.body.on('error', () => {
      if (!res.headersSent) {
        res.status(502).end('Unable to stream media file');
      } else {
        res.end();
      }
    });
    object.body.pipe(res);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/media/:id/public', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['media:share', '*']);

    const isPublic = Boolean(req.body?.isPublic);
    const result = await registry.execute(
      'media.setPublic',
      {
        attachmentId: req.params.id,
        isPublic,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-media-set-public',
        isAutonomous: false,
        reason: isPublic ? 'Share quote photo publicly' : 'Unshare quote photo',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 200
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.delete('/api/media/:id', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['media:write', '*']);

    const reason =
      typeof req.body?.reason === 'string' && req.body.reason.trim().length > 0
        ? req.body.reason.trim()
        : 'Media deleted by operator';

    const result = await registry.execute(
      'media.delete',
      {
        attachmentId: req.params.id,
        reason,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-media-delete',
        isAutonomous: false,
        reason,
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 200
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/admin/media/purge-expired', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const ownerAccess = await requireOwnerOrAdmin(req, orgId);

    const result = await registry.execute(
      'admin.media.purgeExpired',
      {
        limit: parseIntField(req.body?.limit) ?? undefined,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: ownerAccess.user.id,
        actorLabel: 'api-admin-media-purge',
        isAutonomous: false,
        reason: 'Manual media retention purge',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 200
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});


app.get('/api/quotes/:id', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['crm:read', 'crm:write', 'crm:*', '*']);

    const quote = await prisma.quote.findFirst({
      where: {
        orgId,
        id: req.params.id,
      },
      include: {
        lead: true,
        customer: true,
        assessment: true,
        options: {
          orderBy: { optionKey: 'asc' },
        },
      },
    });

    if (!quote) {
      res.status(404).json({ error: 'Quote not found' });
      return;
    }

    const roleNames = await resolveUserRoleNames(access.user.id);
    const canSeeCostDetails = userHasPermission(access.permissions, 'pricebook:cost:read');
    const canSeeMarginDetails = roleNames.some(
      (role) => role === 'owner' || role === 'admin',
    );

    res.json({
      quote: {
        ...quote,
        options: quote.options.map((option) =>
          sanitizeQuoteOptionForViewer(option as unknown as Record<string, any>, {
            canSeeCostDetails,
            canSeeMarginDetails,
          }),
        ),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.post('/api/quotes/:id/send', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['crm:quote:write', 'crm:write', 'crm:*', '*']);

    const result = await registry.execute(
      'crm.quote.send',
      {
        quoteId: req.params.id,
        regenerateToken: Boolean(req.body?.regenerateToken),
        expiresInDays: parseIntField(req.body?.expiresInDays) ?? undefined,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-quote-send',
        isAutonomous: false,
        reason: 'Send quote and issue customer token link',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 200
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/jobs/from-quote/:quoteId', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const access = await requireAnyPermission(req, orgId, ['jobs:write', 'jobs:*', '*']);

    const result = await registry.execute(
      'crm.job.createFromQuote',
      {
        quoteId: req.params.quoteId,
        title: req.body?.title,
        scheduledAt: req.body?.scheduledAt,
        addressLine1: req.body?.addressLine1,
        city: req.body?.city,
        state: req.body?.state,
        postalCode: req.body?.postalCode,
      },
      {
        orgId,
        actorType: ActorType.HUMAN,
        actorUserId: access.user.id,
        actorLabel: 'api-jobs-from-quote',
        isAutonomous: false,
        reason: 'Create linked job from quote',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 201
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/public/quotes/:token', async (req, res) => {
  try {
    const token = typeof req.params.token === 'string' ? req.params.token.trim() : '';
    if (!token) {
      res.status(400).json({ error: 'Missing quote token' });
      return;
    }

    const quote = await prisma.quote.findFirst({
      where: {
        publicToken: token,
      },
      include: {
        customer: true,
        lead: true,
        options: {
          orderBy: { optionKey: 'asc' },
        },
        lineItems: {
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
        job: {
          include: {
            appointments: {
              where: {
                status: {
                  not: 'CANCELED',
                },
              },
              orderBy: [{ date: 'asc' }, { timeBlockCode: 'asc' }],
            },
          },
        },
      },
    });

    if (!quote) {
      res.status(404).json({ error: 'Quote link not found' });
      return;
    }

    if (quote.publicTokenExpiresAt && quote.publicTokenExpiresAt.getTime() < Date.now()) {
      res.status(410).json({ error: 'Quote link expired' });
      return;
    }

    const settings = await prisma.orgSchedulingSettings.findUnique({
      where: { orgId: quote.orgId },
      select: {
        serviceBookingAllowedAt: true,
        installBookingAllowedAt: true,
      },
    });

    const allowBookingStatus =
      quote.kind === 'INSTALL'
        ? settings?.installBookingAllowedAt ?? 'ACCEPTED'
        : settings?.serviceBookingAllowedAt ?? 'SENT';

    const publicAttachments = await prisma.attachment.findMany({
      where: {
        orgId: quote.orgId,
        ownerType: 'QUOTE',
        ownerId: quote.id,
        isPublic: true,
        deletedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });

    const attachments = await Promise.all(
      publicAttachments.map(async (attachment) => {
        const baseAttachment = toPublicQuoteAttachmentView(attachment);
        const viewObjectKey = attachment.displayObjectKey ?? attachment.objectKey;
        const thumbObjectKey = attachment.thumbObjectKey ?? attachment.objectKey;

        try {
          const [displayUrl, thumbUrl] = await Promise.all([
            getStorageSignedUrl({
              bucket: attachment.bucket,
              objectKey: viewObjectKey,
              expiresSeconds: 900,
            }),
            getStorageSignedUrl({
              bucket: attachment.bucket,
              objectKey: thumbObjectKey,
              expiresSeconds: 900,
            }),
          ]);

          return {
            ...baseAttachment,
            displayUrl,
            thumbUrl,
            mediaAvailable: true,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown signing error';
          logStructured('warn', 'public.quote.media.sign_failed', {
            quoteId: quote.id,
            attachmentId: attachment.id,
            message,
          });
          return {
            ...baseAttachment,
            displayUrl: null,
            thumbUrl: null,
            mediaAvailable: false,
          };
        }
      }),
    );

    res.json({
      quote: {
        id: quote.id,
        kind: quote.kind,
        status: quote.status,
        sentAt: quote.sentAt,
        acceptedAt: quote.acceptedAt,
        acceptedByName: quote.acceptedByName,
        acceptanceNotes: quote.acceptanceNotes,
        totalCents: quote.totalCents,
        finalTotalCents: quote.finalTotalCents,
        lineItems: quote.lineItems,
        options: quote.options,
        customer: quote.customer,
        lead: quote.lead,
      },
      booking: {
        requiredStatus: allowBookingStatus,
      },
      attachments,
      job: quote.job,
    });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/public/quotes/:token/accept', async (req, res) => {
  try {
    const token = typeof req.params.token === 'string' ? req.params.token.trim() : '';
    const acceptedByName = typeof req.body?.acceptedByName === 'string' ? req.body.acceptedByName.trim() : '';

    if (!token || !acceptedByName) {
      res.status(400).json({ error: 'quote token and acceptedByName are required' });
      return;
    }

    const quote = await prisma.quote.findFirst({
      where: { publicToken: token },
      select: { orgId: true },
    });
    if (!quote) {
      res.status(404).json({ error: 'Quote link not found' });
      return;
    }

    const actorUserId = await resolvePrivilegedActorUserId(quote.orgId);
    if (!actorUserId) {
      res.status(503).json({ error: 'No actor available to process acceptance' });
      return;
    }

    const acceptedIpHash = hashSourceIp(getIngestSourceIp(req));
    const result = await registry.execute(
      'crm.quote.accept',
      {
        quoteToken: token,
        acceptedByName,
        notes: req.body?.notes,
        acceptedIpHash,
      },
      {
        orgId: quote.orgId,
        actorType: ActorType.HUMAN,
        actorUserId,
        actorLabel: 'public-quote-accept',
        isAutonomous: false,
        reason: 'Customer accepted quote via public link',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 200
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/public/quotes/:token/availability', async (req, res) => {
  try {
    const token = typeof req.params.token === 'string' ? req.params.token.trim() : '';
    if (!token) {
      res.status(400).json({ error: 'Missing quote token' });
      return;
    }

    const quote = await prisma.quote.findFirst({
      where: { publicToken: token },
      select: { orgId: true, kind: true },
    });

    if (!quote) {
      res.status(404).json({ error: 'Quote link not found' });
      return;
    }

    const actorUserId = await resolvePrivilegedActorUserId(quote.orgId);
    if (!actorUserId) {
      res.status(503).json({ error: 'No actor available to list availability' });
      return;
    }

    const startDate = parseDateOnlyInput(req.query.start);
    const endDate = parseDateOnlyInput(
      req.query.end,
      new Date(new Date(`${startDate}T00:00:00.000Z`).getTime() + 13 * 24 * 60 * 60 * 1000),
    );

    const requestedType = typeof req.query.type === 'string' ? req.query.type.trim().toUpperCase() : '';
    const type =
      requestedType === 'INSTALL' || requestedType === 'SERVICE_ESTIMATE'
        ? requestedType
        : quote.kind === 'INSTALL'
          ? 'INSTALL'
          : 'SERVICE_ESTIMATE';

    const result = await registry.execute(
      'scheduling.blocks.listAvailability',
      {
        type,
        startDate,
        endDate,
      },
      {
        orgId: quote.orgId,
        actorType: ActorType.HUMAN,
        actorUserId,
        actorLabel: 'public-quote-availability',
        isAutonomous: false,
      },
    );

    ensureToolExecuted(result, 'scheduling.blocks.listAvailability');
    const output = getExecutionOutputObject(result.output);
    res.json(output);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/public/quotes/:token/book', async (req, res) => {
  try {
    const token = typeof req.params.token === 'string' ? req.params.token.trim() : '';
    const date = typeof req.body?.date === 'string' ? req.body.date.trim() : '';
    const timeBlockCode = typeof req.body?.timeBlockCode === 'string' ? req.body.timeBlockCode.trim() : '';

    if (!token || !date || !timeBlockCode) {
      res.status(400).json({ error: 'quote token, date, and timeBlockCode are required' });
      return;
    }

    const quote = await prisma.quote.findFirst({
      where: { publicToken: token },
      select: { orgId: true },
    });

    if (!quote) {
      res.status(404).json({ error: 'Quote link not found' });
      return;
    }

    const actorUserId = await resolvePrivilegedActorUserId(quote.orgId);
    if (!actorUserId) {
      res.status(503).json({ error: 'No actor available to complete booking' });
      return;
    }

    const type = typeof req.body?.type === 'string' ? req.body.type.trim().toUpperCase() : undefined;

    const result = await registry.execute(
      'scheduling.appointment.bookFromToken',
      {
        quoteToken: token,
        date,
        timeBlockCode,
        type,
        notes: req.body?.notes,
      },
      {
        orgId: quote.orgId,
        actorType: ActorType.HUMAN,
        actorUserId,
        actorLabel: 'public-quote-booking',
        isAutonomous: false,
        reason: 'Customer selected scheduling time block from public quote link',
      },
    );

    const statusCode =
      result.status === 'EXECUTED'
        ? 201
        : result.status === 'BLOCKED'
          ? 403
          : 202;
    res.status(statusCode).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});


app.get('/api/estimates/:id', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const estimate = await prisma.invoice.findFirst({
      where: {
        orgId,
        id: req.params.id,
      },
      include: {
        customer: true,
      },
    });

    if (!estimate) {
      res.status(404).json({ error: 'Estimate not found' });
      return;
    }

    res.json({ estimate });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.post('/api/approvals/:id/approve', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const actor = await getActor(req, orgId);
    const approverUserId = actor.actorUserId;

    if (!approverUserId) {
      res.status(400).json({ error: 'No approver user available' });
      return;
    }

    const result = await prisma.$transaction(async (tx) => {
      const approval = await tx.approvalRequest.findFirst({
        where: {
          id: req.params.id,
          orgId,
        },
        include: {
          decisions: true,
        },
      });

      if (!approval) {
        throw new Error('Approval request not found');
      }

      if (approval.status !== ApprovalStatus.PENDING) {
        return approval;
      }

      await tx.approvalDecision.upsert({
        where: {
          approvalRequestId_decidedByUserId: {
            approvalRequestId: approval.id,
            decidedByUserId: approverUserId,
          },
        },
        update: {
          status: ApprovalStatus.APPROVED,
          comment: req.body?.comment,
        },
        create: {
          orgId,
          approvalRequestId: approval.id,
          decidedByUserId: approverUserId,
          status: ApprovalStatus.APPROVED,
          comment: req.body?.comment,
        },
      });

      const decisions = await tx.approvalDecision.findMany({
        where: { approvalRequestId: approval.id },
      });

      const status = resolveApprovalStatus(approval.requiredApprovals, decisions);
      const updatedApproval = await tx.approvalRequest.update({
        where: { id: approval.id },
        data: {
          status,
          resolvedAt: status === ApprovalStatus.PENDING ? null : new Date(),
        },
      });

      if (status === ApprovalStatus.APPROVED) {
        await enqueueOutbox(tx, {
          orgId,
          eventType: 'approval.approved',
          payload: {
            approvalRequestId: approval.id,
            finalizedByUserId: approverUserId,
          },
        });
      }

      if (status === ApprovalStatus.REJECTED) {
        await tx.toolExecution.updateMany({
          where: {
            approvalRequestId: approval.id,
            status: ExecutionStatus.QUEUED_APPROVAL,
          },
          data: {
            status: ExecutionStatus.CANCELLED,
            blockedReason: 'Approval request rejected',
            executedAt: new Date(),
          },
        });
      }

      return updatedApproval;
    });

    res.json({ approval: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.post('/api/approvals/:id/reject', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const actor = await getActor(req, orgId);
    const approverUserId = actor.actorUserId;

    if (!approverUserId) {
      res.status(400).json({ error: 'No approver user available' });
      return;
    }

    const result = await prisma.$transaction(async (tx) => {
      const approval = await tx.approvalRequest.findFirst({
        where: {
          id: req.params.id,
          orgId,
        },
      });

      if (!approval) {
        throw new Error('Approval request not found');
      }

      await tx.approvalDecision.upsert({
        where: {
          approvalRequestId_decidedByUserId: {
            approvalRequestId: approval.id,
            decidedByUserId: approverUserId,
          },
        },
        update: {
          status: ApprovalStatus.REJECTED,
          comment: req.body?.comment,
        },
        create: {
          orgId,
          approvalRequestId: approval.id,
          decidedByUserId: approverUserId,
          status: ApprovalStatus.REJECTED,
          comment: req.body?.comment,
        },
      });

      const updated = await tx.approvalRequest.update({
        where: { id: approval.id },
        data: {
          status: ApprovalStatus.REJECTED,
          resolvedAt: new Date(),
        },
      });

      await tx.toolExecution.updateMany({
        where: {
          approvalRequestId: approval.id,
          status: ExecutionStatus.QUEUED_APPROVAL,
        },
        data: {
          status: ExecutionStatus.CANCELLED,
          blockedReason: 'Approval request rejected',
          executedAt: new Date(),
        },
      });

      await enqueueOutbox(tx, {
        orgId,
        eventType: 'approval.rejected',
        payload: {
          approvalRequestId: approval.id,
          rejectedByUserId: approverUserId,
        },
      });

      return updated;
    });

    res.json({ approval: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.get('/api/tools/executions', async (req: Request, res: Response) => {
  try {
    const orgId = await getOrgId(req);
    const take = Number(req.query.limit ?? req.query.take ?? 50);
    const agentRunId =
      typeof req.query.agentRunId === 'string' ? req.query.agentRunId : undefined;
    const risk =
      typeof req.query.risk === 'string'
        ? req.query.risk.toUpperCase()
        : undefined;
    const riskFilter =
      risk && Object.values(RiskLevel).includes(risk as RiskLevel)
        ? (risk as RiskLevel)
        : undefined;

    const executions = await prisma.toolExecution.findMany({
      where: {
        orgId,
        ...(riskFilter ? { riskLevelSnapshot: riskFilter } : {}),
        ...(agentRunId ? { agentRunId } : {}),
      },
      include: {
        toolDefinition: true,
        approvalRequest: true,
      },
      orderBy: { createdAt: 'desc' },
      take: Number.isNaN(take) ? 50 : Math.min(take, 200),
    });

    res.json({ executions });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.get('/api/tools/executions/:id/explain', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const execution = await prisma.toolExecution.findFirst({
      where: {
        orgId,
        id: req.params.id,
      },
      include: {
        toolDefinition: true,
        approvalRequest: true,
      },
    });

    if (!execution) {
      res.status(404).json({ error: 'Tool execution not found' });
      return;
    }

    const storedDecision = getStoredDecision(execution.outputPayload);
    res.json({
      execution: {
        id: execution.id,
        status: execution.status,
        createdAt: execution.createdAt,
        updatedAt: execution.updatedAt,
        executedAt: execution.executedAt,
        blockedReason: execution.blockedReason,
        reason: execution.reason,
        actorType: execution.actorType,
        actorUserId: execution.actorUserId,
        isAutonomous: execution.isAutonomous,
        riskLevel: execution.riskLevelSnapshot,
        autonomyLevel: execution.autonomyLevelSnapshot,
        toolName: execution.toolDefinition.name,
        toolVersion: execution.toolDefinition.version,
        agentRunId: execution.agentRunId,
        approvalRequestId: execution.approvalRequestId,
      },
      decision: storedDecision,
      approvalRequest: execution.approvalRequest
        ? {
            id: execution.approvalRequest.id,
            status: execution.approvalRequest.status,
            requiredApprovals: execution.approvalRequest.requiredApprovals,
            reason: execution.approvalRequest.reason,
            createdAt: execution.approvalRequest.createdAt,
            resolvedAt: execution.approvalRequest.resolvedAt,
          }
        : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.get('/api/tools/definitions', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const take = Number(req.query.limit ?? req.query.take ?? 200);
    const names =
      typeof req.query.names === 'string'
        ? req.query.names
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean)
        : [];

    const rows = await prisma.toolDefinition.findMany({
      where: {
        orgId,
        active: true,
        ...(names.length > 0 ? { name: { in: names } } : {}),
      },
      orderBy: [{ name: 'asc' }, { updatedAt: 'desc' }, { createdAt: 'desc' }],
      take: Number.isNaN(take) ? 200 : Math.min(take, 500),
    });

    const latestByName = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (!latestByName.has(row.name)) {
        latestByName.set(row.name, row);
      }
    }

    res.json({ toolDefinitions: [...latestByName.values()] });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.get('/api/agent/runs', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const take = Number(req.query.limit ?? req.query.take ?? 50);

    const runs = await prisma.agentRun.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
      take: Number.isNaN(take) ? 50 : Math.min(take, 200),
    });

    res.json({ runs });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.get('/api/agent/runs/:id', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const run = await prisma.agentRun.findFirst({
      where: {
        orgId,
        id: req.params.id,
      },
    });

    if (!run) {
      res.status(404).json({ error: 'Agent run not found' });
      return;
    }

    const [lastExecutions, statusCounts, queuedApprovals] = await Promise.all([
      prisma.toolExecution.findMany({
        where: {
          orgId,
          agentRunId: run.id,
        },
        include: {
          toolDefinition: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      prisma.toolExecution.groupBy({
        by: ['status'],
        where: {
          orgId,
          agentRunId: run.id,
        },
        _count: { _all: true },
      }),
      prisma.toolExecution.count({
        where: {
          orgId,
          agentRunId: run.id,
          status: ExecutionStatus.QUEUED_APPROVAL,
        },
      }),
    ]);

    res.json({
      run: {
        ...run,
        preferredNextSkillId:
          getStateStringField(run.stateJson, 'preferredNextSkillId') ?? null,
      },
      executionsSummary: {
        byStatus: statusCounts.map((row) => ({
          status: row.status,
          count: row._count._all,
        })),
        lastExecutions,
        queuedApprovals,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.get('/api/agent/graph', (_req, res) => {
  const graphView = toAgentGraphView(MASTER_AGENT_GRAPH);
  res.json({
    startNodeId: graphView.startNodeId,
    nodes: graphView.nodes.map((node) => ({
      id: node.id,
      title: node.title,
      description: node.description,
      allowedTools: node.allowedTools,
      entrySummary: node.entrySummary,
      exitSummary: node.exitSummary,
    })),
    edges: graphView.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
    })),
  });
});

app.get('/api/agent/master/status', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const [activeRun, safetyState, policy] = await Promise.all([
      prisma.agentRun.findFirst({
        where: {
          orgId,
          status: {
            in: ['RUNNING', 'PAUSED_FOR_APPROVALS'],
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.orgSafetyState.findUnique({
        where: { orgId },
      }),
      prisma.policy.findFirst({
        where: { orgId, isActive: true },
        orderBy: [{ version: 'desc' }, { createdAt: 'desc' }],
      }),
    ]);

    const policySummary = summarizePolicy(policy);

    res.json({
      activeRun: activeRun
        ? {
            ...activeRun,
            preferredNextSkillId:
              getStateStringField(activeRun.stateJson, 'preferredNextSkillId') ??
              null,
          }
        : null,
      killSwitchMode: safetyState?.mode ?? 'NORMAL',
      autonomyEnabled: policySummary?.autonomyEnabled ?? true,
      policySummary,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.post('/api/agent/master/start', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const actor = await getActor(req, orgId);
    const goal =
      typeof req.body?.goal === 'string' ? req.body.goal.trim() : '';
    const requestedMode =
      req.body?.mode === 'SUPERVISED' ? 'SUPERVISED' : 'AUTO';

    if (!goal) {
      res.status(400).json({ error: 'goal is required' });
      return;
    }

    const [safetyState, policy] = await Promise.all([
      prisma.orgSafetyState.findUnique({
        where: { orgId },
      }),
      prisma.policy.findFirst({
        where: { orgId, isActive: true },
        orderBy: [{ version: 'desc' }, { createdAt: 'desc' }],
      }),
    ]);

    const killSwitchMode = safetyState?.mode ?? 'NORMAL';
    const policySummary = summarizePolicy(policy);

    if (killSwitchMode !== 'NORMAL' && requestedMode === 'AUTO') {
      res.status(409).json({
        status: 'BLOCKED',
        reason: `Kill switch ${killSwitchMode} blocks autonomous run start`,
        killSwitchMode,
        requestedMode,
      });
      return;
    }

    const effectiveMode =
      requestedMode === 'AUTO' && policySummary?.autonomyEnabled === false
        ? 'SUPERVISED'
        : requestedMode;

    const result = await registry.execute(
      'system.agent.run.start',
      {
        goal,
        mode: effectiveMode,
        context: req.body?.context,
      },
      {
        orgId,
        actorType: actor.actorType,
        actorUserId: actor.actorUserId,
        actorLabel: actor.actorLabel,
        isAutonomous: effectiveMode === 'AUTO',
        policyId: policy?.id,
        reason: `master.start:${effectiveMode}`,
      },
    );

    if (result.status === 'BLOCKED') {
      res.status(409).json({
        ...result,
        requestedMode,
        effectiveMode,
        killSwitchMode,
      });
      return;
    }

    if (result.status === 'FAILED') {
      res.status(400).json({
        ...result,
        requestedMode,
        effectiveMode,
      });
      return;
    }

    res.status(202).json({
      ...result,
      requestedMode,
      effectiveMode,
      killSwitchMode,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.post('/api/agent/master/pause', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const actor = await getActor(req, orgId);

    const result = await registry.execute(
      'system.agent.run.pause',
      {
        agentRunId: req.body?.agentRunId,
      },
      {
        orgId,
        actorType: actor.actorType,
        actorUserId: actor.actorUserId,
        actorLabel: actor.actorLabel,
        isAutonomous: false,
        reason:
          typeof req.body?.reason === 'string'
            ? req.body.reason
            : 'Master agent run paused by operator',
      },
    );

    if (result.status === 'FAILED') {
      const code = result.error?.includes('not found') ? 404 : 409;
      res.status(code).json(result);
      return;
    }

    if (result.status === 'BLOCKED') {
      res.status(409).json(result);
      return;
    }

    res.status(200).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.post('/api/agent/master/resume', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const actor = await getActor(req, orgId);

    const result = await registry.execute(
      'system.agent.run.resume',
      {
        agentRunId: req.body?.agentRunId,
      },
      {
        orgId,
        actorType: actor.actorType,
        actorUserId: actor.actorUserId,
        actorLabel: actor.actorLabel,
        isAutonomous: false,
        reason:
          typeof req.body?.reason === 'string'
            ? req.body.reason
            : 'Master agent run resumed by operator',
      },
    );

    if (result.status === 'FAILED') {
      const code = result.error?.includes('not found') ? 404 : 409;
      res.status(code).json(result);
      return;
    }

    if (result.status === 'BLOCKED') {
      res.status(409).json(result);
      return;
    }

    res.status(200).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.post('/api/agent/master/cancel', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const actor = await getActor(req, orgId);

    const result = await registry.execute(
      'system.agent.run.cancel',
      {
        agentRunId: req.body?.agentRunId,
      },
      {
        orgId,
        actorType: actor.actorType,
        actorUserId: actor.actorUserId,
        actorLabel: actor.actorLabel,
        isAutonomous: false,
        reason:
          typeof req.body?.reason === 'string' && req.body.reason.trim()
            ? req.body.reason
            : 'Master agent run cancelled by operator',
      },
    );

    if (result.status === 'FAILED') {
      const code = result.error?.includes('not found') ? 404 : 409;
      res.status(code).json(result);
      return;
    }

    if (result.status === 'BLOCKED') {
      res.status(409).json(result);
      return;
    }

    res.status(200).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.post('/api/agent/master/suggest-skill', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const actor = await getActor(req, orgId);
    const agentRunId =
      typeof req.body?.agentRunId === 'string' ? req.body.agentRunId : '';
    const skillId = typeof req.body?.skillId === 'string' ? req.body.skillId : '';

    if (!agentRunId || !skillId) {
      res.status(400).json({ error: 'agentRunId and skillId are required' });
      return;
    }

    const result = await registry.execute(
      'system.agent.run.suggest_skill',
      {
        agentRunId,
        skillId,
      },
      {
        orgId,
        actorType: actor.actorType,
        actorUserId: actor.actorUserId,
        actorLabel: actor.actorLabel,
        isAutonomous: false,
        reason: `Master agent preferred skill: ${skillId}`,
      },
    );

    if (result.status === 'FAILED') {
      res.status(409).json({
        status: 'BLOCKED',
        reason: result.error,
        executionId: result.executionId,
      });
      return;
    }

    if (result.status === 'BLOCKED') {
      res.status(409).json(result);
      return;
    }

    res.status(200).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

const playbookExecutePayloadSchema = z.object({
  packId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/)
    .optional()
    .default('mbs_agent_v1_1'),
  playbookStableId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  inputs: z.record(z.unknown()).default({}),
});

const AGENT_PLAYBOOK_MAX_STEPS_HARD_LIMIT = 500;
const AGENT_PLAYBOOK_MAX_STEP_EXECUTION_MS_HARD_LIMIT = 120_000;
const AGENT_PLAYBOOK_MAX_STEP_PAYLOAD_BYTES_HARD_LIMIT = 2 * 1024 * 1024;
const AGENT_PLAYBOOK_MAX_STEP_PAYLOAD_DEPTH_HARD_LIMIT = 200;
const AGENT_PLAYBOOK_MAX_STEP_PAYLOAD_KEYS_HARD_LIMIT = 50_000;
const AGENT_PLAYBOOK_REQUEST_TIMEOUT_MS_HARD_LIMIT = 300_000;
const AGENT_PLAYBOOK_MAX_INFLIGHT_GLOBAL_HARD_LIMIT = 500;
const AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ORG_HARD_LIMIT = 200;
const AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ACTOR_HARD_LIMIT = 100;

app.post('/api/agent/playbooks/execute', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const actor = await getActor(req, orgId);
    await requireOwnerAdminOrManager(req, orgId);
    const sourceIp = getIngestSourceIp(req);
    if (
      !applyAgentPlaybookRateLimit({
        orgId,
        actorUserId: actor.actorUserId,
        ip: sourceIp,
      })
    ) {
      recordRateLimitEvent('agent_playbook');
      const retryAfterSeconds = getRateLimitRetryAfterSeconds(
        'AGENT_PLAYBOOK_RATE_LIMIT_WINDOW_MS',
        60000,
      );
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({
        status: 'FAILED',
        error: {
          code: 'PLAYBOOK_RATE_LIMITED',
          message: 'Playbook execution rate limit exceeded. Retry shortly.',
          recoverable: true,
          retryAfterSeconds,
        },
      });
      return;
    }
    const requestCorrelationId =
      typeof req.header('x-correlation-id') === 'string'
        ? req.header('x-correlation-id')?.trim()
        : '';
    if (!requestCorrelationId) {
      res.status(400).json({
        status: 'FAILED',
        error: {
          code: 'PLAYBOOK_CORRELATION_REQUIRED',
          message:
            'x-correlation-id header is required for deterministic playbook execution',
          details: {
            header: 'x-correlation-id',
          },
        },
      });
      return;
    }
    if (!CORRELATION_ID_PATTERN.test(requestCorrelationId)) {
      res.status(400).json({
        status: 'FAILED',
        error: {
          code: 'PLAYBOOK_CORRELATION_INVALID',
          message:
            'x-correlation-id must match ^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$',
          details: {
            header: 'x-correlation-id',
            maxLength: 128,
          },
        },
      });
      return;
    }

    const parsed = playbookExecutePayloadSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid payload',
        details: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
      return;
    }

    const { packId, playbookStableId, inputs } = parsed.data;
    const maxInputBytes = parsePositiveIntValue(
      process.env.AGENT_PLAYBOOK_MAX_INPUT_BYTES,
      64 * 1024,
    );
    const maxInputDepth = Math.min(
      parsePositiveIntValue(process.env.AGENT_PLAYBOOK_MAX_INPUT_DEPTH, 20),
      200,
    );
    const maxInputKeys = Math.min(
      parsePositiveIntValue(process.env.AGENT_PLAYBOOK_MAX_INPUT_KEYS, 5000),
      50000,
    );
    try {
      assertPlaybookInputSize(inputs, maxInputBytes);
      assertPlaybookInputShape({
        inputs,
        maxDepth: maxInputDepth,
        maxKeys: maxInputKeys,
      });
    } catch (error) {
      if (error instanceof PlaybookInputTooLargeError) {
        res.status(413).json({
          status: 'FAILED',
          error: {
            code: error.code,
            message: error.message,
            details: {
              maxBytes: error.maxBytes,
              inputBytes: error.inputBytes,
            },
          },
        });
        return;
      }
      if (error instanceof PlaybookInputShapeError) {
        res.status(400).json({
          status: 'FAILED',
          error: {
            code: error.code,
            message: error.message,
            details: {
              reason: error.reason,
              maxDepth: error.maxDepth,
              maxKeys: error.maxKeys,
              actualDepth: error.actualDepth,
              actualKeys: error.actualKeys,
            },
          },
        });
        return;
      }
      throw error;
    }

    const failClosedConfig = loadPlaybookFailClosedConfig();
    if (failClosedConfig.enabled) {
      let liveHealth:
        | {
            status: 'OK' | 'WARN' | 'CRITICAL';
            issues: Array<{
              key: string;
              message: string;
              level: 'WARN' | 'CRITICAL';
            }>;
          }
        | undefined;
      try {
        liveHealth = await runWithTimeout(
          async () => computeLiveSystemHealth(orgId),
          failClosedConfig.timeoutMs,
        );
      } catch (error) {
        recordPlaybookGovernanceErrorEvent();
        const reasonCode =
          error instanceof AsyncTimeoutError
            ? 'PLAYBOOK_GOVERNANCE_TIMEOUT'
            : 'PLAYBOOK_GOVERNANCE_UNAVAILABLE';
        const reasonMessage =
          error instanceof AsyncTimeoutError
            ? `Governance health gate timed out after ${error.timeoutMs}ms`
            : 'Governance health gate failed and fail-closed is enabled';
        res.status(503).json({
          status: 'FAILED',
          error: {
            code: reasonCode,
            message: reasonMessage,
            recoverable: true,
            details: {
              timeoutMs:
                error instanceof AsyncTimeoutError
                  ? error.timeoutMs
                  : failClosedConfig.timeoutMs,
            },
          },
        });
        return;
      }

      const gateDecision = evaluatePlaybookFailClosedGate({
        config: failClosedConfig,
        healthStatus: liveHealth.status,
        issues: liveHealth.issues,
      });

      if (!gateDecision.allowed) {
        recordPlaybookFailClosedBlockedEvent();
        res.status(503).json({
          status: 'FAILED',
          error: {
            code: gateDecision.code,
            message: gateDecision.message,
            recoverable: true,
            details: gateDecision.details,
          },
        });
        return;
      }
    }

    let pack: LoadedPlaybookPack;
    try {
      pack = await getPlaybookPack(packId);
    } catch (packError) {
      recordPlaybookPackLoadFailureEvent();
      if (packError instanceof PlaybookPackValidationError) {
        res.status(400).json({
          status: 'FAILED',
          error: {
            code: 'PLAYBOOK_PACK_VALIDATION_FAILED',
            message: packError.message,
            details: {
              issues: packError.issues,
            },
          },
        });
        return;
      }

      const message =
        packError instanceof Error ? packError.message : 'Unknown pack load error';
      const code = message.includes('missing from external packs manifest')
        ? 'PLAYBOOK_PACK_NOT_FOUND'
        : message.includes('integrity mismatch')
          ? 'PLAYBOOK_PACK_INTEGRITY_MISMATCH'
          : message.includes('Symlinked pack files are not allowed')
            ? 'PLAYBOOK_PACK_SYMLINK_FORBIDDEN'
            : 'PLAYBOOK_PACK_LOAD_FAILED';

      res.status(400).json({
        status: 'FAILED',
        error: {
          code,
          message,
        },
      });
      return;
    }
    const maxSteps = Math.min(
      parsePositiveIntValue(process.env.AGENT_PLAYBOOK_MAX_STEPS, 200),
      AGENT_PLAYBOOK_MAX_STEPS_HARD_LIMIT,
    );
    const maxStepExecutionMs = Math.min(
      parsePositiveIntValue(process.env.AGENT_PLAYBOOK_MAX_STEP_EXECUTION_MS, 15_000),
      AGENT_PLAYBOOK_MAX_STEP_EXECUTION_MS_HARD_LIMIT,
    );
    const maxStepPayloadBytes = Math.min(
      parsePositiveIntValue(process.env.AGENT_PLAYBOOK_MAX_STEP_PAYLOAD_BYTES, 64 * 1024),
      AGENT_PLAYBOOK_MAX_STEP_PAYLOAD_BYTES_HARD_LIMIT,
    );
    const maxStepPayloadDepth = Math.min(
      parsePositiveIntValue(process.env.AGENT_PLAYBOOK_MAX_STEP_PAYLOAD_DEPTH, 25),
      AGENT_PLAYBOOK_MAX_STEP_PAYLOAD_DEPTH_HARD_LIMIT,
    );
    const maxStepPayloadKeys = Math.min(
      parsePositiveIntValue(process.env.AGENT_PLAYBOOK_MAX_STEP_PAYLOAD_KEYS, 6000),
      AGENT_PLAYBOOK_MAX_STEP_PAYLOAD_KEYS_HARD_LIMIT,
    );
    const requestTimeoutMs = Math.min(
      parsePositiveIntValue(process.env.AGENT_PLAYBOOK_REQUEST_TIMEOUT_MS, 30_000),
      AGENT_PLAYBOOK_REQUEST_TIMEOUT_MS_HARD_LIMIT,
    );
    const maxInflightGlobal = Math.min(
      parsePositiveIntValue(process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_GLOBAL, 24),
      AGENT_PLAYBOOK_MAX_INFLIGHT_GLOBAL_HARD_LIMIT,
    );
    const maxInflightPerOrg = Math.min(
      parsePositiveIntValue(process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ORG, 8),
      AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ORG_HARD_LIMIT,
    );
    const maxInflightPerActor = Math.min(
      parsePositiveIntValue(process.env.AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ACTOR, 2),
      AGENT_PLAYBOOK_MAX_INFLIGHT_PER_ACTOR_HARD_LIMIT,
    );
    const playbookDedupKey = [
      orgId,
      actor.actorUserId ?? '',
      packId,
      playbookStableId,
      requestCorrelationId,
    ].join(':');
    const executionSlot = tryAcquirePlaybookExecutionSlot({
      orgId,
      actorUserId: actor.actorUserId,
      requestKey: playbookDedupKey,
      maxGlobal: maxInflightGlobal,
      maxPerOrg: maxInflightPerOrg,
      maxPerActor: maxInflightPerActor,
    });
    if (!executionSlot) {
      if (isPlaybookRequestKeyInflight(playbookDedupKey)) {
        recordPlaybookDuplicateInflightEvent();
        res.setHeader('Retry-After', '1');
        res.status(409).json({
          status: 'FAILED',
          error: {
            code: 'PLAYBOOK_DUPLICATE_INFLIGHT',
            message:
              'A matching playbook execution is already in progress for this correlationId.',
            recoverable: true,
            retryAfterSeconds: 1,
            details: {
              playbookStableId,
              correlationId: requestCorrelationId,
            },
          },
        });
        return;
      }
      recordPlaybookInflightLimitEvent();
      const inflight = getPlaybookExecutionInflightSnapshot(orgId, actor.actorUserId);
      res.setHeader('Retry-After', '1');
      res.status(503).json({
        status: 'FAILED',
        error: {
          code: 'PLAYBOOK_INFLIGHT_LIMIT_REACHED',
          message: 'Playbook executor is saturated. Retry shortly.',
          recoverable: true,
          retryAfterSeconds: 1,
          details: {
            maxInflightGlobal,
            maxInflightPerOrg,
            maxInflightPerActor,
            inflightGlobal: inflight.global,
            inflightForOrg: inflight.org,
            inflightForActor: inflight.actor,
          },
        },
      });
      return;
    }

    let result: PlaybookExecutionResult;
    try {
      result = await runWithTimeout(
        async () =>
          executePlaybook({
            pack,
            playbookStableId,
            inputs,
            registry,
            context: {
              orgId,
              actorType: actor.actorType,
              actorUserId: actor.actorUserId,
              actorLabel: actor.actorLabel,
              isAutonomous: false,
              correlationId: requestCorrelationId,
            },
            correlationId: requestCorrelationId,
            maxSteps,
            maxStepExecutionMs,
            maxStepPayloadBytes,
            maxStepPayloadDepth,
            maxStepPayloadKeys,
          }),
        requestTimeoutMs,
      );
    } finally {
      executionSlot.release();
    }

    if (result.status === 'FAILED') {
      if (result.error?.code === 'PLAYBOOK_STEP_TIMEOUT') {
        recordPlaybookRequestTimeoutEvent();
        res.status(504).json({
          ...result,
          error: {
            ...result.error,
            recoverable: true,
          },
        });
        return;
      }
      if (result.error?.code === 'PLAYBOOK_STEP_PAYLOAD_TOO_LARGE') {
        recordPlaybookPayloadRejectedEvent();
        res.status(413).json(result);
        return;
      }
      if (result.error?.code === 'PLAYBOOK_STEP_PAYLOAD_SHAPE_INVALID') {
        recordPlaybookPayloadRejectedEvent();
        res.status(400).json(result);
        return;
      }
      res.status(400).json(result);
      return;
    }

    if (result.status === 'BLOCKED') {
      res.status(409).json(result);
      return;
    }

    if (result.status === 'NEEDS_APPROVAL') {
      res.status(202).json(result);
      return;
    }

    res.status(200).json(result);
  } catch (error) {
    if (error instanceof AsyncTimeoutError) {
      recordPlaybookRequestTimeoutEvent();
      res.status(504).json({
        status: 'FAILED',
        error: {
          code: 'PLAYBOOK_REQUEST_TIMEOUT',
          message: `Playbook execution timed out after ${error.timeoutMs}ms`,
          recoverable: true,
          timeoutMs: error.timeoutMs,
        },
      });
      return;
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({
      status: 'FAILED',
      error: {
        code: 'PLAYBOOK_EXECUTION_ERROR',
        message,
      },
    });
  }
});

app.get('/api/system/killswitch', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const actor = await getActor(req, orgId);

    const result = await registry.execute(
      'system.killswitch.status',
      {},
      {
        orgId,
        actorType: actor.actorType,
        actorUserId: actor.actorUserId,
        actorLabel: actor.actorLabel,
        isAutonomous: false,
      },
    );

    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.get('/api/system/exposure/today', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const exposure = await getExposureToday(orgId, new Date());
    res.json(exposure);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.get('/api/system/policy/active', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const policy = await prisma.policy.findFirst({
      where: { orgId, isActive: true },
      orderBy: [{ version: 'desc' }, { createdAt: 'desc' }],
    });

    if (!policy) {
      res.json({ policy: null });
      return;
    }

    res.json({
      policy: {
        id: policy.id,
        name: policy.name,
        version: policy.version,
        createdAt: policy.createdAt,
        updatedAt: policy.updatedAt,
        policyJson: redactSecrets(policy.policyJson),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.get('/api/system/health', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireAnyPermission(req, orgId, ['system:ops:read', 'system:*', '*']);
    const healthTimeoutMs = getSystemHealthRequestTimeoutMs();
    const [live, latestSnapshot] = await runWithTimeout(
      async () =>
        Promise.all([
          computeLiveSystemHealth(orgId),
          loadLatestHealthSnapshot(),
        ]),
      healthTimeoutMs,
    );

    const snapshotIssuesRaw: unknown[] = Array.isArray(latestSnapshot?.snapshot?.issues)
      ? (latestSnapshot?.snapshot?.issues as unknown[])
      : [];

    const snapshotIssues: HealthIssue[] = snapshotIssuesRaw
      .map((issue) => {
        if (!issue || typeof issue !== 'object' || Array.isArray(issue)) {
          return null;
        }
        const row = issue as Record<string, unknown>;
        const key =
          typeof row.key === 'string'
            ? row.key
            : typeof row.code === 'string'
              ? row.code
              : 'ops_snapshot_issue';
        const message =
          typeof row.message === 'string'
            ? row.message
            : 'Issue reported by latest ops snapshot';
        return {
          level: coerceIssueLevel((row.level ?? row.severity) as unknown),
          key,
          message,
        } satisfies HealthIssue;
      })
      .filter((issue): issue is HealthIssue => issue !== null);

    const mergedIssues = [...live.issues, ...snapshotIssues];
    const snapshotTimestamp = parseIsoDateOrNull(latestSnapshot?.snapshot?.timestamp);
    const snapshotMaxAgeMinutes = parsePositiveIntEnv('HEALTH_MAX_SNAPSHOT_AGE_MINUTES', 120);
    if (!snapshotTimestamp) {
      mergedIssues.push({
        level: 'WARN',
        key: 'ops_snapshot_missing',
        message: `No latest ops snapshot found at ${getHealthSnapshotLogPath()}; verify hourly health job.`,
      });
    } else {
      const ageMinutes = Math.floor((Date.now() - snapshotTimestamp.getTime()) / (60 * 1000));
      if (ageMinutes > snapshotMaxAgeMinutes) {
        mergedIssues.push({
          level: 'WARN',
          key: 'ops_snapshot_stale',
          message: `Latest ops snapshot is stale: ${ageMinutes}m old (limit ${snapshotMaxAgeMinutes}m).`,
        });
      }
    }
    const status = deriveOverallHealthStatus(mergedIssues);
    const recommendedActions = buildHealthRecommendations(mergedIssues);

    res.json({
      generatedAt: new Date().toISOString(),
      status,
      metrics: live.metrics,
      thresholds: live.thresholds,
      snapshotThresholds: {
        maxSnapshotAgeMinutes: snapshotMaxAgeMinutes,
      },
      issues: mergedIssues,
      recommendedActions,
      live,
      latestSnapshot: latestSnapshot
        ? {
            path: latestSnapshot.path,
            timestamp:
              typeof latestSnapshot.snapshot.timestamp === 'string'
                ? latestSnapshot.snapshot.timestamp
                : null,
            overall:
              typeof latestSnapshot.snapshot.overall === 'string'
                ? latestSnapshot.snapshot.overall
                : null,
          }
        : null,
    });
  } catch (error) {
    if (error instanceof AsyncTimeoutError) {
      res.status(504).json({
        error: {
          code: 'SYSTEM_HEALTH_TIMEOUT',
          message: 'System health request timed out.',
          recoverable: true,
          timeoutMs: error.timeoutMs,
        },
      });
      return;
    }
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/api/system/health/incidents', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireAnyPermission(req, orgId, ['system:ops:read', 'system:*', '*']);
    const healthTimeoutMs = getSystemHealthRequestTimeoutMs();

    const parsedLimit =
      typeof req.query.limit === 'string'
        ? Number.parseInt(req.query.limit, 10)
        : Number.NaN;
    const limit =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, 50)
        : 10;
    const collapseQuery = String(req.query.collapse ?? 'true').toLowerCase();
    const collapse = collapseQuery !== 'false';
    const parsedCollapseWindow =
      typeof req.query.collapseWindowMinutes === 'string'
        ? Number.parseInt(req.query.collapseWindowMinutes, 10)
        : Number.NaN;
    const collapseWindowMinutes =
      Number.isFinite(parsedCollapseWindow) && parsedCollapseWindow > 0
        ? Math.min(parsedCollapseWindow, 24 * 60)
        : parsePositiveIntEnv('HEALTH_INCIDENT_COLLAPSE_WINDOW_MINUTES', 180);

    const incidentResult = await runWithTimeout(
      async () =>
        loadRecentHealthIncidents(limit, {
          collapse,
          collapseWindowMinutes,
        }),
      healthTimeoutMs,
    );
    res.json({
      incidents: incidentResult.incidents,
      count: incidentResult.incidents.length,
      rawCount: incidentResult.rawCount,
      collapse,
      collapseWindowMinutes,
      incidentDir: getHealthIncidentDirPath(),
    });
  } catch (error) {
    if (error instanceof AsyncTimeoutError) {
      res.status(504).json({
        error: {
          code: 'SYSTEM_HEALTH_INCIDENTS_TIMEOUT',
          message: 'System health incidents request timed out.',
          recoverable: true,
          timeoutMs: error.timeoutMs,
        },
      });
      return;
    }
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/api/system/health/history', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireAnyPermission(req, orgId, ['system:ops:read', 'system:*', '*']);
    const healthTimeoutMs = getSystemHealthRequestTimeoutMs();

    const parsedLimit =
      typeof req.query.limit === 'string'
        ? Number.parseInt(req.query.limit, 10)
        : Number.NaN;
    const limit =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, 240)
        : 24;

    const history = await runWithTimeout(
      async () => loadRecentHealthSnapshots(limit),
      healthTimeoutMs,
    );
    res.json({
      path: history.path,
      count: history.snapshots.length,
      snapshots: history.snapshots,
    });
  } catch (error) {
    if (error instanceof AsyncTimeoutError) {
      res.status(504).json({
        error: {
          code: 'SYSTEM_HEALTH_HISTORY_TIMEOUT',
          message: 'System health history request timed out.',
          recoverable: true,
          timeoutMs: error.timeoutMs,
        },
      });
      return;
    }
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/api/system/health/smoke', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireAnyPermission(req, orgId, ['system:ops:read', 'system:*', '*']);
    const healthTimeoutMs = getSystemHealthRequestTimeoutMs();
    const [live, latestSnapshot, incidentResult, history] = await runWithTimeout(
      async () =>
        Promise.all([
          computeLiveSystemHealth(orgId),
          loadLatestHealthSnapshot(),
          loadRecentHealthIncidents(1),
          loadRecentHealthSnapshots(6),
        ]),
      healthTimeoutMs,
    );

    const checks = {
      liveHealthComputed: true,
      historyReadable: history.snapshots.length > 0,
      incidentsReadable: incidentResult.incidents.length > 0,
      latestSnapshotPresent: Boolean(latestSnapshot),
      backupVisibilityConfigured: !live.issues.some(
        (issue) => issue.key === 'backup_visibility_unconfigured',
      ),
      restoreDrillFresh: !live.issues.some((issue) =>
        [
          'restore_drill_missing',
          'restore_drill_invalid',
          'restore_drill_marker_invalid',
          'restore_drill_failed',
          'restore_drill_stale',
          'restore_drill_lock_stale',
        ].includes(issue.key),
      ),
      remediationLockFresh: !live.issues.some(
        (issue) => issue.key === 'remediate_lock_stale',
      ),
      authSecretSecure: !live.issues.some(
        (issue) => issue.key === 'auth_jwt_secret_insecure',
      ),
      ingestTokensConfigured: !live.issues.some((issue) =>
        ['ingest_tokens_missing', 'ingest_tokens_insecure'].includes(issue.key),
      ),
      callWebhookSecretConfigured: !live.issues.some((issue) =>
        ['call_webhook_secret_missing', 'call_webhook_secret_insecure'].includes(issue.key),
      ),
      ingestIpHashSaltConfigured: !live.issues.some((issue) =>
        ['ingest_ip_hash_salt_missing', 'ingest_ip_hash_salt_insecure'].includes(issue.key),
      ),
      loadSmokeFresh: !live.issues.some((issue) =>
        [
          'load_smoke_missing',
          'load_smoke_marker_invalid',
          'load_smoke_stale',
          'load_smoke_failed',
          'load_smoke_regressed',
          'load_smoke_latency_high',
          'load_smoke_trend_failed',
        ].includes(issue.key),
      ),
    };

    res.json({
      generatedAt: new Date().toISOString(),
      ok: true,
      liveStatus: live.status,
      checks,
      summary: {
        issueCount: live.issues.length,
        latestIssue:
          live.issues.length > 0
            ? {
                key: live.issues[0].key,
                level: live.issues[0].level,
                message: live.issues[0].message,
              }
            : null,
      },
    });
  } catch (error) {
    if (error instanceof AsyncTimeoutError) {
      res.status(504).json({
        ok: false,
        error: {
          code: 'SYSTEM_HEALTH_SMOKE_TIMEOUT',
          message: 'System health smoke request timed out.',
          recoverable: true,
          timeoutMs: error.timeoutMs,
        },
      });
      return;
    }
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message, ok: false });
  }
});

app.get('/api/system/readiness', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireAnyPermission(req, orgId, ['system:ops:read', 'system:*', '*']);
    const healthTimeoutMs = getSystemHealthRequestTimeoutMs();
    const modeQuery =
      typeof req.query.mode === 'string'
        ? req.query.mode.trim().toLowerCase()
        : 'strict';
    const mode = modeQuery === 'critical' ? 'critical' : 'strict';

    const live = await runWithTimeout(
      async () => computeLiveSystemHealth(orgId),
      healthTimeoutMs,
    );

    const hasCritical = live.issues.some((issue) => issue.level === 'CRITICAL');
    const hasWarn = live.issues.some((issue) => issue.level === 'WARN');
    const ready = mode === 'critical' ? !hasCritical : !hasCritical && !hasWarn;
    const issueKeys = live.issues.map((issue) => issue.key);

    res.status(ready ? 200 : 503).json({
      ready,
      mode,
      status: live.status,
      issueCount: live.issues.length,
      issueKeys,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof AsyncTimeoutError) {
      res.status(504).json({
        ready: false,
        error: {
          code: 'SYSTEM_READINESS_TIMEOUT',
          message: 'System readiness request timed out.',
          recoverable: true,
          timeoutMs: error.timeoutMs,
        },
      });
      return;
    }
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ ready: false, error: message });
  }
});

app.post('/api/system/killswitch', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const actor = await getActor(req, orgId);

    const result = await registry.execute(
      'system.killswitch.set',
      {
        mode: req.body?.mode,
        reason: req.body?.reason,
      },
      {
        orgId,
        actorType: actor.actorType,
        actorUserId: actor.actorUserId,
        actorLabel: actor.actorLabel,
        isAutonomous: false,
        reason: req.body?.reason,
      },
    );

    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.post('/api/webhooks/calls', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const configuredSecret = (process.env.CALL_WEBHOOK_SECRET ?? '').trim();
    const providedSecret = (req.header('x-webhook-secret') ?? '').trim();
    const sourceIp = getIngestSourceIp(req);

    if (!configuredSecret) {
      res.status(503).json({ error: 'Webhook secret is not configured' });
      return;
    }
    if (!applyCallWebhookRateLimit(sourceIp)) {
      recordRateLimitEvent('call_webhook');
      const retryAfterSeconds = getRateLimitRetryAfterSeconds(
        'CALL_WEBHOOK_RATE_LIMIT_WINDOW_MS',
        60000,
      );
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({
        error: {
          code: 'CALL_WEBHOOK_RATE_LIMITED',
          message: 'Call webhook rate limit exceeded. Retry shortly.',
          recoverable: true,
          retryAfterSeconds,
        },
      });
      return;
    }

    if (!providedSecret || !secretsMatchConstantTime(configuredSecret, providedSecret)) {
      res.status(401).json({ error: 'Unauthorized webhook secret' });
      return;
    }

    const systemActorUserId = await resolveSystemActorUserId(orgId);
    const result = await registry.execute(
      'marketing.call.ingest',
      {
        provider: req.body?.provider ?? 'generic',
        providerCallId: req.body?.providerCallId,
        direction: req.body?.direction,
        fromNumber: req.body?.fromNumber,
        toNumber: req.body?.toNumber,
        startedAt: req.body?.startedAt,
        endedAt: req.body?.endedAt,
        durationSeconds: req.body?.durationSeconds,
        answered: req.body?.answered,
        recordingUrl: req.body?.recordingUrl,
        transcriptionUrl: req.body?.transcriptionUrl,
        disposition: req.body?.disposition,
        metadata: req.body?.metadata,
        raw: req.body?.raw ?? req.body,
      },
      {
        orgId,
        actorType: ActorType.SYSTEM,
        actorUserId: systemActorUserId,
        actorLabel: 'webhook:calls',
        isAutonomous: false,
      },
    );

    res.status(result.status === 'EXECUTED' ? 200 : 202).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.post(
  '/api/accounting/receipts/upload',
  receiptUpload.single('file'),
  async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      await requireOwnerAdminOrManager(req, orgId);
      const actor = await getActor(req, orgId);

      if (!req.file) {
        res.status(400).json({ error: 'file is required (multipart/form-data)' });
        return;
      }

      const file = req.file;
      const checksumSha256 = await computeChecksum(file.buffer);
      const now = new Date();
      const year = now.getUTCFullYear();
      const month = String(now.getUTCMonth() + 1).padStart(2, '0');
      const objectKey = `receipts/${orgId}/${year}/${month}/${randomUUID()}-${sanitizeObjectKeySegment(
        basename(file.originalname || 'receipt.bin'),
      )}`;

      const stored = await putObject({
        objectKey,
        body: file.buffer,
        contentType: file.mimetype || 'application/octet-stream',
        checksumSha256,
        metadata: {
          orgId,
          uploadType: 'receipt',
        },
      });

      const result = await registry.execute(
        'accounting.receipt.upload',
        {
          bucket: stored.bucket,
          objectKey: stored.objectKey,
          fileName: file.originalname || 'receipt.bin',
          mimeType: file.mimetype || 'application/octet-stream',
          sizeBytes: file.size,
          checksumSha256,
          jobId: req.body?.jobId,
          vendorName: req.body?.vendorName,
          totalCents: parseIntField(req.body?.totalCents),
          taxCents: parseIntField(req.body?.taxCents),
          incurredAt: req.body?.incurredAt,
          purchaseDate: req.body?.purchaseDate,
          currency: req.body?.currency,
          notes: req.body?.notes,
          memo: req.body?.memo,
          categoryId: req.body?.categoryId,
          metadata: {
            source: 'receipt_upload',
            originalName: file.originalname,
          },
        },
        {
          orgId,
          actorType: actor.actorType,
          actorUserId: actor.actorUserId,
          actorLabel: actor.actorLabel,
          isAutonomous: false,
        },
      );

      res.status(result.status === 'EXECUTED' ? 201 : 202).json({
        upload: stored,
        execution: result,
      });
    } catch (error) {
      const status = (error as Error & { status?: number }).status ?? 400;
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(status).json({ error: message });
    }
  },
);

app.get('/api/accounting/receipts', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireOwnerAdminOrManager(req, orgId);

    const takeRaw = Number(req.query.limit ?? 100);
    const take = Number.isFinite(takeRaw) ? Math.min(Math.max(takeRaw, 1), 200) : 100;
    const receipts = await prisma.receipt.findMany({
      where: { orgId },
      include: {
        attachment: {
          select: {
            id: true,
            fileName: true,
            mimeType: true,
            bucket: true,
            objectKey: true,
            createdAt: true,
          },
        },
        expenses: {
          select: {
            id: true,
            status: true,
            amountCents: true,
            currency: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { createdAt: 'desc' },
      take,
    });

    res.json({ receipts });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/api/attachments/:id/view', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireAnyPermission(req, orgId, [
      'crm:read',
      'crm:write',
      'crm:attachment:write',
      'accounting:read',
      'accounting:write',
    ]);

    const attachmentRef = await prisma.attachmentRef.findFirst({
      where: {
        id: req.params.id,
        orgId,
      },
    });

    if (attachmentRef) {
      if (attachmentRef.provider === 'S3') {
        if (!attachmentRef.bucket || !attachmentRef.objectKey) {
          res.status(422).json({
            error: 'AttachmentRef missing bucket/objectKey for S3 provider',
          });
          return;
        }
        const expiresSeconds = Math.min(
          Math.max(Number(req.query.expiresSeconds ?? 900), 60),
          3600,
        );
        const signedUrl = await getStorageSignedUrl({
          bucket: attachmentRef.bucket,
          objectKey: attachmentRef.objectKey,
          expiresSeconds,
        });

        res.json({
          attachmentId: attachmentRef.id,
          attachmentType: 'AttachmentRef',
          provider: attachmentRef.provider,
          url: signedUrl,
          expiresSeconds,
          fileName: attachmentRef.fileName,
          mimeType: attachmentRef.mimeType,
        });
        return;
      }

      if (attachmentRef.url) {
        res.json({
          attachmentId: attachmentRef.id,
          attachmentType: 'AttachmentRef',
          provider: attachmentRef.provider,
          url: attachmentRef.url,
          fileName: attachmentRef.fileName,
          mimeType: attachmentRef.mimeType,
        });
        return;
      }

      res.status(404).json({
        error: 'AttachmentRef URL not available yet',
      });
      return;
    }

    const attachment = await prisma.attachment.findFirst({
      where: {
        id: req.params.id,
        orgId,
      },
      select: {
        id: true,
        bucket: true,
        objectKey: true,
        fileName: true,
        mimeType: true,
      },
    });
    if (!attachment) {
      res.status(404).json({ error: 'Attachment not found' });
      return;
    }

    const expiresSeconds = Math.min(
      Math.max(Number(req.query.expiresSeconds ?? 900), 60),
      3600,
    );
    const signedUrl = await getStorageSignedUrl({
      bucket: attachment.bucket,
      objectKey: attachment.objectKey,
      expiresSeconds,
    });

    res.json({
      attachmentId: attachment.id,
      attachmentType: 'Attachment',
      provider: 'S3',
      url: signedUrl,
      expiresSeconds,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
    });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/api/accounting/expenses', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireOwnerAdminOrManager(req, orgId);

    const statusQuery =
      typeof req.query.status === 'string'
        ? req.query.status.toUpperCase()
        : undefined;
    const takeRaw = Number(req.query.limit ?? 100);
    const take = Number.isFinite(takeRaw) ? Math.min(Math.max(takeRaw, 1), 250) : 100;
    const allowedStatuses = new Set(['DRAFT', 'SUBMITTED', 'APPROVED', 'POSTED', 'REJECTED']);

    const expenses = await prisma.expense.findMany({
      where: {
        orgId,
        ...(statusQuery && allowedStatuses.has(statusQuery)
          ? { status: statusQuery as 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'POSTED' | 'REJECTED' }
          : {}),
      },
      include: {
        vendor: { select: { id: true, name: true } },
        receipt: { select: { id: true, vendorName: true, totalCents: true, currency: true } },
      },
      orderBy: { createdAt: 'desc' },
      take,
    });

    res.json({ expenses });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/accounting/expenses/:id/submit', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireOwnerAdminOrManager(req, orgId);
    const actor = await getActor(req, orgId);

    const result = await registry.execute(
      'accounting.expense.submit',
      {
        expenseId: req.params.id,
        memo: req.body?.memo,
      },
      {
        orgId,
        actorType: actor.actorType,
        actorUserId: actor.actorUserId,
        actorLabel: actor.actorLabel,
        isAutonomous: false,
      },
    );

    res.json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/accounting/expenses/:id/approve', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireOwnerAdminOrManager(req, orgId);
    const actor = await getActor(req, orgId);

    const result = await registry.execute(
      'accounting.expense.approve',
      {
        expenseId: req.params.id,
      },
      {
        orgId,
        actorType: actor.actorType,
        actorUserId: actor.actorUserId,
        actorLabel: actor.actorLabel,
        isAutonomous: false,
        reason:
          typeof req.body?.reason === 'string' && req.body.reason.trim().length > 0
            ? req.body.reason.trim()
            : 'Expense approval requested via API',
      },
    );

    res.json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/api/marketing/reviews/requests', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireOwnerAdminOrManager(req, orgId);

    const statusQuery =
      typeof req.query.status === 'string' && req.query.status.trim().length > 0
        ? req.query.status
            .split(',')
            .map((part) => part.trim().toUpperCase())
            .filter((part) => part.length > 0)
        : [];
    const validStatuses = new Set(['DRAFT', 'QUEUED_APPROVAL', 'SENT', 'FAILED']);
    const statuses = statusQuery.filter((value) => validStatuses.has(value));

    const takeRaw = Number(req.query.limit ?? 100);
    const take = Number.isFinite(takeRaw) ? Math.min(Math.max(takeRaw, 1), 250) : 100;

    const reviewRequests = await prisma.reviewRequest.findMany({
      where: {
        orgId,
        ...(statuses.length === 1
          ? { status: statuses[0] as 'DRAFT' | 'QUEUED_APPROVAL' | 'SENT' | 'FAILED' }
          : statuses.length > 1
            ? { status: { in: statuses as Array<'DRAFT' | 'QUEUED_APPROVAL' | 'SENT' | 'FAILED'> } }
            : {}),
      },
      include: {
        customer: {
          select: {
            id: true,
            fullName: true,
            phone: true,
            email: true,
          },
        },
        job: {
          select: {
            id: true,
            title: true,
            status: true,
          },
        },
        approvalRequest: {
          select: {
            id: true,
            status: true,
            requiredApprovals: true,
            createdAt: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take,
    });

    res.json({
      reviewRequests,
    });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/marketing/reviews/requests/:id/send', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireOwnerAdminOrManager(req, orgId);
    const actor = await getActor(req, orgId);

    const result = await registry.execute(
      'marketing.review.request.send',
      {
        reviewRequestId: req.params.id,
        provider: req.body?.provider,
      },
      {
        orgId,
        actorType: actor.actorType,
        actorUserId: actor.actorUserId,
        actorLabel: actor.actorLabel,
        isAutonomous: true,
        reason:
          typeof req.body?.reason === 'string' && req.body.reason.trim().length > 0
            ? req.body.reason.trim()
            : 'Review request send requested via API',
      },
    );

    res.status(result.status === 'EXECUTED' ? 200 : 202).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/api/marketing/referrals/events', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireOwnerAdminOrManager(req, orgId);

    const statusQuery =
      typeof req.query.status === 'string' && req.query.status.trim().length > 0
        ? req.query.status
            .split(',')
            .map((part) => part.trim().toUpperCase())
            .filter((part) => part.length > 0)
        : [];
    const validStatuses = new Set(['INVITED', 'LEAD_CREATED', 'WON', 'REWARDED', 'VOID']);
    const statuses = statusQuery.filter((value) => validStatuses.has(value));

    const takeRaw = Number(req.query.limit ?? 100);
    const take = Number.isFinite(takeRaw) ? Math.min(Math.max(takeRaw, 1), 250) : 100;

    const events = await prisma.referralEvent.findMany({
      where: {
        orgId,
        ...(statuses.length === 1
          ? { status: statuses[0] as 'INVITED' | 'LEAD_CREATED' | 'WON' | 'REWARDED' | 'VOID' }
          : statuses.length > 1
            ? {
                status: {
                  in: statuses as Array<'INVITED' | 'LEAD_CREATED' | 'WON' | 'REWARDED' | 'VOID'>,
                },
              }
            : {}),
      },
      include: {
        program: {
          select: {
            id: true,
            name: true,
            rewardType: true,
            rewardValueCents: true,
            isActive: true,
          },
        },
        referrerCustomer: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
          },
        },
        referredLead: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            status: true,
          },
        },
        referredCustomer: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take,
    });

    res.json({ events });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post('/api/marketing/referrals/invite', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireOwnerAdminOrManager(req, orgId);
    const actor = await getActor(req, orgId);

    const body =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};

    let customerId =
      typeof body.customerId === 'string' && body.customerId.trim().length > 0
        ? body.customerId.trim()
        : '';

    if (!customerId && typeof body.leadId === 'string' && body.leadId.trim().length > 0) {
      const lead = await prisma.lead.findFirst({
        where: {
          id: body.leadId.trim(),
          orgId,
        },
      });

      if (lead) {
        const matchedCustomer = await prisma.customer.findFirst({
          where: {
            orgId,
            OR: [
              ...(lead.email ? [{ email: lead.email }] : []),
              ...(lead.phone ? [{ phone: lead.phone }] : []),
              { fullName: lead.fullName },
            ],
          },
          orderBy: { createdAt: 'asc' },
        });
        if (matchedCustomer) {
          customerId = matchedCustomer.id;
        }
      }
    }

    if (!customerId) {
      res.status(400).json({
        error: 'customerId (or leadId with a resolvable customer match) is required',
      });
      return;
    }

    const result = await registry.execute(
      'marketing.referral.invite',
      {
        customerId,
        programId: body.programId,
        channel: body.channel,
        destination: body.destination,
        messageDraft: body.messageDraft,
        linkBaseUrl: body.linkBaseUrl,
      },
      {
        orgId,
        actorType: actor.actorType,
        actorUserId: actor.actorUserId,
        actorLabel: actor.actorLabel,
        isAutonomous: false,
        reason:
          typeof body.reason === 'string' && body.reason.trim().length > 0
            ? body.reason.trim()
            : 'Referral invite requested via API',
      },
    );

    res.status(result.status === 'EXECUTED' ? 201 : 202).json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.post(
  '/api/catalog/equipment/csv/upload',
  equipmentCatalogUpload.single('file'),
  async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const access = await requireOwnerOrAdmin(req, orgId);

      if (!req.file) {
        res.status(400).json({ error: 'file is required (multipart/form-data)' });
        return;
      }

      const uploadedFile = req.file;
      const originalName = uploadedFile.originalname || 'equipment-catalog.csv';
      const originalExt = extname(originalName);
      const normalizedName = basename(originalName, originalExt);
      const safeName = sanitizeObjectKeySegment(normalizedName) || 'equipment-catalog';
      const objectKey = `catalog/equipment/${orgId}/${Date.now()}-${randomUUID()}-${safeName}.csv`;

      const uploadedObject = await putObject({
        objectKey,
        body: uploadedFile.buffer,
        contentType: uploadedFile.mimetype || 'text/csv',
        metadata: {
          source: 'equipment_catalog_csv',
          orgId,
          uploadedByUserId: access.user.id,
        },
      });
      const checksumSha256 =
        uploadedObject.checksumSha256 ?? (await computeChecksum(uploadedFile.buffer));

      const attachmentResult = await registry.execute(
        'crm.attachmentRef.create',
        {
          provider: 'S3',
          bucket: uploadedObject.bucket,
          objectKey: uploadedObject.objectKey,
          fileName: originalName,
          mimeType: uploadedFile.mimetype || 'text/csv',
          sizeBytes: uploadedFile.size,
          checksumSha256,
          metadata: {
            source: 'equipment_catalog_csv',
            uploadedAt: new Date().toISOString(),
          },
        },
        {
          orgId,
          actorType: ActorType.HUMAN,
          actorUserId: access.user.id,
          actorLabel: 'api-equipment-catalog-upload',
          isAutonomous: false,
          reason: 'Create attachment reference for equipment catalog CSV',
        },
      );
      ensureToolExecuted(attachmentResult, 'crm.attachmentRef.create');
      const attachmentOutput = getExecutionOutputObject(attachmentResult.output);
      const attachmentObject = getExecutionOutputObject(attachmentOutput.attachmentRef);
      const attachmentRefId =
        typeof attachmentOutput.attachmentRefId === 'string'
          ? attachmentOutput.attachmentRefId
          : typeof attachmentObject.id === 'string'
            ? attachmentObject.id
            : null;
      if (!attachmentRefId) {
        throw new Error('Failed to resolve attachmentRefId for uploaded equipment CSV');
      }

      const sourceNameRaw = req.body?.name;
      const sourceName =
        typeof sourceNameRaw === 'string' && sourceNameRaw.trim().length > 0
          ? sourceNameRaw.trim()
          : normalizedName || 'Equipment Catalog CSV';

      const mapping = parseEquipmentCatalogMapping(req.body?.mapping);
      const importResult = await registry.execute(
        'catalog.equipment.importCsv',
        {
          sourceName,
          csvContent: uploadedFile.buffer.toString('utf8'),
          attachmentRefId,
          ...(mapping ? { mapping } : {}),
          metadata: {
            originalFileName: originalName,
            mimeType: uploadedFile.mimetype,
            sizeBytes: uploadedFile.size,
          },
        },
        {
          orgId,
          actorType: ActorType.HUMAN,
          actorUserId: access.user.id,
          actorLabel: 'api-equipment-catalog-upload',
          isAutonomous: false,
          reason: 'Import distributor equipment catalog CSV',
        },
      );

      const statusCode =
        importResult.status === 'EXECUTED'
          ? 201
          : importResult.status === 'BLOCKED'
            ? 403
            : 202;

      res.status(statusCode).json({
        ...importResult,
        attachmentRefId,
        storage: {
          bucket: uploadedObject.bucket,
          objectKey: uploadedObject.objectKey,
        },
      });
    } catch (error) {
      const status = (error as Error & { status?: number }).status ?? 400;
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(status).json({ error: message });
    }
  },
);

app.post(
  '/api/integrations/jobber/csv/upload',
  jobberCsvUpload.single('file'),
  async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const access = await requireOwnerOrAdmin(req, orgId);

      if (!req.file) {
        res.status(400).json({ error: 'file is required (multipart/form-data)' });
        return;
      }
      const uploadedFile = req.file;

      const type = req.body?.type;
      if (!isJobberCsvType(type)) {
        res.status(400).json({
          error:
            'type must be one of: clients, products_services, quotes_report, invoices_report',
        });
        return;
      }

      const dryRun = parseDryRunOption(req.body?.options);
      const csvText = uploadedFile.buffer.toString('utf8');
      const acceptedRows = countAcceptedCsvRows(csvText);
      const extension = extname(uploadedFile.originalname || '').toLowerCase() || '.csv';
      const uploadDir = process.env.JOBBER_CSV_UPLOAD_DIR ?? '/tmp/jobber-csv-imports';
      await mkdir(uploadDir, { recursive: true });

      const uniqueToken = randomUUID();
      const safeExtension = extension === '.csv' ? '.csv' : '.csv';
      const filePath = join(
        uploadDir,
        `${orgId}-${type}-${Date.now()}-${uniqueToken}${safeExtension}`,
      );
      await writeFile(filePath, uploadedFile.buffer);

      const importRun = await prisma.$transaction(async (tx) => {
        const created = await tx.importRun.create({
          data: {
            orgId,
            provider: ImportProvider.JOBBER,
            mode: ImportMode.CSV,
            sourceType: type,
            status: ImportRunStatus.QUEUED,
            startedByUserId: access.user.id,
            cursorState: {
              filePath,
              rowCursor: 0,
            },
            stats: {
              acceptedRows,
              processed: 0,
              created: 0,
              updated: 0,
              skipped: 0,
              failed: 0,
            },
            options: {
              dryRun,
              filename: uploadedFile.originalname,
              mimeType: uploadedFile.mimetype,
              sizeBytes: uploadedFile.size,
            },
          },
          select: { id: true },
        });

        await enqueueOutbox(tx, {
          orgId,
          eventType: 'jobber.csv.import.requested',
          payload: {
            provider: ImportProvider.JOBBER,
            mode: ImportMode.CSV,
            importRunId: created.id,
            filePath,
            csvContent: csvText,
            type,
            acceptedRows,
            dryRun,
            actorUserId: access.user.id,
          },
        });

        return created;
      });

      res.status(202).json({
        importRunId: importRun.id,
        acceptedRows,
        queued: true,
      });
    } catch (error) {
      const status = (error as Error & { status?: number }).status ?? 400;
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(status).json({ error: message });
    }
  },
);

app.get('/api/integrations/jobber/import/runs', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireOwnerOrAdmin(req, orgId);
    const limitRaw = Number(req.query.limit ?? 50);
    const take = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;

    const runs = await prisma.importRun.findMany({
      where: {
        orgId,
        provider: ImportProvider.JOBBER,
      },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        provider: true,
        mode: true,
        sourceType: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        startedAt: true,
        completedAt: true,
        lastError: true,
        cursorState: true,
        stats: true,
        options: true,
      },
    });

    res.json({
      runs: runs.map((run) => ({
        ...run,
        stats: run.stats ?? {},
      })),
    });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/api/integrations/jobber/import/runs/:id', async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await requireOwnerOrAdmin(req, orgId);

    const run = await prisma.importRun.findFirst({
      where: {
        id: req.params.id,
        orgId,
        provider: ImportProvider.JOBBER,
      },
      select: {
        id: true,
        orgId: true,
        provider: true,
        mode: true,
        sourceType: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        startedAt: true,
        completedAt: true,
        lastError: true,
        cursorState: true,
        stats: true,
        options: true,
      },
    });

    if (!run) {
      res.status(404).json({ error: 'Import run not found' });
      return;
    }

    const [sourceRawCount, sourceMappingCount] = await Promise.all([
      prisma.sourceRaw.count({
        where: { importRunId: run.id },
      }),
      prisma.sourceMapping.count({
        where: {
          orgId,
          provider: ImportProvider.JOBBER,
          sourceType: run.sourceType,
        },
      }),
    ]);

    res.json({
      run: {
        ...run,
        stats: run.stats ?? {},
      },
      diagnostics: {
        sourceRawCount,
        sourceMappingCountForType: sourceMappingCount,
      },
    });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.get('/api/stream', async (req, res) => {
  let streamLeaseId: string | null = null;
  try {
    const orgId = await getOrgId(req);
    const streamAccess = await requireStreamAccess(req, orgId);
    const streamSinceMaxQueryBytes = parsePositiveIntValue(
      process.env.STREAM_SINCE_MAX_QUERY_BYTES,
      128,
    );
    const parsedSince = parseStreamSinceCursor({
      rawSince: req.query.since,
      maxQueryBytes: streamSinceMaxQueryBytes,
    });
    if (!parsedSince.ok) {
      res.status(400).json({
        error: parsedSince.message,
        code: parsedSince.code,
        details: parsedSince.details,
      });
      return;
    }

    const streamTypesMaxQueryBytes = parsePositiveIntValue(
      process.env.STREAM_TYPES_MAX_QUERY_BYTES,
      512,
    );
    const parsedTypeFilter = parseStreamEventTypeFilter({
      rawTypes: req.query.types,
      allowedTypes: STREAM_EVENT_TYPES,
      maxQueryBytes: streamTypesMaxQueryBytes,
    });
    if (!parsedTypeFilter.ok) {
      res.status(400).json({
        error: parsedTypeFilter.message,
        code: parsedTypeFilter.code,
        details: parsedTypeFilter.details,
      });
      return;
    }

    const lease = streamConnections.tryOpen(streamAccess.user.id);
    if (!lease.ok) {
      res.status(429).json({
        error: 'Stream connection limit exceeded',
        code: lease.code,
        max: lease.max,
        active: lease.active,
      });
      return;
    }
    streamLeaseId = lease.leaseId;

    let cursor = applyLastEventIdCursor(
      parseStreamCursor(parsedSince.since),
      req.header('last-event-id'),
    );
    const typeFilter = parsedTypeFilter.filter;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    (res as Response & { flushHeaders?: () => void }).flushHeaders?.();

    const shouldEmit = (type: StreamEventType) => !typeFilter || typeFilter.has(type);
    let backpressuredAtMs: number | null = null;
    let backpressureLogged = false;
    const writeEvent = (event: StreamEventMessage): boolean => {
      if (!shouldEmit(event.type)) {
        return true;
      }
      const payload = JSON.stringify({
        ...event.payload,
        orgId,
      });
      const id = event.key;
      const ok =
        res.write(`id: ${id}\n`) &&
        res.write(`event: ${event.type}\n`) &&
        res.write(`data: ${payload}\n\n`);
      if (!ok && backpressuredAtMs === null) {
        backpressuredAtMs = Date.now();
        if (!backpressureLogged) {
          backpressureLogged = true;
          logStructured('warn', 'stream.backpressure.started', {
            orgId,
            leaseId: streamLeaseId,
            eventType: event.type,
            eventId: id,
          });
        }
      }
      return ok;
    };

    const streamReadyAt = new Date();
    writeEvent({
      type: 'agent.run.updated',
      at: streamReadyAt,
      key: `agent.run.updated:stream-ready:${streamReadyAt.toISOString()}`,
      payload: { id: 'stream-ready', status: 'CONNECTED', since: cursor.ts.toISOString() },
    });

    let closed = false;
    let polling = false;
    const clearBackpressure = () => {
      if (backpressuredAtMs === null) {
        return;
      }
      logStructured('info', 'stream.backpressure.cleared', {
        orgId,
        leaseId: streamLeaseId,
        durationMs: Date.now() - backpressuredAtMs,
      });
      backpressuredAtMs = null;
      backpressureLogged = false;
    };
    (res as Response & { on: (event: string, listener: () => void) => void }).on(
      'drain',
      clearBackpressure,
    );

    const poll = async () => {
      if (closed || polling) {
        return;
      }
      if (backpressuredAtMs !== null) {
        if (Date.now() - backpressuredAtMs >= STREAM_MAX_BACKPRESSURE_MS) {
          logStructured('warn', 'stream.backpressure.timeout', {
            orgId,
            leaseId: streamLeaseId,
            maxBackpressureMs: STREAM_MAX_BACKPRESSURE_MS,
          });
          res.write(
            `event: stream.error\ndata: ${JSON.stringify({
              error: 'Stream backpressure timeout',
              code: 'STREAM_BACKPRESSURE_TIMEOUT',
            })}\n\n`,
          );
          closed = true;
          res.end();
        }
        return;
      }
      polling = true;
      const startedCursor = cursor;
      try {
        const [
          toolExecutions,
          approvalRequests,
          agentRuns,
          safetyStates,
          policies,
          exposures,
        ] = await Promise.all([
          prisma.toolExecution.findMany({
            where: {
              orgId,
              OR: [{ createdAt: { gte: startedCursor.ts } }, { updatedAt: { gte: startedCursor.ts } }],
            },
            include: {
              toolDefinition: {
                select: { name: true },
              },
            },
            orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
            take: STREAM_MAX_ROWS_PER_TABLE,
          }),
          prisma.approvalRequest.findMany({
            where: {
              orgId,
              OR: [{ createdAt: { gte: startedCursor.ts } }, { updatedAt: { gte: startedCursor.ts } }],
            },
            include: {
              toolDefinition: {
                select: { name: true },
              },
            },
            orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
            take: STREAM_MAX_ROWS_PER_TABLE,
          }),
          prisma.agentRun.findMany({
            where: { orgId, updatedAt: { gte: startedCursor.ts } },
            orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
            take: STREAM_MAX_ROWS_PER_TABLE,
          }),
          prisma.orgSafetyState.findMany({
            where: { orgId, updatedAt: { gte: startedCursor.ts } },
            orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
            take: STREAM_MAX_ROWS_PER_TABLE,
          }),
          prisma.policy.findMany({
            where: { orgId, isActive: true, updatedAt: { gte: startedCursor.ts } },
            orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
            take: STREAM_MAX_ROWS_PER_TABLE,
          }),
          prisma.financialExposureDaily.findMany({
            where: { orgId, updatedAt: { gte: startedCursor.ts } },
            orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
            take: STREAM_MAX_ROWS_PER_TABLE,
          }),
        ]);

        const events: StreamEventMessage[] = [];
        for (const execution of toolExecutions) {
          const payload = {
            id: execution.id,
            createdAt: execution.createdAt.toISOString(),
            updatedAt: execution.updatedAt.toISOString(),
            status: execution.status,
            riskLevel: execution.riskLevelSnapshot,
            toolName: execution.toolDefinition.name,
            summary: execution.blockedReason ?? execution.reason ?? execution.errorMessage ?? null,
            actorType: execution.actorType,
            agentRunId: execution.agentRunId,
            approvalRequestId: execution.approvalRequestId,
          };
          if (execution.createdAt >= startedCursor.ts) {
            events.push({
              type: 'tool.execution.created',
              at: execution.createdAt,
              key: `tool.execution.created:${execution.id}:${execution.createdAt.toISOString()}`,
              payload,
            });
          }
          if (
            execution.updatedAt >= startedCursor.ts &&
            execution.updatedAt.getTime() !== execution.createdAt.getTime()
          ) {
            events.push({
              type: 'tool.execution.updated',
              at: execution.updatedAt,
              key: `tool.execution.updated:${execution.id}:${execution.updatedAt.toISOString()}`,
              payload,
            });
          }
        }

        for (const request of approvalRequests) {
          const payload = {
            id: request.id,
            createdAt: request.createdAt.toISOString(),
            updatedAt: request.updatedAt.toISOString(),
            status: request.status,
            requiredApprovals: request.requiredApprovals,
            toolName: request.toolDefinition.name,
            summary: request.reason ?? null,
            actorType: request.requestedByType,
          };
          if (request.createdAt >= startedCursor.ts) {
            events.push({
              type: 'approval.request.created',
              at: request.createdAt,
              key: `approval.request.created:${request.id}:${request.createdAt.toISOString()}`,
              payload,
            });
          }
          if (request.updatedAt >= startedCursor.ts && request.updatedAt.getTime() !== request.createdAt.getTime()) {
            events.push({
              type: 'approval.request.updated',
              at: request.updatedAt,
              key: `approval.request.updated:${request.id}:${request.updatedAt.toISOString()}`,
              payload,
            });
          }
        }

        for (const run of agentRuns) {
          events.push({
            type: 'agent.run.updated',
            at: run.updatedAt,
            key: `agent.run.updated:${run.id}:${run.updatedAt.toISOString()}`,
            payload: {
              id: run.id,
              goal: run.goal,
              status: run.status,
              currentSkillId: run.currentSkillId,
              startedAt: run.startedAt.toISOString(),
              updatedAt: run.updatedAt.toISOString(),
            },
          });
        }

        for (const safety of safetyStates) {
          events.push({
            type: 'system.killswitch.updated',
            at: safety.updatedAt,
            key: `system.killswitch.updated:${safety.id}:${safety.updatedAt.toISOString()}`,
            payload: {
              id: safety.id,
              mode: safety.mode,
              reason: safety.reason,
              updatedAt: safety.updatedAt.toISOString(),
              updatedByUserId: safety.updatedByUserId,
            },
          });
        }

        for (const policy of policies) {
          events.push({
            type: 'system.policy.updated',
            at: policy.updatedAt,
            key: `system.policy.updated:${policy.id}:${policy.updatedAt.toISOString()}`,
            payload: {
              id: policy.id,
              name: policy.name,
              version: policy.version,
              updatedAt: policy.updatedAt.toISOString(),
            },
          });
        }

        for (const exposure of exposures) {
          events.push({
            type: 'finance.exposure.updated',
            at: exposure.updatedAt,
            key: `finance.exposure.updated:${exposure.id}:${exposure.updatedAt.toISOString()}`,
            payload: {
              id: exposure.id,
              date: exposure.date.toISOString().slice(0, 10),
              bucket: exposure.bucket,
              usedCents: exposure.usedCents,
              updatedAt: exposure.updatedAt.toISOString(),
            },
          });
        }

        events.sort((a, b) => {
          const byTime = a.at.getTime() - b.at.getTime();
          if (byTime !== 0) {
            return byTime;
          }
          return a.key.localeCompare(b.key);
        });

        const limitedEvents = capStreamEvents(events, STREAM_MAX_EVENTS_PER_POLL);
        if (limitedEvents.truncated) {
          logStructured('warn', 'stream.events.capped', {
            orgId,
            leaseId: streamLeaseId,
            totalEvents: limitedEvents.total,
            emittedEvents: limitedEvents.events.length,
            maxEventsPerPoll: STREAM_MAX_EVENTS_PER_POLL,
          });
        }

        const deliveredEvents: StreamCursorEvent[] = [];
        for (const event of limitedEvents.events) {
          const cursorEvent: StreamCursorEvent = { at: event.at, id: event.key };
          if (!shouldEmitStreamEvent(startedCursor, cursorEvent)) {
            continue;
          }
          deliveredEvents.push(cursorEvent);
          const writeOk = writeEvent(event);
          if (!writeOk) {
            break;
          }
        }

        cursor = advanceStreamCursor(startedCursor, deliveredEvents);
      } catch (error) {
        if (!closed) {
          const message = error instanceof Error ? error.message : 'Unknown stream polling error';
          res.write(`event: stream.error\ndata: ${JSON.stringify({ error: message })}\n\n`);
        }
      } finally {
        polling = false;
      }
    };

    const pollInterval = setInterval(() => {
      void poll();
    }, 1_500);

    const heartbeatInterval = setInterval(() => {
      if (!closed && backpressuredAtMs === null) {
        res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
      }
    }, 15_000);

    void poll();

    req.on('close', () => {
      closed = true;
      clearInterval(pollInterval);
      clearInterval(heartbeatInterval);
      if (streamLeaseId) {
        streamConnections.close(streamLeaseId);
        streamLeaseId = null;
      }
      res.end();
    });
  } catch (error) {
    if (streamLeaseId) {
      streamConnections.close(streamLeaseId);
      streamLeaseId = null;
    }
    const status = (error as Error & { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(status).json({ error: message });
  }
});

registerHvacDiagnosticRoutes({
  app,
  prisma,
  registry,
  getOrgId,
  requireAnyPermission,
  executionStatusCode,
});

const isDirectExecution =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    logStructured('error', 'process.unhandledRejection', { message });
    void emitErrorTelemetry({
      type: 'process_unhandled_rejection',
      message,
    });
  });

  process.on('uncaughtException', (error) => {
    const message = error instanceof Error ? error.message : String(error);
    logStructured('error', 'process.uncaughtException', {
      message,
      stack: error instanceof Error ? error.stack ?? null : null,
    });
    void emitErrorTelemetry({
      type: 'process_uncaught_exception',
      message,
    });
  });

  enforceProductionSecurityConfig();

  const port = Number(process.env.PORT ?? 3001);
  app.listen(port, () => {
    logStructured('info', 'api.started', { port });
  });
}

export { app };
