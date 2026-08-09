import {
  ExecutionStatus,
  Prisma,
  PrismaClient,
  RiskLevel,
  SafetyMode,
} from '@prisma/client';

const RISK_ORDER: Record<RiskLevel, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

type JsonObject = Record<string, unknown>;

type PolicyEnvelope = {
  id?: string;
  policyJson: JsonObject;
};

export type DecisionOutcome = 'ALLOWED' | 'BLOCKED' | 'QUEUED_APPROVAL';

export type DecisionStage =
  | 'KILLSWITCH'
  | 'POLICY_BLOCKLIST'
  | 'TIME_WINDOW'
  | 'PER_RUN_LIMIT'
  | 'PER_TOOL_LIMIT'
  | 'FINANCIAL_EXPOSURE'
  | 'PRICING_GUARDRAIL'
  | 'PRICING_DISCOUNT_LIMIT'
  | 'AUTONOMY_GATE'
  | 'RBAC'
  | 'SCHEMA_VALIDATION';

export type PolicyDecision = {
  decision: DecisionOutcome;
  stage: DecisionStage;
  reason: string;
  details: Record<string, unknown>;
};

type TimeWindowContext = {
  index: number;
  name: string;
  timezone: string;
  days: string[];
  start: string;
  end: string;
  now: string;
};

type TimeWindowDenyRule = TimeWindowContext & {
  toolPattern: string;
  policyPath: string;
};

type WindowOverlay = {
  denyTools: string[];
  maxRiskLevelAutonomous?: RiskLevel;
  activeWindows: TimeWindowContext[];
  denyRules: TimeWindowDenyRule[];
};

type GuardResult = {
  blocked: boolean;
  reason?: string;
  decision?: PolicyDecision;
};

export type FinancialExposurePlan = {
  tool: string;
  bucket: string;
  amountCents: number;
  usedCents: number;
  projectedCents: number;
  limitCents: number;
  localDate: Date;
  timezone: string;
  requiredApprovals: number;
  breachNote: string;
};

export type FinancialExposureCheck =
  | { action: 'NONE' }
  | { action: 'ALLOW'; plan: FinancialExposurePlan }
  | {
      action: 'QUEUE_APPROVAL';
      plan: FinancialExposurePlan;
      reason: string;
      decision: PolicyDecision;
    };

const FALLBACK_POLICY_V1: JsonObject = {
  version: 1,
  autonomy: {
    enabled: true,
    defaultMode: 'SAFE',
    maxRiskLevelAutonomous: 'HIGH',
    toolBlocks: {
      deny: [],
      denyIfAutonomous: [],
      allowOnly: [],
    },
    timeWindows: [],
    rateLimits: {
      perRun: {
        maxToolCalls: 120,
        maxQueuedApprovals: 25,
        cooldownSecondsByRisk: {
          LOW: 0,
          MEDIUM: 5,
          HIGH: 30,
          CRITICAL: 999999,
        },
      },
      perTool: [],
    },
  },
  financial: {
    currency: 'USD',
    dailyExposure: {
      enabled: true,
      scope: 'ORG',
      resetsAt: '00:00',
      timezone: 'America/Denver',
      limits: {
        invoiceIssueCents: 250000,
        subscriptionCreateCents: 150000,
        discountTotalCents: 50000,
      },
      toolCostMap: [],
      onBreach: {
        mode: 'QUEUE_APPROVAL',
        requireApprovals: 2,
        note: 'Daily financial exposure exceeded',
      },
    },
  },
  approvals: {
    defaults: {
      MEDIUM: { requiredApprovals: 1, expiresMinutes: 120 },
      HIGH: { requiredApprovals: 2, expiresMinutes: 240 },
      CRITICAL: { requiredApprovals: 2, expiresMinutes: 60 },
    },
    escalation: {
      ifPendingMinutes: 60,
      notifyRoles: ['owner', 'dispatcher_manager'],
    },
  },
  killSwitch: {
    enabled: true,
    modes: {
      AUTONOMY_OFF: {
        blocksAutonomousExecution: true,
        stillAllowReadTools: true,
        stillAllowHumanExecution: true,
      },
      FULL_STOP: {
        blocksAutonomousExecution: true,
        stillAllowReadTools: false,
        stillAllowHumanExecution: true,
      },
    },
    currentMode: 'AUTONOMY_OFF',
  },
};

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' ? (value as JsonObject) : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function asRiskLevel(value: unknown): RiskLevel | undefined {
  if (
    value === RiskLevel.LOW ||
    value === RiskLevel.MEDIUM ||
    value === RiskLevel.HIGH ||
    value === RiskLevel.CRITICAL
  ) {
    return value;
  }
  return undefined;
}

