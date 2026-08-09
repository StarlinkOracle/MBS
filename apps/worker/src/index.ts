import {
  ActorType,
  OutboxStatus,
  TaskStatus,
  prisma,
} from '@rcs/db';
import { randomUUID } from 'node:crypto';
import {
  enqueueOutbox,
  markOutboxFailed,
  markOutboxPublished,
} from '@rcs/event-bus';
import { ToolRegistry } from '@rcs/tool-registry';

import {
  localDateKey,
  runGeoRollupDailyForOrg,
  shiftDateKey,
} from './geo-rollup.js';
import { processJobberCsvImportRequested } from './jobber-csv-import.js';
import { processReceiptUploaded } from './receipt-ocr.js';

const registry = new ToolRegistry(prisma);

const pollMs = Number(process.env.WORKER_POLL_MS ?? 2000);

type ApprovalApprovedPayload = {
  approvalRequestId: string;
  finalizedByUserId?: string;
};

let lastGeoRollupScheduleKey: string | null = null;
let lastMediaPurgeScheduleKey: string | null = null;
const lastCommsSyncAtByOrg = new Map<string, number>();
const lastLeadSlaSweepAtByOrg = new Map<string, number>();
const leadSlaEventMarkerCache = new Map<string, number>();

function logStructured(
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, unknown>,
): void {
  const payload = {
    level,
    event,
    ts: new Date().toISOString(),
    service: 'worker',
    ...fields,
  };
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
        service: 'worker',
        ts: new Date().toISOString(),
        ...fields,
      }),
    });
  } catch {
    // Never fail processing loop due to telemetry transport issues.
  }
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

function localHourInTimezone(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '0';
  return Number.parseInt(hour, 10) || 0;
}

async function scheduleDailyGeoRollupIfDue(now: Date = new Date()) {
  const timezone = process.env.GEO_ROLLUP_TIMEZONE ?? 'America/Denver';
  const scheduleHour = Number.parseInt(process.env.GEO_ROLLUP_HOUR ?? '3', 10) || 3;
  const localHour = localHourInTimezone(now, timezone);

  if (localHour < scheduleHour) {
    return;
  }

  const todayKey = localDateKey(now, timezone);
  if (lastGeoRollupScheduleKey === todayKey) {
    return;
  }

  const targetDateKey = shiftDateKey(todayKey, -1);
  const targetDate = new Date(`${targetDateKey}T00:00:00.000Z`);
  const organizations = await prisma.organization.findMany({
    select: { id: true },
  });

  for (const organization of organizations) {
    const alreadyRolled = await prisma.geoRollupDaily.count({
      where: {
        orgId: organization.id,
        date: targetDate,
      },
    });
    if (alreadyRolled > 0) {
      continue;
    }

    await enqueueOutbox(prisma, {
      orgId: organization.id,
      eventType: 'geo.rollup.daily',
      correlationId: `geo-rollup-${organization.id}-${targetDateKey}`,
      payload: {
        targetDate: targetDateKey,
        timezone,
      },
    });
  }

  lastGeoRollupScheduleKey = todayKey;
}

async function scheduleDailyMediaPurgeIfDue(now: Date = new Date()) {
  const timezone = process.env.MEDIA_PURGE_TIMEZONE ?? 'America/Denver';
  const scheduleHour = Number.parseInt(process.env.MEDIA_PURGE_HOUR ?? '2', 10) || 2;
  const localHour = localHourInTimezone(now, timezone);

  if (localHour < scheduleHour) {
    return;
  }

  const todayKey = localDateKey(now, timezone);
  if (lastMediaPurgeScheduleKey === todayKey) {
    return;
  }

  const organizations = await prisma.organization.findMany({
    select: { id: true },
  });

  for (const organization of organizations) {
    const actorUserId = await resolveWorkerActorUserId(organization.id);
    if (!actorUserId) {
      continue;
    }

    const result = await registry.execute(
      'admin.media.purgeExpired',
      {
        limit: Number.parseInt(process.env.MEDIA_PURGE_LIMIT ?? '500', 10) || 500,
      },
      {
        orgId: organization.id,
        actorType: ActorType.SYSTEM,
        actorUserId,
        actorLabel: 'media-purge-worker',
        correlationId: `media-purge-${todayKey}-${organization.id}`,
        isAutonomous: false,
        reason: 'Daily media retention purge',
      },
    );

    const output =
      result.status === 'EXECUTED' &&
      result.output &&
      typeof result.output === 'object' &&
      !Array.isArray(result.output)
        ? (result.output as Record<string, unknown>)
        : {};

    await enqueueOutbox(prisma, {
      orgId: organization.id,
      eventType: 'media.purge.daily.completed',
      correlationId: `media-purge-${todayKey}-${organization.id}`,
      payload: {
        date: todayKey,
        status: result.status,
        purgedCount:
          typeof output.purgedCount === 'number'
            ? output.purgedCount
            : Number(output.purgedCount ?? 0),
        expiredSessionCount:
          typeof output.expiredSessionCount === 'number'
            ? output.expiredSessionCount
            : Number(output.expiredSessionCount ?? 0),
      },
    });
  }

  lastMediaPurgeScheduleKey = todayKey;
}

