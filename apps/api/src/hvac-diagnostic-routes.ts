import type { Express, Request } from 'express';
import multer from 'multer';

import {
  ActorType,
  ExecutionStatus,
  HvacDiagnosticReportKind,
  HvacDiagnosticSessionStatus,
  type PrismaClient,
} from '@rcs/db';
import {
  HVAC_MEASUREMENT_DEFINITIONS,
  buildDeterministicHvacAssistantReply,
  evaluateHvacDiagnosticSnapshot,
  getHvacNextStep,
} from '@rcs/shared';
import {
  ToolRegistry,
  buildCurrentHvacReport,
  buildHvacSnapshotFromDetail,
  loadApplicableHvacReferencesForSession,
  loadHvacDiagnosticSessionDetail,
  lookupHvacOemReferences,
  type ToolExecutionResponse,
} from '@rcs/tool-registry';

import {
  extractHvacNameplate,
  generateHvacConversationalReply,
} from './hvac-diagnostic-ai.js';
import { renderHvacDiagnosticReportHtml } from './hvac-diagnostic-report.js';

type AccessResult = {
  user: { id: string };
  permissions: string[];
};

type RegisterHvacDiagnosticRoutesArgs = {
  app: Express;
  prisma: PrismaClient;
  registry: ToolRegistry;
  getOrgId: (req: Request) => Promise<string>;
  requireAnyPermission: (
    req: Request,
    orgId: string,
    requiredPermissions: string[],
  ) => Promise<AccessResult>;
  executionStatusCode: (result: ToolExecutionResponse, executedCode?: number) => number;
};

const nameplateUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.NAMEPLATE_UPLOAD_MAX_FILE_BYTES ?? 12 * 1024 * 1024),
  },
});

function bodyObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function paramValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function queryString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function errorStatus(error: unknown): number {
  return (error as Error & { status?: number }).status ?? 400;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown HVAC diagnostic error';
}

function executionFromStored(row: {
  id: string;
  status: ExecutionStatus;
  outputPayload: unknown;
  blockedReason: string | null;
  errorMessage: string | null;
  approvalRequestId: string | null;
}): ToolExecutionResponse | null {
  if (row.status === ExecutionStatus.EXECUTED && row.outputPayload !== null) {
    return {
      status: 'EXECUTED',
      executionId: row.id,
      output: row.outputPayload as never,
    };
  }
  if (row.status === ExecutionStatus.BLOCKED) {
    return {
      status: 'BLOCKED',
      executionId: row.id,
      reason: row.blockedReason ?? 'Previously blocked',
    };
  }
  if (row.status === ExecutionStatus.FAILED) {
    return {
      status: 'FAILED',
      executionId: row.id,
      error: row.errorMessage ?? 'Previous execution failed',
    };
  }
  return null;
}