function datePartsInTimezone(date: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);

  const pick = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '';

  const weekday = pick('weekday').toUpperCase().slice(0, 3);
  let hour = pick('hour').padStart(2, '0');
  // Some ICU timezone conversions can emit "24" at midnight boundaries.
  // Normalize to 00:xx so window comparisons remain deterministic.
  if (hour === '24') {
    hour = '00';
  }
  const minute = pick('minute').padStart(2, '0');

  return {
    weekday,
    hhmm: `${hour}:${minute}`,
  };
}

function localDateInTimezone(date: Date, timezone: string): Date {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const pick = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '';
  const year = pick('year');
  const month = pick('month');
  const day = pick('day');

  return new Date(`${year}-${month}-${day}T00:00:00.000Z`);
}

function isTimeWithinWindow(now: string, start: string, end: string): boolean {
  if (start <= end) {
    return now >= start && now < end;
  }

  return now >= start || now < end;
}

function strictestRisk(
  current: RiskLevel | undefined,
  incoming: RiskLevel | undefined,
): RiskLevel | undefined {
  if (!incoming) {
    return current;
  }
  if (!current) {
    return incoming;
  }

  return RISK_ORDER[incoming] < RISK_ORDER[current] ? incoming : current;
}

function makeDecision(
  stage: DecisionStage,
  reason: string,
  details: Record<string, unknown>,
  decision: DecisionOutcome = 'BLOCKED',
): PolicyDecision {
  return {
    decision,
    stage,
    reason,
    details,
  };
}

export async function loadActivePolicy(
  prisma: PrismaClient,
  orgId: string,
): Promise<PolicyEnvelope> {
  const policy = await prisma.policy.findFirst({
    where: {
      orgId,
      isActive: true,
    },
    orderBy: {
      version: 'desc',
    },
    select: {
      id: true,
      policyJson: true,
    },
  });

  if (!policy) {
    return {
      policyJson: FALLBACK_POLICY_V1,
    };
  }

  return {
    id: policy.id,
    policyJson: asObject(policy.policyJson),
  };
}

export function wildcardMatch(pattern: string, toolName: string): boolean {
  if (pattern === '*') {
    return true;
  }

  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(toolName);
}

export function isToolBlocked(
  policy: JsonObject,
  toolName: string,
  isAutonomous: boolean,
): GuardResult {
  const autonomy = asObject(policy.autonomy);
  const blocks = asObject(autonomy.toolBlocks);

  const deny = asStringArray(blocks.deny);
  const denyIfAutonomous = asStringArray(blocks.denyIfAutonomous);
  const allowOnly = asStringArray(blocks.allowOnly);

  if (allowOnly.length > 0 && !allowOnly.some((pattern) => wildcardMatch(pattern, toolName))) {
    const reason = `Policy allowOnly list excludes tool ${toolName}`;
    return {
      blocked: true,
      reason,
      decision: makeDecision('POLICY_BLOCKLIST', reason, {
        policyPath: 'autonomy.toolBlocks.allowOnly',
        toolName,
        isAutonomous,
        allowOnly,
      }),
    };
  }

  const denyPattern = deny.find((pattern) => wildcardMatch(pattern, toolName));
  if (denyPattern) {
    const reason = `Policy deny list blocks tool ${toolName}`;
    return {
      blocked: true,
      reason,
      decision: makeDecision('POLICY_BLOCKLIST', reason, {
        policyPath: 'autonomy.toolBlocks.deny',
        toolName,
        matchedPattern: denyPattern,
        isAutonomous,
      }),
    };
  }

  const denyAutonomousPattern =
    isAutonomous
      ? denyIfAutonomous.find((pattern) => wildcardMatch(pattern, toolName))
      : undefined;
  if (denyAutonomousPattern) {
    const reason = `Policy denyIfAutonomous list blocks autonomous tool ${toolName}`;
    return {
      blocked: true,
      reason,
      decision: makeDecision('POLICY_BLOCKLIST', reason, {
        policyPath: 'autonomy.toolBlocks.denyIfAutonomous',
        toolName,
        matchedPattern: denyAutonomousPattern,
        isAutonomous,
      }),
    };
  }

  return { blocked: false };
}