async function scheduleCommsSyncIfDue(now: Date = new Date()) {
  const intervalMs = Number.parseInt(
    process.env.COMMS_SYNC_INTERVAL_MS ?? String(5 * 60 * 1000),
    10,
  ) || 5 * 60 * 1000;
  const organizations = await prisma.organization.findMany({
    select: { id: true },
  });

  for (const organization of organizations) {
    const lastRun = lastCommsSyncAtByOrg.get(organization.id) ?? 0;
    if (now.getTime() - lastRun < intervalMs) {
      continue;
    }

    const actorUserId = await resolveWorkerActorUserId(organization.id);
    if (!actorUserId) {
      continue;
    }

    try {
      await registry.execute(
        'comms.imessage.sync',
        {
          fullSync: false,
          batchSize: Number.parseInt(
            process.env.COMMS_IMESSAGE_SYNC_BATCH_SIZE ?? '250',
            10,
          ) || 250,
        },
        {
          orgId: organization.id,
          actorType: ActorType.SYSTEM,
          actorUserId,
          actorLabel: 'comms-sync-worker',
          correlationId: `comms-sync-imessage-${organization.id}-${now.getTime()}`,
          isAutonomous: false,
          reason: 'Scheduled iMessage incremental sync',
        },
      );
    } catch {
      // Keep worker loop resilient when iMessage chat.db is unavailable.
    }

    const gmailAccountConfigured =
      Boolean(process.env.GMAIL_ACCOUNT_ID?.trim()) ||
      Boolean(
        await prisma.commsAccount.findFirst({
          where: { orgId: organization.id, kind: 'GMAIL' },
          select: { id: true },
        }),
      );

    if (gmailAccountConfigured) {
      try {
        await registry.execute(
          'comms.gmail.sync',
          {
            fullSync: false,
            batchSize: Number.parseInt(
              process.env.COMMS_GMAIL_SYNC_BATCH_SIZE ?? '100',
              10,
            ) || 100,
          },
          {
            orgId: organization.id,
            actorType: ActorType.SYSTEM,
            actorUserId,
            actorLabel: 'comms-sync-worker',
            correlationId: `comms-sync-gmail-${organization.id}-${now.getTime()}`,
            isAutonomous: false,
            reason: 'Scheduled Gmail incremental sync',
          },
        );
      } catch {
        // Keep worker loop resilient when Gmail OAuth is not configured.
      }
    }

    lastCommsSyncAtByOrg.set(organization.id, now.getTime());
  }
}

function cleanupLeadSlaMarkerCache(nowMs: number): void {
  const ttlMs = Number.parseInt(process.env.LEAD_SLA_MARKER_TTL_MS ?? String(6 * 60 * 60 * 1000), 10) || 6 * 60 * 60 * 1000;
  for (const [key, seenAt] of leadSlaEventMarkerCache.entries()) {
    if (nowMs - seenAt > ttlMs) {
      leadSlaEventMarkerCache.delete(key);
    }
  }
}

function canEmitLeadSlaEventMarker(marker: string, nowMs: number): boolean {
  const existing = leadSlaEventMarkerCache.get(marker);
  if (typeof existing === 'number') {
    return false;
  }
  leadSlaEventMarkerCache.set(marker, nowMs);
  return true;
}