async function executeIdempotent(args: {
  prisma: PrismaClient;
  registry: ToolRegistry;
  orgId: string;
  actorUserId: string;
  toolName: string;
  payload: Record<string, unknown>;
  clientActionId?: string | null;
  reason: string;
}): Promise<ToolExecutionResponse> {
  const clientActionId = args.clientActionId?.trim() || null;
  if (clientActionId) {
    const existing = await args.prisma.toolExecution.findFirst({
      where: {
        orgId: args.orgId,
        clientActionId,
        toolDefinition: { name: args.toolName },
      },
      select: {
        id: true,
        status: true,
        outputPayload: true,
        blockedReason: true,
        errorMessage: true,
        approvalRequestId: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      const replay = executionFromStored(existing);
      if (replay) {
        return replay;
      }
    }
  }

  return args.registry.execute(args.toolName, args.payload, {
    orgId: args.orgId,
    actorType: ActorType.HUMAN,
    actorUserId: args.actorUserId,
    actorLabel: 'api-hvac-diagnostic-pwa',
    isAutonomous: false,
    clientActionId: clientActionId ?? undefined,
    reason: args.reason,
  });
}

async function detailPayload(prisma: PrismaClient, orgId: string, sessionId: string) {
  const detail = await loadHvacDiagnosticSessionDetail(prisma, orgId, sessionId);
  if (!detail) {
    const notFound = new Error('HVAC diagnostic session not found');
    (notFound as Error & { status?: number }).status = 404;
    throw notFound;
  }
  const snapshot = await buildHvacSnapshotFromDetail(prisma, detail);
  const nextStep = getHvacNextStep(snapshot, 'INITIAL');
  const currentFindings = evaluateHvacDiagnosticSnapshot(snapshot, 'INITIAL');
  const references = await loadApplicableHvacReferencesForSession(prisma, detail);

  return {
    session: detail,
    snapshot,
    nextStep,
    findings: currentFindings,
    references,
    measurementDefinitions: Object.values(HVAC_MEASUREMENT_DEFINITIONS),
  };
}

export function registerHvacDiagnosticRoutes({
  app,
  prisma,
  registry,
  getOrgId,
  requireAnyPermission,
  executionStatusCode,
}: RegisterHvacDiagnosticRoutesArgs): void {
  app.get('/api/hvac/context', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const access = await requireAnyPermission(req, orgId, [
        'hvac:diagnostic:read',
        'hvac:diagnostic:write',
        '*',
      ]);

      const [jobs, equipmentSystems, technicians] = await Promise.all([
        prisma.job.findMany({
          where: {
            orgId,
            OR: [
              { status: { notIn: ['CLOSED', 'CANCELLED', 'CANCELED'] } },
              { updatedAt: { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) } },
            ],
          },
          include: {
            customer: true,
            assignedToUser: {
              select: { id: true, name: true, email: true },
            },
            appointments: {
              orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
              take: 3,
            },
            hvacDiagnosticSessions: {
              select: { id: true, status: true, updatedAt: true },
              orderBy: { updatedAt: 'desc' },
              take: 3,
            },
          },
          orderBy: [{ scheduledAt: 'desc' }, { updatedAt: 'desc' }],
          take: 80,
        }),
        prisma.hvacEquipmentSystem.findMany({
          where: { orgId },
          include: {
            customer: true,
            components: { orderBy: { createdAt: 'asc' } },
          },
          orderBy: { updatedAt: 'desc' },
          take: 100,
        }),
        prisma.user.findMany({
          where: { orgId, isActive: true, actorType: ActorType.HUMAN },
          select: { id: true, name: true, email: true, employeeCode: true },
          orderBy: { name: 'asc' },
        }),
      ]);

      res.json({
        actorUserId: access.user.id,
        jobs,
        equipmentSystems,
        technicians,
        measurementDefinitions: Object.values(HVAC_MEASUREMENT_DEFINITIONS),
      });
    } catch (error) {
      res.status(errorStatus(error)).json({ error: errorMessage(error) });
    }
  });

  app.get('/api/hvac/diagnostics', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      await requireAnyPermission(req, orgId, [
        'hvac:diagnostic:read',
        'hvac:diagnostic:write',
        '*',
      ]);
      const status = queryString(req.query.status);
      const jobId = queryString(req.query.jobId);
      const takeValue = Number(req.query.limit ?? 50);
      const take = Number.isFinite(takeValue) ? Math.min(Math.max(Math.round(takeValue), 1), 100) : 50;

      const sessions = await prisma.hvacDiagnosticSession.findMany({
        where: {
          orgId,
          ...(status && Object.values(HvacDiagnosticSessionStatus).includes(status as HvacDiagnosticSessionStatus)
            ? { status: status as HvacDiagnosticSessionStatus }
            : {}),
          ...(jobId ? { jobId } : {}),
        },
        include: {
          job: { include: { customer: true } },
          customer: true,
          technician: { select: { id: true, name: true, email: true } },
          equipmentSystem: {
            include: { components: { orderBy: { createdAt: 'asc' } } },
          },
          _count: {
            select: {
              measurements: true,
              findings: true,
              messages: true,
            },
          },
        },
        orderBy: { updatedAt: 'desc' },
        take,
      });

      res.json({ sessions });
    } catch (error) {
      res.status(errorStatus(error)).json({ error: errorMessage(error) });
    }
  });

  app.post('/api/hvac/diagnostics', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const access = await requireAnyPermission(req, orgId, [
        'hvac:diagnostic:write',
        '*',
      ]);
      const body = bodyObject(req.body);
      const { clientActionId, ...payload } = body;
      const result = await executeIdempotent({
        prisma,
        registry,
        orgId,
        actorUserId: access.user.id,
        toolName: 'hvac.diagnostic.session.create',
        payload,
        clientActionId: queryString(clientActionId),
        reason: 'Create HVAC diagnostic session linked to CRM',
      });

      res.status(executionStatusCode(result, 201)).json(result);
    } catch (error) {
      res.status(errorStatus(error)).json({ error: errorMessage(error) });
    }
  });

  app.get('/api/hvac/diagnostics/:id/report', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      await requireAnyPermission(req, orgId, [
        'hvac:diagnostic:read',
        'hvac:diagnostic:write',
        '*',
      ]);
      const sessionId = paramValue(req.params.id);
      const kind = queryString(req.query.kind)?.toUpperCase() === 'CUSTOMER'
        ? HvacDiagnosticReportKind.CUSTOMER
        : HvacDiagnosticReportKind.TECHNICAL;
      const format = queryString(req.query.format)?.toLowerCase() ?? 'html';

      const detail = await loadHvacDiagnosticSessionDetail(prisma, orgId, sessionId);
      if (!detail) {
        res.status(404).json({ error: 'HVAC diagnostic session not found' });
        return;
      }

      const stored = detail.reports.find((report) => report.kind === kind);
      let report: unknown = stored?.reportJson ?? null;
      if (!report) {
        const technical = await buildCurrentHvacReport(prisma, detail);
        report = kind === HvacDiagnosticReportKind.TECHNICAL
          ? technical
          : {
              ...technical,
              schemaVersion: 'hvac-customer-report-v1-preview',
              messages: [],
            };
      }

      if (format === 'json') {
        res.json({ kind, report, persisted: Boolean(stored) });
        return;
      }

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(renderHvacDiagnosticReportHtml(report, kind));
    } catch (error) {
      res.status(errorStatus(error)).json({ error: errorMessage(error) });
    }
  });

  app.get('/api/hvac/diagnostics/:id', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      await requireAnyPermission(req, orgId, [
        'hvac:diagnostic:read',
        'hvac:diagnostic:write',
        '*',
      ]);
      res.json(await detailPayload(prisma, orgId, paramValue(req.params.id)));
    } catch (error) {
      res.status(errorStatus(error)).json({ error: errorMessage(error) });
    }
  });

  app.patch('/api/hvac/diagnostics/:id', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const access = await requireAnyPermission(req, orgId, ['hvac:diagnostic:write', '*']);
      const body = bodyObject(req.body);
      const { clientActionId, ...changes } = body;
      const sessionId = paramValue(req.params.id);
      const result = await executeIdempotent({
        prisma,
        registry,
        orgId,
        actorUserId: access.user.id,
        toolName: 'hvac.diagnostic.session.update',
        payload: { ...changes, sessionId },
        clientActionId: queryString(clientActionId),
        reason: 'Update HVAC diagnostic session',
      });
      res.status(executionStatusCode(result, 200)).json(result);
    } catch (error) {
      res.status(errorStatus(error)).json({ error: errorMessage(error) });
    }
  });

  app.post('/api/hvac/diagnostics/:id/measurements', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const access = await requireAnyPermission(req, orgId, ['hvac:diagnostic:write', '*']);
      const body = bodyObject(req.body);
      const sessionId = paramValue(req.params.id);
      const clientActionId = queryString(body.clientActionId);
      const measurements = Array.isArray(body.measurements)
        ? body.measurements
        : body.measurement && typeof body.measurement === 'object'
          ? [body.measurement]
          : [];
      const result = await executeIdempotent({
        prisma,
        registry,
        orgId,
        actorUserId: access.user.id,
        toolName: 'hvac.diagnostic.measurement.record',
        payload: { sessionId, measurements },
        clientActionId,
        reason: 'Record structured HVAC diagnostic measurements',
      });
      res.status(executionStatusCode(result, 201)).json(result);
    } catch (error) {
      res.status(errorStatus(error)).json({ error: errorMessage(error) });
    }
  });

  app.post('/api/hvac/diagnostics/:id/messages', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const access = await requireAnyPermission(req, orgId, ['hvac:diagnostic:write', '*']);
      const body = bodyObject(req.body);
      const text = queryString(body.text);
      if (!text) {
        res.status(400).json({ error: 'Message text is required' });
        return;
      }
      const sessionId = paramValue(req.params.id);
      const clientActionId = queryString(body.clientActionId);

      const before = await loadHvacDiagnosticSessionDetail(prisma, orgId, sessionId);
      if (!before) {
        res.status(404).json({ error: 'HVAC diagnostic session not found' });
        return;
      }

      if (!before.complaintText) {
        await executeIdempotent({
          prisma,
          registry,
          orgId,
          actorUserId: access.user.id,
          toolName: 'hvac.diagnostic.session.update',
          payload: { sessionId, complaintText: text },
          clientActionId: clientActionId ? `${clientActionId}:complaint` : null,
          reason: 'Capture initial customer complaint from technician conversation',
        });
      }

      const technicianResult = await executeIdempotent({
        prisma,
        registry,
        orgId,
        actorUserId: access.user.id,
        toolName: 'hvac.diagnostic.message.add',
        payload: {
          sessionId,
          role: 'TECHNICIAN',
          text,
          structured: { source: 'PWA_CONVERSATION' },
        },
        clientActionId,
        reason: 'Record technician diagnostic conversation message',
      });
      if (technicianResult.status !== 'EXECUTED') {
        res.status(executionStatusCode(technicianResult, 201)).json(technicianResult);
        return;
      }

      const updated = await loadHvacDiagnosticSessionDetail(prisma, orgId, sessionId);
      if (!updated) {
        res.status(404).json({ error: 'HVAC diagnostic session not found after message' });
        return;
      }
      const snapshot = await buildHvacSnapshotFromDetail(prisma, updated);
      const findings = evaluateHvacDiagnosticSnapshot(snapshot, 'INITIAL');
      const nextStep = getHvacNextStep(snapshot, 'INITIAL');
      const deterministicFallback = buildDeterministicHvacAssistantReply(snapshot, 'INITIAL');
      const assistant = await generateHvacConversationalReply({
        snapshot,
        findings,
        nextStep,
        technicianMessage: text,
        deterministicFallback,
      });

      const assistantResult = await executeIdempotent({
        prisma,
        registry,
        orgId,
        actorUserId: access.user.id,
        toolName: 'hvac.diagnostic.message.add',
        payload: {
          sessionId,
          role: 'ASSISTANT',
          text: assistant.text,
          provider: assistant.provider,
          ...(assistant.model ? { providerModel: assistant.model } : {}),
          structured: {
            nextStep,
            findingCodes: findings.map((finding) => finding.code),
            fallbackReason: assistant.fallbackReason ?? null,
          },
        },
        clientActionId: clientActionId ? `${clientActionId}:assistant` : null,
        reason: 'Record governed HVAC conversational guidance',
      });

      res.status(executionStatusCode(assistantResult, 201)).json({
        technicianResult,
        assistantResult,
        assistant,
        ...(await detailPayload(prisma, orgId, sessionId)),
      });
    } catch (error) {
      res.status(errorStatus(error)).json({ error: errorMessage(error) });
    }
  });

  app.post('/api/hvac/diagnostics/:id/verifications', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const access = await requireAnyPermission(req, orgId, ['hvac:diagnostic:write', '*']);
      const body = bodyObject(req.body);
      const { clientActionId, ...payload } = body;
      const sessionId = paramValue(req.params.id);
      const result = await executeIdempotent({
        prisma,
        registry,
        orgId,
        actorUserId: access.user.id,
        toolName: 'hvac.diagnostic.verification.record',
        payload: { ...payload, sessionId },
        clientActionId: queryString(clientActionId),
        reason: 'Record HVAC verification test and technician confirmation',
      });
      res.status(executionStatusCode(result, 201)).json(result);
    } catch (error) {
      res.status(errorStatus(error)).json({ error: errorMessage(error) });
    }
  });

  app.post('/api/hvac/diagnostics/:id/finalize', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const access = await requireAnyPermission(req, orgId, [
        'hvac:diagnostic:finalize',
        '*',
      ]);
      const body = bodyObject(req.body);
      const { clientActionId, ...payload } = body;
      const sessionId = paramValue(req.params.id);
      const result = await executeIdempotent({
        prisma,
        registry,
        orgId,
        actorUserId: access.user.id,
        toolName: 'hvac.diagnostic.finalize',
        payload: { ...payload, sessionId, technicianConfirmed: true },
        clientActionId: queryString(clientActionId),
        reason: 'Technician confirmed HVAC diagnostic outcome and generated reports',
      });
      res.status(executionStatusCode(result, 200)).json(result);
    } catch (error) {
      res.status(errorStatus(error)).json({ error: errorMessage(error) });
    }
  });

  app.post('/api/hvac/nameplate/parse', nameplateUpload.single('image'), async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      await requireAnyPermission(req, orgId, ['hvac:diagnostic:write', '*']);
      if (!req.file) {
        res.status(400).json({ error: 'Nameplate image is required' });
        return;
      }
      const result = await extractHvacNameplate({
        imageBuffer: req.file.buffer,
        mimeType: req.file.mimetype,
      });
      res.json({ ...result, requiresTechnicianConfirmation: true });
    } catch (error) {
      const status = errorMessage(error).includes('unavailable until') ? 503 : errorStatus(error);
      res.status(status).json({ error: errorMessage(error) });
    }
  });

  app.get('/api/hvac/oem/references/lookup', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      await requireAnyPermission(req, orgId, ['hvac:oem:read', 'hvac:oem:manage', '*']);
      const manufacturer = queryString(req.query.manufacturer);
      const model = queryString(req.query.model);
      if (!manufacturer || !model) {
        res.status(400).json({ error: 'manufacturer and model are required' });
        return;
      }
      const references = await lookupHvacOemReferences(prisma, {
        orgId,
        manufacturer,
        model,
        equipmentComponentType: queryString(req.query.equipmentComponentType),
        operatingMode: queryString(req.query.operatingMode),
        refrigerant: queryString(req.query.refrigerant),
      });
      res.json({ references });
    } catch (error) {
      res.status(errorStatus(error)).json({ error: errorMessage(error) });
    }
  });

  app.post('/api/hvac/oem/references', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const access = await requireAnyPermission(req, orgId, ['hvac:oem:manage', '*']);
      const body = bodyObject(req.body);
      const { clientActionId, ...payload } = body;
      const result = await executeIdempotent({
        prisma,
        registry,
        orgId,
        actorUserId: access.user.id,
        toolName: 'hvac.oem.reference.upsert',
        payload,
        clientActionId: queryString(clientActionId),
        reason: 'Human-reviewed HVAC OEM document reference update',
      });
      res.status(executionStatusCode(result, 201)).json(result);
    } catch (error) {
      res.status(errorStatus(error)).json({ error: errorMessage(error) });
    }
  });
}