export function applyTimeWindowOverlay(
  policy: JsonObject,
  now = new Date(),
): WindowOverlay {
  const autonomy = asObject(policy.autonomy);
  const windows = Array.isArray(autonomy.timeWindows)
    ? autonomy.timeWindows
    : [];

  const overlay: WindowOverlay = {
    denyTools: [],
    maxRiskLevelAutonomous: asRiskLevel(autonomy.maxRiskLevelAutonomous),
    activeWindows: [],
    denyRules: [],
  };

  for (const [index, windowEntry] of windows.entries()) {
    const windowObject = asObject(windowEntry);
    const timezone =
      typeof windowObject.timezone === 'string'
        ? windowObject.timezone
        : 'America/Denver';
    const days = asStringArray(windowObject.days);
    const start =
      typeof windowObject.start === 'string' ? windowObject.start : '00:00';
    const end = typeof windowObject.end === 'string' ? windowObject.end : '23:59';

    const zoned = datePartsInTimezone(now, timezone);
    if (!days.includes(zoned.weekday)) {
      continue;
    }

    if (!isTimeWithinWindow(zoned.hhmm, start, end)) {
      continue;
    }

    const context: TimeWindowContext = {
      index,
      name:
        typeof windowObject.name === 'string'
          ? windowObject.name
          : `window-${index}`,
      timezone,
      days,
      start,
      end,
      now: zoned.hhmm,
    };
    overlay.activeWindows.push(context);

    const rules = asObject(windowObject.rules);
    const denyTools = asStringArray(rules.denyTools);
    for (const pattern of denyTools) {
      overlay.denyTools.push(pattern);
      overlay.denyRules.push({
        ...context,
        toolPattern: pattern,
        policyPath: `autonomy.timeWindows[${index}].rules.denyTools`,
      });
    }
    overlay.maxRiskLevelAutonomous = strictestRisk(
      overlay.maxRiskLevelAutonomous,
      asRiskLevel(rules.maxRiskLevelAutonomous),
    );
  }

  return {
    denyTools: [...new Set(overlay.denyTools)],
    maxRiskLevelAutonomous: overlay.maxRiskLevelAutonomous,
    activeWindows: overlay.activeWindows,
    denyRules: overlay.denyRules,
  };
}

export function checkTimeWindowToolBlock(
  overlay: WindowOverlay,
  toolName: string,
  isAutonomous: boolean,
): GuardResult {
  if (!isAutonomous) {
    return { blocked: false };
  }

  const matched = overlay.denyRules.find((rule) =>
    wildcardMatch(rule.toolPattern, toolName),
  );
  if (!matched) {
    return { blocked: false };
  }

  const reason = `Active time window ${matched.name} denies tool ${toolName}`;
  return {
    blocked: true,
    reason,
    decision: makeDecision('TIME_WINDOW', reason, {
      policyPath: matched.policyPath,
      toolName,
      isAutonomous,
      matchedPattern: matched.toolPattern,
      window: {
        name: matched.name,
        tz: matched.timezone,
        start: matched.start,
        end: matched.end,
        days: matched.days,
        now: matched.now,
      },
    }),
  };
}