async function scheduleLeadSlaChecksIfDue(now: Date = new Date()) {
  const intervalMs = Number.parseInt(
    process.env.LEAD_SLA_SWEEP_INTERVAL_MS ?? String(5 * 60 * 1000),
    10,
  ) || 5 * 60 * 1000;
  const nowMs = now.getTime();
  cleanupLeadSlaMarkerCache(nowMs);

  const organizations = await prisma.organization.findMany({
    select: { id: true },
  });

  for (const organization of organizations) {
    const lastRun = lastLeadSlaSweepAtByOrg.get(organization.id) ?? 0;
    if (nowMs - lastRun < intervalMs) {
      continue;
    }

    const actorUserId = await resolveWorkerActorUserId(organization.id);
    const leads = await prisma.lead.findMany({
      where: {
        orgId: organization.id,
        nextTouchDueAt: {
          not: null,
        },
        stage: {
          notIn: ['WON', 'LOST'],
        },
      },
      select: {
        id: true,
        fullName: true,
        stage: true,
        nextTouchDueAt: true,
      },
      orderBy: [{ nextTouchDueAt: 'asc' }],
      take: 250,
    });

    for (const lead of leads) {
      const evaluation = await registry.execute(
        'lead.sla.evaluate',
        {
          leadId: lead.id,
        },
        {
          orgId: organization.id,
          actorType: ActorType.SYSTEM,
          actorUserId,
          actorLabel: 'lead-sla-worker',
          correlationId: `lead-sla-eval-${organization.id}-${lead.id}-${nowMs}`,
          isAutonomous: false,
          reason: 'Evaluate lead SLA health',
        },
      );
      if (evaluation.status !== 'EXECUTED') {
        continue;
      }
      const output =
        evaluation.output && typeof evaluation.output === 'object' && !Array.isArray(evaluation.output)
          ? (evaluation.output as Record<string, unknown>)
          : {};
      const slaStatus =
        output.slaStatus === 'OVERDUE' || output.slaStatus === 'DUE_SOON'
          ? output.slaStatus
          : 'OK';
      const minutesUntilDue =
        typeof output.minutesUntilDue === 'number' && Number.isFinite(output.minutesUntilDue)
          ? Math.floor(output.minutesUntilDue)
          : 0;
      if (slaStatus === 'OK') {
        continue;
      }

      const dueIso = lead.nextTouchDueAt ? lead.nextTouchDueAt.toISOString() : 'none';
      const marker = `${organization.id}:${lead.id}:${slaStatus}:${dueIso}`;
      if (canEmitLeadSlaEventMarker(marker, nowMs)) {
        await enqueueOutbox(prisma, {
          orgId: organization.id,
          eventType:
            slaStatus === 'OVERDUE'
              ? 'lead.sla.breach.detected'
              : 'lead.sla.warning.detected',
          correlationId: `lead-sla-${organization.id}-${lead.id}-${dueIso}`,
          payload: {
            leadId: lead.id,
            leadName: lead.fullName,
            stage: lead.stage,
            slaStatus,
            minutesUntilDue,
            nextTouchDueAt: dueIso,
          },
        });
      }

      const openNextActionCount = await prisma.task.count({
        where: {
          orgId: organization.id,
          leadId: lead.id,
          isNextAction: true,
          status: {
            in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS],
          },
        },
      });
      if (openNextActionCount > 0) {
        continue;
      }

      const fallbackDueAt =
        slaStatus === 'OVERDUE'
          ? new Date(nowMs + 10 * 60 * 1000)
          : lead.nextTouchDueAt ?? new Date(nowMs + 30 * 60 * 1000);
      await registry.execute(
        'lead.nextAction.set',
        {
          leadId: lead.id,
          task: {
            title:
              slaStatus === 'OVERDUE'
                ? 'SLA overdue follow-up required'
                : 'SLA due soon follow-up',
            description:
              slaStatus === 'OVERDUE'
                ? 'Lead is overdue for follow-up. Contact immediately.'
                : 'Lead follow-up is due soon. Reach out before breach.',
            dueAt: fallbackDueAt.toISOString(),
            priority: slaStatus === 'OVERDUE' ? 'HIGH' : 'NORMAL',
            type: 'FOLLOW_UP',
          },
          replaceExisting: false,
          requestId: `lead-sla-task:${slaStatus.toLowerCase()}:${lead.id}:${dueIso}`,
        },
        {
          orgId: organization.id,
          actorType: ActorType.SYSTEM,
          actorUserId,
          actorLabel: 'lead-sla-worker',
          correlationId: `lead-sla-task-${organization.id}-${lead.id}-${dueIso}`,
          isAutonomous: false,
          reason: `Create internal ${slaStatus.toLowerCase()} lead SLA follow-up task`,
        },
      );
    }

    lastLeadSlaSweepAtByOrg.set(organization.id, nowMs);
  }
}