export async function checkPerRunLimits(
  prisma: PrismaClient,
  policy: JsonObject,
  orgId: string,
  agentRunId?: string,
): Promise<GuardResult> {
  if (!agentRunId) {
    return { blocked: false };
  }

  const perRun = asObject(asObject(asObject(policy.autonomy).rateLimits).perRun);
  const maxToolCalls = Number(perRun.maxToolCalls ?? 0);
  const maxQueuedApprovals = Number(perRun.maxQueuedApprovals ?? 0);

  if (maxToolCalls > 0) {
    const callCount = await prisma.toolExecution.count({
      where: {
        orgId,
        agentRunId,
      },
    });

    if (callCount >= maxToolCalls) {
      const reason = `Policy per-run maxToolCalls exceeded (${maxToolCalls})`;
      return {
        blocked: true,
        reason,
        decision: makeDecision('PER_RUN_LIMIT', reason, {
          policyPath: 'autonomy.rateLimits.perRun.maxToolCalls',
          run: {
            agentRunId,
            maxToolCalls,
            current: callCount,
          },
        }),
      };
    }
  }

  if (maxQueuedApprovals > 0) {
    const queuedCount = await prisma.toolExecution.count({
      where: {
        orgId,
        agentRunId,
        status: ExecutionStatus.QUEUED_APPROVAL,
      },
    });

    if (queuedCount >= maxQueuedApprovals) {
      const reason = `Policy per-run maxQueuedApprovals exceeded (${maxQueuedApprovals})`;
      return {
        blocked: true,
        reason,
        decision: makeDecision('PER_RUN_LIMIT', reason, {
          policyPath: 'autonomy.rateLimits.perRun.maxQueuedApprovals',
          run: {
            agentRunId,
            maxQueuedApprovals,
            current: queuedCount,
          },
        }),
      };
    }
  }

  return { blocked: false };
}

export async function checkPerToolRateLimits(
  prisma: PrismaClient,
  policy: JsonObject,
  orgId: string,
  toolName: string,
  now = new Date(),
): Promise<GuardResult> {
  const autonomy = asObject(policy.autonomy);
  const rateLimits = asObject(autonomy.rateLimits);
  const perTool = Array.isArray(rateLimits.perTool) ? rateLimits.perTool : [];

  const matchingLimits = perTool
    .map((entry) => asObject(entry))
    .filter((entry) => {
      const toolPattern = typeof entry.tool === 'string' ? entry.tool : '';
      return toolPattern.length > 0 && wildcardMatch(toolPattern, toolName);
    });

  if (matchingLimits.length === 0) {
    return { blocked: false };
  }

  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  for (const limit of matchingLimits) {
    const maxPerHour = Number(limit.maxPerHour ?? 0);
    const maxPerDay = Number(limit.maxPerDay ?? 0);

    if (maxPerHour > 0) {
      const hourlyCount = await prisma.toolExecution.count({
        where: {
          orgId,
          createdAt: { gte: hourAgo },
          toolDefinition: {
            name: toolName,
          },
          status: {
            in: [ExecutionStatus.EXECUTED, ExecutionStatus.QUEUED_APPROVAL],
          },
        },
      });

      if (hourlyCount >= maxPerHour) {
        const reason = `Policy per-tool hourly limit reached for ${toolName} (${maxPerHour})`;
        return {
          blocked: true,
          reason,
          decision: makeDecision('PER_TOOL_LIMIT', reason, {
            policyPath: 'autonomy.rateLimits.perTool[].maxPerHour',
            toolName,
            rate: {
              maxPerHour,
              countLastHour: hourlyCount,
            },
          }),
        };
      }
    }

    if (maxPerDay > 0) {
      const dailyCount = await prisma.toolExecution.count({
        where: {
          orgId,
          createdAt: { gte: dayAgo },
          toolDefinition: {
            name: toolName,
          },
          status: {
            in: [ExecutionStatus.EXECUTED, ExecutionStatus.QUEUED_APPROVAL],
          },
        },
      });

      if (dailyCount >= maxPerDay) {
        const reason = `Policy per-tool daily limit reached for ${toolName} (${maxPerDay})`;
        return {
          blocked: true,
          reason,
          decision: makeDecision('PER_TOOL_LIMIT', reason, {
            policyPath: 'autonomy.rateLimits.perTool[].maxPerDay',
            toolName,
            rate: {
              maxPerDay,
              countLastDay: dailyCount,
            },
          }),
        };
      }
    }
  }

  return { blocked: false };
}

export function checkMaxRiskLevelAutonomous(
  policy: JsonObject,
  riskLevel: RiskLevel,
  isAutonomous: boolean,
  overrideMaxRisk?: RiskLevel,
): GuardResult {
  if (!isAutonomous) {
    return { blocked: false };
  }

  const autonomy = asObject(policy.autonomy);
  const configured = overrideMaxRisk ?? asRiskLevel(autonomy.maxRiskLevelAutonomous);
  const maxRisk = configured ?? RiskLevel.HIGH;

  if (RISK_ORDER[riskLevel] > RISK_ORDER[maxRisk]) {
    const reason = `Policy maxRiskLevelAutonomous=${maxRisk} blocks ${riskLevel} autonomous tool`;
    return {
      blocked: true,
      reason,
      decision: makeDecision('AUTONOMY_GATE', reason, {
        policyPath: overrideMaxRisk
          ? 'autonomy.timeWindows[].rules.maxRiskLevelAutonomous'
          : 'autonomy.maxRiskLevelAutonomous',
        maxRiskLevelAutonomous: maxRisk,
        toolRiskLevel: riskLevel,
        isAutonomous,
      }),
    };
  }

  return { blocked: false };
}

export function evaluateKillSwitch(input: {
  mode?: SafetyMode;
  isAutonomous: boolean;
  isReadTool: boolean;
}): GuardResult {
  const mode = input.mode ?? SafetyMode.NORMAL;

  if (!input.isAutonomous || mode === SafetyMode.NORMAL) {
    return { blocked: false };
  }

  if (mode === SafetyMode.FULL_STOP) {
    const reason = 'Kill switch FULL_STOP blocks all autonomous execution';
    return {
      blocked: true,
      reason,
      decision: makeDecision('KILLSWITCH', reason, {
        policyPath: 'killSwitch.modes.FULL_STOP.blocksAutonomousExecution',
        mode,
        isAutonomous: input.isAutonomous,
        isReadTool: input.isReadTool,
      }),
    };
  }

  if (mode === SafetyMode.AUTONOMY_OFF && !input.isReadTool) {
    const reason = 'Kill switch AUTONOMY_OFF blocks autonomous non-read tools';
    return {
      blocked: true,
      reason,
      decision: makeDecision('KILLSWITCH', reason, {
        policyPath: 'killSwitch.modes.AUTONOMY_OFF.blocksAutonomousExecution',
        mode,
        isAutonomous: input.isAutonomous,
        isReadTool: input.isReadTool,
      }),
    };
  }

  return { blocked: false };
}

export function isReadOnlyTool(toolName: string, riskLevel: RiskLevel): boolean {
  if (riskLevel !== RiskLevel.LOW) {
    return false;
  }

  return (
    toolName.includes('.get') ||
    toolName.includes('.list') ||
    toolName.includes('.read') ||
    toolName.startsWith('reporting.')
  );
}