async function resolveWorkerActorUserId(orgId: string): Promise<string | undefined> {
  const adminUser = await prisma.user.findFirst({
    where: {
      orgId,
      isActive: true,
      userRoles: {
        some: {
          role: {
            name: 'admin',
          },
        },
      },
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  if (adminUser?.id) {
    return adminUser.id;
  }

  const systemUser = await prisma.user.findFirst({
    where: {
      orgId,
      actorType: ActorType.SYSTEM,
      isActive: true,
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  if (systemUser?.id) {
    return systemUser.id;
  }

  const humanUser = await prisma.user.findFirst({
    where: {
      orgId,
      actorType: ActorType.HUMAN,
      isActive: true,
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  return humanUser?.id;
}

async function processGeoBackfillJobs(orgId: string) {
  const jobs = await prisma.job.findMany({
    where: {
      orgId,
      jobGeo: {
        is: null,
      },
    },
    select: {
      id: true,
    },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });

  if (jobs.length === 0) {
    return;
  }

  const systemActorUserId = await resolveWorkerActorUserId(orgId);

  for (const job of jobs) {
    const result = await registry.execute(
      'jobs.geo.ensure',
      {
        jobId: job.id,
      },
      {
        orgId,
        actorType: ActorType.SYSTEM,
        actorUserId: systemActorUserId,
        actorLabel: 'geo-backfill-worker',
        isAutonomous: false,
        reason: 'geo.backfill.jobs',
      },
    );
    if (result.status !== 'EXECUTED') {
      throw new Error(
        `geo.backfill.jobs failed for job ${job.id}: ${result.status}`,
      );
    }
  }
}

async function processEvent(event: {
  id: string;
  orgId: string;
  eventType: string;
  correlationId?: string;
  payload: unknown;
}) {
  if (event.eventType === 'approval.approved') {
    const payload = event.payload as ApprovalApprovedPayload;
    await registry.executeApprovedRequest(payload.approvalRequestId, {
      orgId: event.orgId,
      actorType: ActorType.HUMAN,
      actorUserId: payload.finalizedByUserId,
      actorLabel: 'approval-worker',
      correlationId: event.correlationId ?? `approval-worker-${payload.approvalRequestId}`,
      isAutonomous: false,
    });
    return;
  }

  if (event.eventType === 'jobber.csv.import.requested') {
    await processJobberCsvImportRequested({
      prisma,
      registry,
      orgId: event.orgId,
      payload: event.payload,
    });
    return;
  }

  if (event.eventType === 'receipt.uploaded') {
    await processReceiptUploaded({
      prisma,
      registry,
      orgId: event.orgId,
      payload: event.payload,
    });
    return;
  }

  if (event.eventType === 'geo.backfill.jobs') {
    await processGeoBackfillJobs(event.orgId);
    return;
  }

  if (event.eventType === 'job.completed') {
    const payload =
      event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : {};
    const jobId = typeof payload.jobId === 'string' ? payload.jobId.trim() : '';
    if (!jobId) {
      throw new Error('job.completed payload missing jobId');
    }

    const queueSend = toBoolean(payload.queueSend);
    const channel = typeof payload.channel === 'string' ? payload.channel.trim() : '';
    const reviewUrl = typeof payload.reviewUrl === 'string' ? payload.reviewUrl.trim() : '';
    const actorUserId = await resolveWorkerActorUserId(event.orgId);

    const autoResult = await registry.execute(
      'marketing.review.request.auto',
      {
        jobId,
        ...(channel ? { channel } : {}),
        ...(reviewUrl ? { reviewUrl } : {}),
        queueSend,
        source: 'job.completed',
      },
      {
        orgId: event.orgId,
        actorType: ActorType.SYSTEM,
        actorUserId,
        actorLabel: 'review-auto-worker',
        correlationId: event.correlationId ?? `review-auto-${event.id}`,
        isAutonomous: false,
        reason: 'Draft review request after job completion',
      },
    );

    if (autoResult.status !== 'EXECUTED') {
      throw new Error(`marketing.review.request.auto returned ${autoResult.status}`);
    }

    const autoOutput =
      autoResult.output && typeof autoResult.output === 'object' && !Array.isArray(autoResult.output)
        ? (autoResult.output as Record<string, unknown>)
        : {};
    const reviewRequest =
      autoOutput.reviewRequest && typeof autoOutput.reviewRequest === 'object' && !Array.isArray(autoOutput.reviewRequest)
        ? (autoOutput.reviewRequest as Record<string, unknown>)
        : {};
    const reviewRequestId =
      typeof reviewRequest.id === 'string' ? reviewRequest.id : '';

    if (queueSend && reviewRequestId) {
      await registry.execute(
        'marketing.review.request.send',
        {
          reviewRequestId,
        },
        {
          orgId: event.orgId,
          actorType: ActorType.SYSTEM,
          actorUserId,
          actorLabel: 'review-auto-worker',
          correlationId: event.correlationId ?? `review-auto-send-${event.id}`,
          isAutonomous: true,
          reason: 'Queue review request send approval after job completion',
        },
      );
    }
    return;
  }

  if (event.eventType === 'geo.rollup.daily') {
    const payload =
      event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : {};
    const targetDateRaw = payload.targetDate;
    const targetDateKey =
      typeof targetDateRaw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(targetDateRaw)
        ? targetDateRaw
        : shiftDateKey(localDateKey(new Date(), 'America/Denver'), -1);

    const result = await runGeoRollupDailyForOrg(prisma, {
      orgId: event.orgId,
      targetDateKey,
    });

    await enqueueOutbox(prisma, {
      orgId: event.orgId,
      eventType: 'geo.rollup.daily.completed',
      correlationId: event.correlationId ?? `geo-rollup-${event.orgId}-${targetDateKey}`,
      payload: {
        targetDate: targetDateKey,
        rowsWritten: result.rowsWritten,
      },
    });
  }
}

async function runTick() {
  await scheduleDailyGeoRollupIfDue();
  await scheduleDailyMediaPurgeIfDue();
  await scheduleCommsSyncIfDue();
  await scheduleLeadSlaChecksIfDue();

  const events = await prisma.eventOutbox.findMany({
    where: {
      status: OutboxStatus.PENDING,
      nextAttemptAt: {
        lte: new Date(),
      },
    },
    orderBy: { createdAt: 'asc' },
    take: 20,
  });

  for (const event of events) {
    const startedAt = Date.now();
    try {
      logStructured('info', 'outbox.event.processing_started', {
        outboxEventId: event.id,
        correlationId: event.correlationId,
        orgId: event.orgId,
        eventType: event.eventType,
      });

      await processEvent({
        id: event.id,
        orgId: event.orgId,
        eventType: event.eventType,
        correlationId: event.correlationId ?? undefined,
        payload: event.payload,
      });

      await markOutboxPublished(prisma, event.id);
      logStructured('info', 'outbox.event.processing_succeeded', {
        outboxEventId: event.id,
        correlationId: event.correlationId,
        orgId: event.orgId,
        eventType: event.eventType,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown worker error';
      await markOutboxFailed(prisma, event.id, message, 15);
      logStructured('error', 'outbox.event.processing_failed', {
        outboxEventId: event.id,
        correlationId: event.correlationId,
        orgId: event.orgId,
        eventType: event.eventType,
        durationMs: Date.now() - startedAt,
        error: message,
      });
      await emitErrorTelemetry({
        type: 'outbox_event_failure',
        outboxEventId: event.id,
        correlationId: event.correlationId,
        orgId: event.orgId,
        eventType: event.eventType,
        error: message,
      });
    }
  }
}

async function start() {
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

  logStructured('info', 'worker.started', { pollMs });
  await runTick();
  setInterval(() => {
    void runTick();
  }, pollMs);
}

void start();