export async function checkFinancialExposurePolicy(
  prisma: PrismaClient,
  policy: JsonObject,
  orgId: string,
  toolName: string,
  payload: Record<string, unknown>,
  now = new Date(),
): Promise<FinancialExposureCheck> {
  const financial = asObject(policy.financial);
  const dailyExposure = asObject(financial.dailyExposure);
  const enabled = dailyExposure.enabled !== false;
  if (!enabled) {
    return { action: 'NONE' };
  }

  const toolCostMap = Array.isArray(dailyExposure.toolCostMap)
    ? dailyExposure.toolCostMap
    : [];
  const matchingEntry = toolCostMap
    .map((entry) => asObject(entry))
    .find((entry) => {
      const pattern = typeof entry.tool === 'string' ? entry.tool : '';
      return pattern.length > 0 && wildcardMatch(pattern, toolName);
    });

  if (!matchingEntry) {
    return { action: 'NONE' };
  }

  const amountField =
    typeof matchingEntry.amountField === 'string'
      ? matchingEntry.amountField
      : '';
  const bucket =
    typeof matchingEntry.bucket === 'string' ? matchingEntry.bucket : '';
  if (!amountField || !bucket) {
    return { action: 'NONE' };
  }

  let amountCents = Number(payload[amountField]);
  if (!Number.isFinite(amountCents)) {
    amountCents = Number(payload.amountCents ?? payload.totalCents);
  }

  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    if (toolName === 'billing.invoice.issue' && typeof payload.invoiceId === 'string') {
      const invoice = await prisma.invoice.findFirst({
        where: { id: payload.invoiceId, orgId },
        select: { amountCents: true },
      });
      amountCents = Number(invoice?.amountCents ?? 0);
    }
  }

  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    const reason = 'Daily financial exposure amount missing or invalid';
    return {
      action: 'QUEUE_APPROVAL',
      plan: {
        tool: toolName,
        bucket,
        amountCents: 0,
        usedCents: 0,
        projectedCents: 0,
        limitCents: 0,
        localDate: localDateInTimezone(
          now,
          typeof dailyExposure.timezone === 'string'
            ? dailyExposure.timezone
            : 'America/Denver',
        ),
        timezone:
          typeof dailyExposure.timezone === 'string'
            ? dailyExposure.timezone
            : 'America/Denver',
        requiredApprovals: 2,
        breachNote:
          'Daily financial exposure amount could not be derived from payload',
      },
      reason,
      decision: makeDecision('FINANCIAL_EXPOSURE', reason, {
        policyPath: 'financial.dailyExposure.toolCostMap',
        toolName,
        details: {
          bucket,
          amountField,
        },
      }, 'QUEUED_APPROVAL'),
    };
  }

  const timezone =
    typeof dailyExposure.timezone === 'string'
      ? dailyExposure.timezone
      : 'America/Denver';
  const localDate = localDateInTimezone(now, timezone);
  const exposureRow = await prisma.financialExposureDaily.findUnique({
    where: {
      orgId_date_bucket: {
        orgId,
        date: localDate,
        bucket,
      },
    },
    select: {
      usedCents: true,
    },
  });

  const usedCents = exposureRow?.usedCents ?? 0;
  const projectedCents = usedCents + amountCents;
  const limits = asObject(dailyExposure.limits);
  const limitCents = Number(limits[bucket] ?? 0);
  const onBreach = asObject(dailyExposure.onBreach);
  const requiredApprovals = Number(onBreach.requireApprovals ?? 2);
  const breachNote =
    typeof onBreach.note === 'string'
      ? onBreach.note
      : 'Daily financial exposure exceeded';

  const plan: FinancialExposurePlan = {
    tool: toolName,
    bucket,
    amountCents,
    usedCents,
    projectedCents,
    limitCents,
    localDate,
    timezone,
    requiredApprovals,
    breachNote,
  };

  if (limitCents > 0 && projectedCents > limitCents) {
    const reason = `${breachNote}. bucket=${bucket} used=${usedCents} amount=${amountCents} projected=${projectedCents} limit=${limitCents}`;
    return {
      action: 'QUEUE_APPROVAL',
      plan,
      reason,
      decision: makeDecision(
        'FINANCIAL_EXPOSURE',
        reason,
        {
          policyPath: `financial.dailyExposure.limits.${bucket}`,
          toolName,
          limits: {
            bucket,
            limit: limitCents,
            used: usedCents,
            requested: amountCents,
            projected: projectedCents,
          },
          timezone,
          localDate: localDate.toISOString(),
        },
        'QUEUED_APPROVAL',
      ),
    };
  }

  return {
    action: 'ALLOW',
    plan,
  };
}

export function toInputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}
