import {
  ApprovalStatus,
  ExecutionStatus,
  Prisma,
  PrismaClient,
  SafetyMode,
  ToolDefinition,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { ValidateFunction } from 'ajv';
import semver from 'semver';

import { enqueueOutbox } from '@rcs/event-bus';

import { decideAutonomy } from './autonomy.js';
import { createHandlerMap } from './handlers.js';
import { hasAllRequiredPermissions } from './rbac.js';
import {
  applyTimeWindowOverlay,
  checkTimeWindowToolBlock,
  checkFinancialExposurePolicy,
  checkMaxRiskLevelAutonomous,
  checkPerRunLimits,
  checkPerToolRateLimits,
  evaluateKillSwitch,
  FinancialExposurePlan,
  isReadOnlyTool,
  isToolBlocked,
  loadActivePolicy,
  PolicyDecision,
  toInputJson,
} from './policy/engine.js';
import {
  ExecutionContext,
  HandlerMap,
  ToolExecutionError,
  ToolExecutionResponse,
} from './types.js';

const require = createRequire(import.meta.url);
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

type RequestPayloadEnvelope = {
  toolName: string;
  payload: Record<string, unknown>;
  context: ExecutionContext;
};

type ToolExplainResponse = {
  status: 'ALLOWED' | 'BLOCKED' | 'QUEUED_APPROVAL';
  decision: PolicyDecision;
  requiredApprovals?: number;
  policyId?: string;
  tool: {
    id: string;
    name: string;
    version: string;
    riskLevel: ToolDefinition['riskLevel'];
    autonomyLevel: ToolDefinition['autonomyLevel'];
  };
};

function decisionEnvelope(decision: PolicyDecision): Prisma.InputJsonValue {
  return toInputJson({ decision });
}

type HandlerGovernanceDirective = {
  status: 'BLOCKED' | 'QUEUED_APPROVAL';
  reason: string;
  requiredApprovals?: number;
  decision?: PolicyDecision;
  approvalPayload?: Record<string, unknown>;
  output?: Prisma.JsonValue;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseHandlerGovernanceDirective(
  output: Prisma.JsonValue,
): HandlerGovernanceDirective | null {
  const object = asRecord(output);
  if (!object) {
    return null;
  }

  const rawDirective = asRecord(object.__registryDecision);
  if (!rawDirective) {
    return null;
  }

  const status =
    rawDirective.status === 'QUEUED_APPROVAL'
      ? 'QUEUED_APPROVAL'
      : rawDirective.status === 'BLOCKED'
        ? 'BLOCKED'
        : null;
  if (!status) {
    return null;
  }

  const reason =
    typeof rawDirective.reason === 'string' && rawDirective.reason.trim().length > 0
      ? rawDirective.reason.trim()
      : status === 'BLOCKED'
        ? 'Execution blocked by handler governance directive'
        : 'Execution queued for approval by handler governance directive';
  const requiredApprovals =
    typeof rawDirective.requiredApprovals === 'number' &&
    Number.isFinite(rawDirective.requiredApprovals) &&
    rawDirective.requiredApprovals > 0
      ? Math.round(rawDirective.requiredApprovals)
      : undefined;
  const approvalPayload = asRecord(rawDirective.approvalPayload) ?? undefined;
  const outputPayload =
    object.output !== undefined ? (object.output as Prisma.JsonValue) : undefined;
  const decision = asRecord(rawDirective.decision) as PolicyDecision | undefined;

  return {
    status,
    reason,
    requiredApprovals,
    approvalPayload,
    output: outputPayload,
    decision,
  };
}

function normalizeExecutionError(error: unknown): {
  message: string;
  code?: string;
  recoverable?: boolean;
} {
  if (error instanceof ToolExecutionError) {
    return {
      message: error.message,
      code: error.code,
      recoverable: error.recoverable,
    };
  }
  if (error instanceof Error) {
    return { message: error.message };
  }
  return { message: 'Unknown handler error' };
}

export class ToolRegistry {
  private readonly ajv: {
    compile: (schema: object) => ValidateFunction;
    errorsText: (errors: ValidateFunction['errors']) => string;
  };

  private readonly validationCache = new Map<string, ValidateFunction>();

  private readonly handlers: HandlerMap;

  constructor(
    private readonly prisma: PrismaClient,
    handlers?: HandlerMap,
  ) {
    this.ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(this.ajv);
    this.handlers = handlers ?? createHandlerMap(prisma);
  }

  async execute(
    toolName: string,
    payload: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<ToolExecutionResponse> {
    context = {
      ...context,
      correlationId:
        context.correlationId ??
        context.clientActionId ??
        context.agentRunId ??
        randomUUID(),
    };

    const tool = await this.resolveToolDefinition(toolName, context.orgId, context.version);
    if (!tool) {
      throw new Error(`Tool not found: ${toolName}`);
    }

    const safetyState = await this.prisma.orgSafetyState.findUnique({
      where: { orgId: context.orgId },
      select: { mode: true },
    });

    const killSwitchCheck = evaluateKillSwitch({
      mode: safetyState?.mode ?? SafetyMode.NORMAL,
      isAutonomous: context.isAutonomous,
      isReadTool: isReadOnlyTool(tool.name, tool.riskLevel),
    });
    if (killSwitchCheck.blocked) {
      return this.writeBlockedExecution({
        context,
        tool,
        payload,
        reason: killSwitchCheck.reason ?? 'Kill switch blocked execution',
        decision: killSwitchCheck.decision,
      });
    }

    const activePolicy = await loadActivePolicy(this.prisma, context.orgId);
    const effectiveContext: ExecutionContext = {
      ...context,
      policyId: context.policyId ?? activePolicy.id,
    };

    const policyBlock = isToolBlocked(
      activePolicy.policyJson,
      tool.name,
      context.isAutonomous && context.actorType !== 'HUMAN',
    );
    if (policyBlock.blocked) {
      return this.writeBlockedExecution({
        context: effectiveContext,
        tool,
        payload,
        reason: policyBlock.reason ?? 'Policy blocked tool',
        decision: policyBlock.decision,
      });
    }

    const windowOverlay = applyTimeWindowOverlay(activePolicy.policyJson, new Date());
    const timeWindowCheck = checkTimeWindowToolBlock(
      windowOverlay,
      tool.name,
      context.isAutonomous,
    );
    if (timeWindowCheck.blocked) {
      return this.writeBlockedExecution({
        context: effectiveContext,
        tool,
        payload,
        reason: timeWindowCheck.reason ?? `Active policy time window denies tool ${tool.name}`,
        decision: timeWindowCheck.decision,
      });
    }

    const perRunLimit = await checkPerRunLimits(
      this.prisma,
      activePolicy.policyJson,
      context.orgId,
      context.agentRunId,
    );
    if (perRunLimit.blocked) {
      return this.writeBlockedExecution({
        context: effectiveContext,
        tool,
        payload,
        reason: perRunLimit.reason ?? 'Policy per-run limit reached',
        decision: perRunLimit.decision,
      });
    }

    const perToolRateLimit = await checkPerToolRateLimits(
      this.prisma,
      activePolicy.policyJson,
      context.orgId,
      tool.name,
      new Date(),
    );
    if (perToolRateLimit.blocked) {
      return this.writeBlockedExecution({
        context: effectiveContext,
        tool,
        payload,
        reason: perToolRateLimit.reason ?? 'Policy per-tool rate limit reached',
        decision: perToolRateLimit.decision,
      });
    }

    let financialExposurePlan: FinancialExposurePlan | undefined;
    const financialCheck = await checkFinancialExposurePolicy(
      this.prisma,
      activePolicy.policyJson,
      context.orgId,
      tool.name,
      payload,
      new Date(),
    );
    if (financialCheck.action === 'QUEUE_APPROVAL') {
      return this.queueFinancialExposureApproval({
        context: effectiveContext,
        tool,
        payload,
        plan: financialCheck.plan,
        reason: financialCheck.reason,
        decision: financialCheck.decision,
      });
    }
    if (financialCheck.action === 'ALLOW') {
      financialExposurePlan = financialCheck.plan;
    }

    const riskCapCheck = checkMaxRiskLevelAutonomous(
      activePolicy.policyJson,
      tool.riskLevel,
      context.isAutonomous,
      windowOverlay.maxRiskLevelAutonomous,
    );
    if (riskCapCheck.blocked) {
      return this.writeBlockedExecution({
        context: effectiveContext,
        tool,
        payload,
        reason: riskCapCheck.reason ?? 'Policy max risk level blocked execution',
        decision: riskCapCheck.decision,
      });
    }

    const actorPermissions = await this.getActorPermissions(context);
    if (!hasAllRequiredPermissions(actorPermissions, tool.requiredPermissions)) {
      const reason = 'RBAC denied: actor missing required permission(s)';
      return this.writeBlockedExecution({
        context: effectiveContext,
        tool,
        payload,
        reason,
        decision: {
          decision: 'BLOCKED',
          stage: 'RBAC',
          reason,
          details: {
            toolName: tool.name,
            requiredPermissions: tool.requiredPermissions,
            actorPermissions,
            policyPath: 'toolDefinition.requiredPermissions',
          },
        },
      });
    }

    const validation = this.getValidator(tool);
    const valid = validation(payload);
    if (!valid) {
      const reason = `JSON schema validation failed: ${this.ajv.errorsText(validation.errors)}`;
      return this.writeBlockedExecution({
        context: effectiveContext,
        tool,
        payload,
        reason,
        decision: {
          decision: 'BLOCKED',
          stage: 'SCHEMA_VALIDATION',
          reason,
          details: {
            toolName: tool.name,
            policyPath: 'toolDefinition.inputSchema',
            schemaErrors: validation.errors ?? [],
          },
        },
      });
    }

    const autonomy = decideAutonomy({
      actorType: context.actorType,
      isAutonomous: context.isAutonomous,
      riskLevel: tool.riskLevel,
      autonomyLevel: tool.autonomyLevel,
      endpointAllowsHumanOverride:
        context.endpointAllowsCritical ?? tool.endpointAllowsHumanOverride,
    });

    if (autonomy.action === 'BLOCK') {
      return this.writeBlockedExecution({
        context: effectiveContext,
        tool,
        payload,
        reason: autonomy.reason,
        decision: {
          decision: 'BLOCKED',
          stage: 'AUTONOMY_GATE',
          reason: autonomy.reason,
          details: {
            toolName: tool.name,
            policyPath: 'toolDefinition.autonomyLevel',
            actorType: context.actorType,
            isAutonomous: context.isAutonomous,
            riskLevel: tool.riskLevel,
            autonomyLevel: tool.autonomyLevel,
          },
        },
      });
    }

    if (tool.requiresReason && !context.reason?.trim()) {
      const reason = 'Tool requires execution reason';
      return this.writeBlockedExecution({
        context: effectiveContext,
        tool,
        payload,
        reason,
        decision: {
          decision: 'BLOCKED',
          stage: 'AUTONOMY_GATE',
          reason,
          details: {
            toolName: tool.name,
            policyPath: 'toolDefinition.requiresReason',
          },
        },
      });
    }

    if (context.agentRunId && tool.maxCallsPerRun) {
      const callsInRun = await this.prisma.toolExecution.count({
        where: {
          orgId: context.orgId,
          toolDefinitionId: tool.id,
          agentRunId: context.agentRunId,
          status: {
            in: [
              ExecutionStatus.EXECUTED,
              ExecutionStatus.QUEUED_APPROVAL,
              ExecutionStatus.FAILED,
            ],
          },
        },
      });

      if (callsInRun >= tool.maxCallsPerRun) {
        const reason = `maxCallsPerRun exceeded (${tool.maxCallsPerRun})`;
        return this.writeBlockedExecution({
          context: effectiveContext,
          tool,
          payload,
          reason,
          decision: {
            decision: 'BLOCKED',
            stage: 'PER_RUN_LIMIT',
            reason,
            details: {
              toolName: tool.name,
              policyPath: 'toolDefinition.maxCallsPerRun',
              run: {
                agentRunId: context.agentRunId,
                limit: tool.maxCallsPerRun,
                current: callsInRun,
              },
            },
          },
        });
      }
    }

    if (context.agentRunId && tool.cooldownSeconds) {
      const recentExecution = await this.prisma.toolExecution.findFirst({
        where: {
          orgId: context.orgId,
          toolDefinitionId: tool.id,
          agentRunId: context.agentRunId,
          status: ExecutionStatus.EXECUTED,
        },
        orderBy: { createdAt: 'desc' },
      });

      if (recentExecution) {
        const elapsedSeconds =
          (Date.now() - new Date(recentExecution.createdAt).getTime()) / 1000;
        if (elapsedSeconds < tool.cooldownSeconds) {
          const reason = `cooldownSeconds not elapsed (${tool.cooldownSeconds})`;
          return this.writeBlockedExecution({
            context: effectiveContext,
            tool,
            payload,
            reason,
            decision: {
              decision: 'BLOCKED',
              stage: 'PER_RUN_LIMIT',
              reason,
              details: {
                toolName: tool.name,
                policyPath: 'toolDefinition.cooldownSeconds',
                run: {
                  agentRunId: context.agentRunId,
                  cooldownSeconds: tool.cooldownSeconds,
                  elapsedSeconds,
                },
              },
            },
          });
        }
      }
    }

    if (autonomy.action === 'QUEUE_APPROVAL') {
      const queueReason = `Autonomy gate requires ${autonomy.requiredApprovals} approval(s)`;
      return this.queueApproval({
        context: effectiveContext,
        tool,
        payload,
        requiredApprovals: autonomy.requiredApprovals,
        decision: {
          decision: 'QUEUED_APPROVAL',
          stage: 'AUTONOMY_GATE',
          reason: queueReason,
          details: {
            toolName: tool.name,
            policyPath: 'toolDefinition.autonomyLevel',
            autonomyLevel: tool.autonomyLevel,
            riskLevel: tool.riskLevel,
            requiredApprovals: autonomy.requiredApprovals,
          },
        },
      });
    }

    return this.executeNow({
      context: effectiveContext,
      tool,
      payload,
      financialExposurePlan,
    });
  }

  async explain(
    toolName: string,
    payload: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<ToolExplainResponse> {
    const tool = await this.resolveToolDefinition(
      toolName,
      context.orgId,
      context.version,
    );
    if (!tool) {
      throw new Error(`Tool not found: ${toolName}`);
    }

    const toolSummary: ToolExplainResponse['tool'] = {
      id: tool.id,
      name: tool.name,
      version: tool.version,
      riskLevel: tool.riskLevel,
      autonomyLevel: tool.autonomyLevel,
    };

    const safetyState = await this.prisma.orgSafetyState.findUnique({
      where: { orgId: context.orgId },
      select: { mode: true },
    });

    const killSwitchCheck = evaluateKillSwitch({
      mode: safetyState?.mode ?? SafetyMode.NORMAL,
      isAutonomous: context.isAutonomous,
      isReadTool: isReadOnlyTool(tool.name, tool.riskLevel),
    });
    if (killSwitchCheck.blocked) {
      return {
        status: 'BLOCKED',
        decision:
          killSwitchCheck.decision ?? {
            decision: 'BLOCKED',
            stage: 'KILLSWITCH',
            reason:
              killSwitchCheck.reason ?? 'Kill switch blocked execution',
            details: {
              policyPath: 'killSwitch.modes',
              toolName: tool.name,
              isAutonomous: context.isAutonomous,
            },
          },
        policyId: context.policyId,
        tool: toolSummary,
      };
    }

    const activePolicy = await loadActivePolicy(this.prisma, context.orgId);
    const effectiveContext: ExecutionContext = {
      ...context,
      policyId: context.policyId ?? activePolicy.id,
    };

    const policyBlock = isToolBlocked(
      activePolicy.policyJson,
      tool.name,
      context.isAutonomous && context.actorType !== 'HUMAN',
    );
    if (policyBlock.blocked) {
      return {
        status: 'BLOCKED',
        decision:
          policyBlock.decision ?? {
            decision: 'BLOCKED',
            stage: 'POLICY_BLOCKLIST',
            reason: policyBlock.reason ?? 'Policy blocked tool',
            details: {
              policyPath: 'autonomy.toolBlocks',
              toolName: tool.name,
              isAutonomous:
                context.isAutonomous && context.actorType !== 'HUMAN',
            },
          },
        policyId: effectiveContext.policyId,
        tool: toolSummary,
      };
    }

    const windowOverlay = applyTimeWindowOverlay(activePolicy.policyJson, new Date());
    const timeWindowCheck = checkTimeWindowToolBlock(
      windowOverlay,
      tool.name,
      context.isAutonomous,
    );
    if (timeWindowCheck.blocked) {
      return {
        status: 'BLOCKED',
        decision:
          timeWindowCheck.decision ?? {
            decision: 'BLOCKED',
            stage: 'TIME_WINDOW',
            reason:
              timeWindowCheck.reason ??
              `Active policy time window denies tool ${tool.name}`,
            details: {
              policyPath: 'autonomy.timeWindows',
              toolName: tool.name,
              isAutonomous: context.isAutonomous,
            },
          },
        policyId: effectiveContext.policyId,
        tool: toolSummary,
      };
    }

    const perRunLimit = await checkPerRunLimits(
      this.prisma,
      activePolicy.policyJson,
      context.orgId,
      context.agentRunId,
    );
    if (perRunLimit.blocked) {
      return {
        status: 'BLOCKED',
        decision:
          perRunLimit.decision ?? {
            decision: 'BLOCKED',
            stage: 'PER_RUN_LIMIT',
            reason: perRunLimit.reason ?? 'Policy per-run limit reached',
            details: {
              policyPath: 'autonomy.rateLimits.perRun',
              toolName: tool.name,
              agentRunId: context.agentRunId,
            },
          },
        policyId: effectiveContext.policyId,
        tool: toolSummary,
      };
    }

    const perToolRateLimit = await checkPerToolRateLimits(
      this.prisma,
      activePolicy.policyJson,
      context.orgId,
      tool.name,
      new Date(),
    );
    if (perToolRateLimit.blocked) {
      return {
        status: 'BLOCKED',
        decision:
          perToolRateLimit.decision ?? {
            decision: 'BLOCKED',
            stage: 'PER_TOOL_LIMIT',
            reason:
              perToolRateLimit.reason ?? 'Policy per-tool rate limit reached',
            details: {
              policyPath: 'autonomy.rateLimits.perTool',
              toolName: tool.name,
            },
          },
        policyId: effectiveContext.policyId,
        tool: toolSummary,
      };
    }

    const financialCheck = await checkFinancialExposurePolicy(
      this.prisma,
      activePolicy.policyJson,
      context.orgId,
      tool.name,
      payload,
      new Date(),
    );
    if (financialCheck.action === 'QUEUE_APPROVAL') {
      return {
        status: 'QUEUED_APPROVAL',
        requiredApprovals: financialCheck.plan.requiredApprovals,
        decision:
          financialCheck.decision ?? {
            decision: 'QUEUED_APPROVAL',
            stage: 'FINANCIAL_EXPOSURE',
            reason: financialCheck.reason,
            details: {
              policyPath: 'financial.dailyExposure',
              toolName: tool.name,
            },
          },
        policyId: effectiveContext.policyId,
        tool: toolSummary,
      };
    }

    const riskCapCheck = checkMaxRiskLevelAutonomous(
      activePolicy.policyJson,
      tool.riskLevel,
      context.isAutonomous,
      windowOverlay.maxRiskLevelAutonomous,
    );
    if (riskCapCheck.blocked) {
      return {
        status: 'BLOCKED',
        decision:
          riskCapCheck.decision ?? {
            decision: 'BLOCKED',
            stage: 'AUTONOMY_GATE',
            reason:
              riskCapCheck.reason ??
              'Policy max risk level blocked execution',
            details: {
              policyPath: 'autonomy.maxRiskLevelAutonomous',
              toolName: tool.name,
            },
          },
        policyId: effectiveContext.policyId,
        tool: toolSummary,
      };
    }

    const actorPermissions = await this.getActorPermissions(context);
    if (!hasAllRequiredPermissions(actorPermissions, tool.requiredPermissions)) {
      return {
        status: 'BLOCKED',
        decision: {
          decision: 'BLOCKED',
          stage: 'RBAC',
          reason: 'RBAC denied: actor missing required permission(s)',
          details: {
            policyPath: 'toolDefinition.requiredPermissions',
            toolName: tool.name,
            requiredPermissions: tool.requiredPermissions,
            actorPermissions,
          },
        },
        policyId: effectiveContext.policyId,
        tool: toolSummary,
      };
    }

    const validation = this.getValidator(tool);
    const valid = validation(payload);
    if (!valid) {
      return {
        status: 'BLOCKED',
        decision: {
          decision: 'BLOCKED',
          stage: 'SCHEMA_VALIDATION',
          reason: `JSON schema validation failed: ${this.ajv.errorsText(validation.errors)}`,
          details: {
            policyPath: 'toolDefinition.inputSchema',
            toolName: tool.name,
            schemaErrors: validation.errors ?? [],
          },
        },
        policyId: effectiveContext.policyId,
        tool: toolSummary,
      };
    }

    const autonomy = decideAutonomy({
      actorType: context.actorType,
      isAutonomous: context.isAutonomous,
      riskLevel: tool.riskLevel,
      autonomyLevel: tool.autonomyLevel,
      endpointAllowsHumanOverride:
        context.endpointAllowsCritical ?? tool.endpointAllowsHumanOverride,
    });
    if (autonomy.action === 'BLOCK') {
      return {
        status: 'BLOCKED',
        decision: {
          decision: 'BLOCKED',
          stage: 'AUTONOMY_GATE',
          reason: autonomy.reason,
          details: {
            policyPath: 'toolDefinition.autonomyLevel',
            toolName: tool.name,
            actorType: context.actorType,
            isAutonomous: context.isAutonomous,
            riskLevel: tool.riskLevel,
            autonomyLevel: tool.autonomyLevel,
          },
        },
        policyId: effectiveContext.policyId,
        tool: toolSummary,
      };
    }

    if (tool.requiresReason && !context.reason?.trim()) {
      return {
        status: 'BLOCKED',
        decision: {
          decision: 'BLOCKED',
          stage: 'AUTONOMY_GATE',
          reason: 'Tool requires execution reason',
          details: {
            policyPath: 'toolDefinition.requiresReason',
            toolName: tool.name,
          },
        },
        policyId: effectiveContext.policyId,
        tool: toolSummary,
      };
    }

    if (context.agentRunId && tool.maxCallsPerRun) {
      const callsInRun = await this.prisma.toolExecution.count({
        where: {
          orgId: context.orgId,
          toolDefinitionId: tool.id,
          agentRunId: context.agentRunId,
          status: {
            in: [
              ExecutionStatus.EXECUTED,
              ExecutionStatus.QUEUED_APPROVAL,
              ExecutionStatus.FAILED,
            ],
          },
        },
      });

      if (callsInRun >= tool.maxCallsPerRun) {
        return {
          status: 'BLOCKED',
          decision: {
            decision: 'BLOCKED',
            stage: 'PER_RUN_LIMIT',
            reason: `maxCallsPerRun exceeded (${tool.maxCallsPerRun})`,
            details: {
              policyPath: 'toolDefinition.maxCallsPerRun',
              toolName: tool.name,
              run: {
                agentRunId: context.agentRunId,
                limit: tool.maxCallsPerRun,
                current: callsInRun,
              },
            },
          },
          policyId: effectiveContext.policyId,
          tool: toolSummary,
        };
      }
    }

    if (context.agentRunId && tool.cooldownSeconds) {
      const recentExecution = await this.prisma.toolExecution.findFirst({
        where: {
          orgId: context.orgId,
          toolDefinitionId: tool.id,
          agentRunId: context.agentRunId,
          status: ExecutionStatus.EXECUTED,
        },
        orderBy: { createdAt: 'desc' },
      });

      if (recentExecution) {
        const elapsedSeconds =
          (Date.now() - new Date(recentExecution.createdAt).getTime()) / 1000;
        if (elapsedSeconds < tool.cooldownSeconds) {
          return {
            status: 'BLOCKED',
            decision: {
              decision: 'BLOCKED',
              stage: 'PER_RUN_LIMIT',
              reason: `cooldownSeconds not elapsed (${tool.cooldownSeconds})`,
              details: {
                policyPath: 'toolDefinition.cooldownSeconds',
                toolName: tool.name,
                run: {
                  agentRunId: context.agentRunId,
                  cooldownSeconds: tool.cooldownSeconds,
                  elapsedSeconds,
                },
              },
            },
            policyId: effectiveContext.policyId,
            tool: toolSummary,
          };
        }
      }
    }

    if (autonomy.action === 'QUEUE_APPROVAL') {
      const queueReason = `Autonomy gate requires ${autonomy.requiredApprovals} approval(s)`;
      return {
        status: 'QUEUED_APPROVAL',
        requiredApprovals: autonomy.requiredApprovals,
        decision: {
          decision: 'QUEUED_APPROVAL',
          stage: 'AUTONOMY_GATE',
          reason: queueReason,
          details: {
            policyPath: 'toolDefinition.autonomyLevel',
            toolName: tool.name,
            autonomyLevel: tool.autonomyLevel,
            riskLevel: tool.riskLevel,
            requiredApprovals: autonomy.requiredApprovals,
          },
        },
        policyId: effectiveContext.policyId,
        tool: toolSummary,
      };
    }

    const handler = this.handlers[tool.handlerKey];
    if (!handler) {
      return {
        status: 'BLOCKED',
        decision: {
          decision: 'BLOCKED',
          stage: 'AUTONOMY_GATE',
          reason: `No handler registered for key: ${tool.handlerKey}`,
          details: {
            policyPath: 'toolDefinition.handlerKey',
            toolName: tool.name,
            handlerKey: tool.handlerKey,
          },
        },
        policyId: effectiveContext.policyId,
        tool: toolSummary,
      };
    }

    return {
      status: 'ALLOWED',
      decision: {
        decision: 'ALLOWED',
        stage: 'AUTONOMY_GATE',
        reason: 'Execution allowed by governance gates',
        details: {
          policyPath: 'execute',
          toolName: tool.name,
          actorType: context.actorType,
          isAutonomous: context.isAutonomous,
        },
      },
      policyId: effectiveContext.policyId,
      tool: toolSummary,
    };
  }

  async executeApprovedRequest(
    approvalRequestId: string,
    context: ExecutionContext,
  ): Promise<ToolExecutionResponse> {
    const approval = await this.prisma.approvalRequest.findFirst({
      where: {
        id: approvalRequestId,
        orgId: context.orgId,
      },
      include: {
        toolDefinition: true,
        toolExecutions: {
          where: {
            status: ExecutionStatus.QUEUED_APPROVAL,
          },
          take: 1,
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!approval) {
      throw new Error(`Approval request not found: ${approvalRequestId}`);
    }

    if (approval.status !== ApprovalStatus.APPROVED) {
      throw new Error('Approval request must be APPROVED before execution');
    }

    const envelope = approval.requestPayload as unknown as RequestPayloadEnvelope;
    const payload = envelope.payload ?? {};

    const handler = this.handlers[approval.toolDefinition.handlerKey];
    if (!handler) {
      throw new Error(`Missing handler for ${approval.toolDefinition.handlerKey}`);
    }

    const queuedExecution = approval.toolExecutions[0];
    if (!queuedExecution) {
      throw new Error('No queued execution linked to approved request');
    }

    return this.prisma.$transaction(async (tx) => {
      let contextSnapshotId = queuedExecution.contextSnapshotId ?? null;
      if (approval.toolDefinition.requiresSnapshot) {
        const snapshot = await tx.contextSnapshot.create({
          data: {
            orgId: context.orgId,
            agentRunId: queuedExecution.agentRunId,
            toolExecutionId: queuedExecution.id,
            snapshotJson: toInputJson(payload),
            createdByType: context.actorType,
            createdByUserId: context.actorUserId,
            summary: 'Snapshot captured during approved execution',
          },
        });
        contextSnapshotId = snapshot.id;
      }

      try {
        const approvedContext: ExecutionContext = {
          ...context,
          approvedExecution: true,
        };

        const output = await handler({
          tool: approval.toolDefinition,
          payload,
          context: approvedContext,
        });
        const directive = parseHandlerGovernanceDirective(output);

        if (directive?.status === 'BLOCKED') {
          const decision =
            directive.decision ??
            ({
              decision: 'BLOCKED',
              stage: 'AUTONOMY_GATE',
              reason: directive.reason,
              details: {
                policyPath: 'handler.__registryDecision',
                toolName: approval.toolDefinition.name,
              },
            } satisfies PolicyDecision);

          await tx.toolExecution.update({
            where: { id: queuedExecution.id },
            data: {
              status: ExecutionStatus.BLOCKED,
              outputPayload: decisionEnvelope(decision),
              contextSnapshotId,
              riskLevelAtExec: approval.toolDefinition.riskLevel,
              autonomyLevelAtExec: approval.toolDefinition.autonomyLevel,
              blockedReason: directive.reason,
              errorMessage: null,
              executedAt: new Date(),
            },
          });

          await tx.auditLog.create({
            data: {
              orgId: context.orgId,
              actorType: context.actorType,
              actorUserId: context.actorUserId,
              correlationId: context.correlationId,
              action: 'tool.blocked',
              entityType: 'ToolExecution',
              entityId: queuedExecution.id,
              metadata: toInputJson({
                toolName: approval.toolDefinition.name,
                approvalRequestId,
                source: 'approved-request',
                reason: directive.reason,
                decision,
              }),
            },
          });

          await enqueueOutbox(tx, {
            orgId: context.orgId,
            eventType: 'tool.blocked',
            correlationId: context.correlationId,
            payload: toInputJson({
              executionId: queuedExecution.id,
              toolName: approval.toolDefinition.name,
              approvalRequestId,
              reason: directive.reason,
              decision,
            }),
          });

          return {
            status: 'BLOCKED' as const,
            executionId: queuedExecution.id,
            reason: directive.reason,
          };
        }

        if (directive?.status === 'QUEUED_APPROVAL') {
          throw new Error(
            'Approved execution cannot be re-queued for approval. Review handler governance checks.',
          );
        }

        await tx.toolExecution.update({
          where: { id: queuedExecution.id },
          data: {
            status: ExecutionStatus.EXECUTED,
            outputPayload: toInputJson(directive?.output ?? output),
            contextSnapshotId,
            riskLevelAtExec: approval.toolDefinition.riskLevel,
            autonomyLevelAtExec: approval.toolDefinition.autonomyLevel,
            executedAt: new Date(),
            blockedReason: null,
            errorMessage: null,
          },
        });

        await tx.auditLog.create({
          data: {
            orgId: context.orgId,
            actorType: context.actorType,
            actorUserId: context.actorUserId,
            correlationId: context.correlationId,
            action: 'tool.executed',
            entityType: 'ToolExecution',
            entityId: queuedExecution.id,
            metadata: {
              toolName: approval.toolDefinition.name,
              approvalRequestId,
              source: 'approved-request',
            },
          },
        });

        await enqueueOutbox(tx, {
          orgId: context.orgId,
          eventType: 'tool.executed',
          correlationId: context.correlationId,
          payload: {
            executionId: queuedExecution.id,
            toolName: approval.toolDefinition.name,
            approvalRequestId,
          },
        });

        return {
          status: 'EXECUTED' as const,
          executionId: queuedExecution.id,
          output: directive?.output ?? output,
        };
      } catch (error) {
        const normalizedError = normalizeExecutionError(error);

        await tx.toolExecution.update({
          where: { id: queuedExecution.id },
          data: {
            status: ExecutionStatus.FAILED,
            errorMessage: normalizedError.message,
            executedAt: new Date(),
          },
        });

        await tx.auditLog.create({
          data: {
            orgId: context.orgId,
            actorType: context.actorType,
            actorUserId: context.actorUserId,
            correlationId: context.correlationId,
            action: 'tool.failed',
            entityType: 'ToolExecution',
            entityId: queuedExecution.id,
            metadata: {
              toolName: approval.toolDefinition.name,
              approvalRequestId,
              error: normalizedError.message,
              errorCode: normalizedError.code,
              recoverable: normalizedError.recoverable,
              source: 'approved-request',
            },
          },
        });

        await enqueueOutbox(tx, {
          orgId: context.orgId,
          eventType: 'tool.failed',
          correlationId: context.correlationId,
          payload: {
            executionId: queuedExecution.id,
            toolName: approval.toolDefinition.name,
            approvalRequestId,
            error: normalizedError.message,
            errorCode: normalizedError.code,
            recoverable: normalizedError.recoverable,
          },
        });

        return {
          status: 'FAILED' as const,
          executionId: queuedExecution.id,
          error: normalizedError.message,
          errorCode: normalizedError.code,
          recoverable: normalizedError.recoverable,
        };
      }
    });
  }

  private async executeNow(args: {
    tool: ToolDefinition;
    payload: Record<string, unknown>;
    context: ExecutionContext;
    financialExposurePlan?: FinancialExposurePlan;
  }): Promise<ToolExecutionResponse> {
    const handler = this.handlers[args.tool.handlerKey];
    if (!handler) {
      const reason = `No handler registered for key: ${args.tool.handlerKey}`;
      return this.writeBlockedExecution({
        context: args.context,
        tool: args.tool,
        payload: args.payload,
        reason,
        decision: {
          decision: 'BLOCKED',
          stage: 'AUTONOMY_GATE',
          reason,
          details: {
            toolName: args.tool.name,
            policyPath: 'toolDefinition.handlerKey',
            handlerKey: args.tool.handlerKey,
          },
        },
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const execution = await tx.toolExecution.create({
        data: {
          orgId: args.context.orgId,
          toolDefinitionId: args.tool.id,
          agentRunId: args.context.agentRunId,
          policyId: args.context.policyId,
          actorType: args.context.actorType,
          actorUserId: args.context.actorUserId,
          actorLabel: args.context.actorLabel,
          clientActionId: args.context.clientActionId,
          correlationId: args.context.correlationId,
          isAutonomous: args.context.isAutonomous,
          status: ExecutionStatus.EXECUTED,
          riskLevelSnapshot: args.tool.riskLevel,
          autonomyLevelSnapshot: args.tool.autonomyLevel,
          riskLevelAtExec: args.tool.riskLevel,
          autonomyLevelAtExec: args.tool.autonomyLevel,
          inputPayload: toInputJson(args.payload),
          reason: args.context.reason,
        },
      });

      let contextSnapshotId: string | null = null;
      if (args.tool.requiresSnapshot) {
        const snapshot = await tx.contextSnapshot.create({
          data: {
            orgId: args.context.orgId,
            agentRunId: args.context.agentRunId,
            toolExecutionId: execution.id,
            snapshotJson: toInputJson(args.payload),
            createdByType: args.context.actorType,
            createdByUserId: args.context.actorUserId,
            summary: 'Snapshot captured before execution',
          },
        });
        contextSnapshotId = snapshot.id;
      }

      try {
        const output = await handler({
          tool: args.tool,
          payload: args.payload,
          context: args.context,
        });
        const directive = parseHandlerGovernanceDirective(output);

        if (directive?.status === 'BLOCKED') {
          const decision =
            directive.decision ??
            ({
              decision: 'BLOCKED',
              stage: 'AUTONOMY_GATE',
              reason: directive.reason,
              details: {
                policyPath: 'handler.__registryDecision',
                toolName: args.tool.name,
              },
            } satisfies PolicyDecision);

          await tx.toolExecution.update({
            where: { id: execution.id },
            data: {
              status: ExecutionStatus.BLOCKED,
              outputPayload: decisionEnvelope(decision),
              contextSnapshotId: contextSnapshotId ?? undefined,
              blockedReason: directive.reason,
              errorMessage: null,
              executedAt: new Date(),
            },
          });

          await tx.auditLog.create({
            data: {
              orgId: args.context.orgId,
              actorType: args.context.actorType,
              actorUserId: args.context.actorUserId,
              correlationId: args.context.correlationId,
              action: 'tool.blocked',
              entityType: 'ToolExecution',
              entityId: execution.id,
              metadata: toInputJson({
                toolName: args.tool.name,
                reason: directive.reason,
                source: 'handler-governance',
                decision,
              }),
            },
          });

          await enqueueOutbox(tx, {
            orgId: args.context.orgId,
            eventType: 'tool.blocked',
            correlationId: args.context.correlationId,
            payload: toInputJson({
              executionId: execution.id,
              toolName: args.tool.name,
              reason: directive.reason,
              decision,
            }),
          });

          return {
            status: 'BLOCKED' as const,
            executionId: execution.id,
            reason: directive.reason,
          };
        }

        if (directive?.status === 'QUEUED_APPROVAL') {
          const requiredApprovals = Math.max(1, directive.requiredApprovals ?? 1);
          const decision =
            directive.decision ??
            ({
              decision: 'QUEUED_APPROVAL',
              stage: 'AUTONOMY_GATE',
              reason: directive.reason,
              details: {
                policyPath: 'handler.__registryDecision',
                toolName: args.tool.name,
                requiredApprovals,
              },
            } satisfies PolicyDecision);
          const queuedPayload = directive.approvalPayload ?? args.payload;

          const approval = await tx.approvalRequest.create({
            data: {
              orgId: args.context.orgId,
              toolDefinitionId: args.tool.id,
              status: ApprovalStatus.PENDING,
              requiredApprovals,
              requestedByType: args.context.actorType,
              requestedByUserId: args.context.actorUserId,
              requestPayload: toInputJson({
                toolName: args.tool.name,
                payload: queuedPayload,
                context: {
                  ...args.context,
                  version: undefined,
                  approvedExecution: undefined,
                },
              }),
              reason: directive.reason,
            },
          });

          await tx.toolExecution.update({
            where: { id: execution.id },
            data: {
              status: ExecutionStatus.QUEUED_APPROVAL,
              approvalRequestId: approval.id,
              outputPayload: decisionEnvelope(decision),
              contextSnapshotId: contextSnapshotId ?? undefined,
              blockedReason: null,
              errorMessage: null,
              reason: directive.reason,
              executedAt: new Date(),
            },
          });

          await tx.auditLog.create({
            data: {
              orgId: args.context.orgId,
              actorType: args.context.actorType,
              actorUserId: args.context.actorUserId,
              correlationId: args.context.correlationId,
              action: 'approval.requested',
              entityType: 'ApprovalRequest',
              entityId: approval.id,
              metadata: toInputJson({
                toolName: args.tool.name,
                toolExecutionId: execution.id,
                requiredApprovals,
                source: 'handler-governance',
                decision,
              }),
            },
          });

          await enqueueOutbox(tx, {
            orgId: args.context.orgId,
            eventType: 'approval.requested',
            correlationId: args.context.correlationId,
            payload: toInputJson({
              approvalRequestId: approval.id,
              toolExecutionId: execution.id,
              toolName: args.tool.name,
              requiredApprovals,
            }),
          });

          return {
            status: 'QUEUED_APPROVAL' as const,
            executionId: execution.id,
            approvalRequestId: approval.id,
            requiredApprovals,
          };
        }

        const executedOutput = directive?.output ?? output;

        if (args.financialExposurePlan) {
          await tx.financialExposureDaily.upsert({
            where: {
              orgId_date_bucket: {
                orgId: args.context.orgId,
                date: args.financialExposurePlan.localDate,
                bucket: args.financialExposurePlan.bucket,
              },
            },
            update: {
              usedCents: { increment: args.financialExposurePlan.amountCents },
            },
            create: {
              orgId: args.context.orgId,
              date: args.financialExposurePlan.localDate,
              bucket: args.financialExposurePlan.bucket,
              usedCents: args.financialExposurePlan.amountCents,
            },
          });
        }

        await tx.toolExecution.update({
          where: { id: execution.id },
          data: {
            outputPayload: toInputJson(executedOutput),
            contextSnapshotId: contextSnapshotId ?? undefined,
            executedAt: new Date(),
          },
        });

        await tx.auditLog.create({
          data: {
            orgId: args.context.orgId,
            actorType: args.context.actorType,
            actorUserId: args.context.actorUserId,
            correlationId: args.context.correlationId,
            action: 'tool.executed',
            entityType: 'ToolExecution',
            entityId: execution.id,
            metadata: {
              toolName: args.tool.name,
              riskLevel: args.tool.riskLevel,
              autonomyLevel: args.tool.autonomyLevel,
            },
          },
        });

        await enqueueOutbox(tx, {
          orgId: args.context.orgId,
          eventType: 'tool.executed',
          correlationId: args.context.correlationId,
          payload: {
            executionId: execution.id,
            toolName: args.tool.name,
            status: ExecutionStatus.EXECUTED,
          },
        });

        if (args.tool.name === 'accounting.receipt.upload') {
          const outputRecord =
            executedOutput &&
            typeof executedOutput === 'object' &&
            !Array.isArray(executedOutput)
              ? (executedOutput as Record<string, unknown>)
              : {};
          await enqueueOutbox(tx, {
            orgId: args.context.orgId,
            eventType: 'receipt.uploaded',
            correlationId: args.context.correlationId,
            payload: toInputJson({
              executionId: execution.id,
              toolName: args.tool.name,
              receiptId:
                typeof outputRecord.receiptId === 'string'
                  ? outputRecord.receiptId
                  : null,
              attachmentId:
                typeof outputRecord.attachmentId === 'string'
                  ? outputRecord.attachmentId
                  : null,
              expenseId:
                typeof outputRecord.expenseId === 'string'
                  ? outputRecord.expenseId
                  : null,
            }),
          });
        }

        return {
          status: 'EXECUTED' as const,
          executionId: execution.id,
          output: executedOutput,
        };
      } catch (error) {
        const normalizedError = normalizeExecutionError(error);

        await tx.toolExecution.update({
          where: { id: execution.id },
          data: {
            status: ExecutionStatus.FAILED,
            errorMessage: normalizedError.message,
            executedAt: new Date(),
          },
        });

        await tx.auditLog.create({
          data: {
            orgId: args.context.orgId,
            actorType: args.context.actorType,
            actorUserId: args.context.actorUserId,
            correlationId: args.context.correlationId,
            action: 'tool.failed',
            entityType: 'ToolExecution',
            entityId: execution.id,
            metadata: {
              toolName: args.tool.name,
              error: normalizedError.message,
              errorCode: normalizedError.code,
              recoverable: normalizedError.recoverable,
            },
          },
        });

        await enqueueOutbox(tx, {
          orgId: args.context.orgId,
          eventType: 'tool.failed',
          correlationId: args.context.correlationId,
          payload: {
            executionId: execution.id,
            toolName: args.tool.name,
            status: ExecutionStatus.FAILED,
            error: normalizedError.message,
            errorCode: normalizedError.code,
            recoverable: normalizedError.recoverable,
          },
        });

        return {
          status: 'FAILED' as const,
          executionId: execution.id,
          error: normalizedError.message,
          errorCode: normalizedError.code,
          recoverable: normalizedError.recoverable,
        };
      }
    });
  }

  private async queueApproval(args: {
    tool: ToolDefinition;
    payload: Record<string, unknown>;
    context: ExecutionContext;
    requiredApprovals: number;
    decision: PolicyDecision;
  }): Promise<ToolExecutionResponse> {
    return this.prisma.$transaction(async (tx) => {
      const approval = await tx.approvalRequest.create({
        data: {
          orgId: args.context.orgId,
          toolDefinitionId: args.tool.id,
          status: ApprovalStatus.PENDING,
          requiredApprovals: args.requiredApprovals,
          requestedByType: args.context.actorType,
          requestedByUserId: args.context.actorUserId,
          requestPayload: {
            toolName: args.tool.name,
            payload: args.payload,
            context: {
              ...args.context,
              version: undefined,
            },
          } as unknown as Prisma.InputJsonValue,
          reason: args.context.reason,
        },
      });

      const execution = await tx.toolExecution.create({
        data: {
          orgId: args.context.orgId,
          toolDefinitionId: args.tool.id,
          approvalRequestId: approval.id,
          agentRunId: args.context.agentRunId,
          policyId: args.context.policyId,
          actorType: args.context.actorType,
          actorUserId: args.context.actorUserId,
          actorLabel: args.context.actorLabel,
          clientActionId: args.context.clientActionId,
          correlationId: args.context.correlationId,
          isAutonomous: args.context.isAutonomous,
          status: ExecutionStatus.QUEUED_APPROVAL,
          riskLevelSnapshot: args.tool.riskLevel,
          autonomyLevelSnapshot: args.tool.autonomyLevel,
          riskLevelAtExec: args.tool.riskLevel,
          autonomyLevelAtExec: args.tool.autonomyLevel,
          inputPayload: toInputJson(args.payload),
          outputPayload: decisionEnvelope(args.decision),
          reason: args.context.reason,
        },
      });

      await tx.auditLog.create({
        data: {
          orgId: args.context.orgId,
          actorType: args.context.actorType,
          actorUserId: args.context.actorUserId,
          correlationId: args.context.correlationId,
          action: 'approval.requested',
          entityType: 'ApprovalRequest',
          entityId: approval.id,
          metadata: toInputJson({
            toolName: args.tool.name,
            toolExecutionId: execution.id,
            requiredApprovals: args.requiredApprovals,
            riskLevel: args.tool.riskLevel,
            autonomyLevel: args.tool.autonomyLevel,
            decision: args.decision,
          }),
        },
      });

      await enqueueOutbox(tx, {
        orgId: args.context.orgId,
        eventType: 'approval.requested',
        correlationId: args.context.correlationId,
        payload: {
          approvalRequestId: approval.id,
          toolExecutionId: execution.id,
          toolName: args.tool.name,
          requiredApprovals: args.requiredApprovals,
        },
      });

      return {
        status: 'QUEUED_APPROVAL' as const,
        executionId: execution.id,
        approvalRequestId: approval.id,
        requiredApprovals: args.requiredApprovals,
      };
    });
  }

  private async queueFinancialExposureApproval(args: {
    tool: ToolDefinition;
    payload: Record<string, unknown>;
    context: ExecutionContext;
    plan: FinancialExposurePlan;
    reason: string;
    decision: PolicyDecision;
  }): Promise<ToolExecutionResponse> {
    return this.prisma.$transaction(async (tx) => {
      const approval = await tx.approvalRequest.create({
        data: {
          orgId: args.context.orgId,
          toolDefinitionId: args.tool.id,
          status: ApprovalStatus.PENDING,
          requiredApprovals: args.plan.requiredApprovals,
          requestedByType: args.context.actorType,
          requestedByUserId: args.context.actorUserId,
          reason: args.reason,
          requestPayload: toInputJson({
            toolName: args.tool.name,
            payload: args.payload,
            context: {
              ...args.context,
              version: undefined,
            },
            financialExposure: {
              bucket: args.plan.bucket,
              amountCents: args.plan.amountCents,
              usedCents: args.plan.usedCents,
              projectedCents: args.plan.projectedCents,
              limitCents: args.plan.limitCents,
              timezone: args.plan.timezone,
              localDate: args.plan.localDate.toISOString(),
            },
          }),
        },
      });

      const execution = await tx.toolExecution.create({
        data: {
          orgId: args.context.orgId,
          toolDefinitionId: args.tool.id,
          approvalRequestId: approval.id,
          agentRunId: args.context.agentRunId,
          policyId: args.context.policyId,
          actorType: args.context.actorType,
          actorUserId: args.context.actorUserId,
          actorLabel: args.context.actorLabel,
          clientActionId: args.context.clientActionId,
          correlationId: args.context.correlationId,
          isAutonomous: args.context.isAutonomous,
          status: ExecutionStatus.QUEUED_APPROVAL,
          riskLevelSnapshot: args.tool.riskLevel,
          autonomyLevelSnapshot: args.tool.autonomyLevel,
          riskLevelAtExec: args.tool.riskLevel,
          autonomyLevelAtExec: args.tool.autonomyLevel,
          inputPayload: toInputJson(args.payload),
          outputPayload: decisionEnvelope(args.decision),
          reason: args.reason,
        },
      });

      await tx.auditLog.create({
        data: {
          orgId: args.context.orgId,
          actorType: args.context.actorType,
          actorUserId: args.context.actorUserId,
          correlationId: args.context.correlationId,
          action: 'finance.exposure.breached',
          entityType: 'ApprovalRequest',
          entityId: approval.id,
          metadata: toInputJson({
            toolName: args.tool.name,
            toolExecutionId: execution.id,
            requiredApprovals: args.plan.requiredApprovals,
            reason: args.reason,
            bucket: args.plan.bucket,
            amountCents: args.plan.amountCents,
            usedCents: args.plan.usedCents,
            projectedCents: args.plan.projectedCents,
            limitCents: args.plan.limitCents,
            decision: args.decision,
          }),
        },
      });

      await enqueueOutbox(tx, {
        orgId: args.context.orgId,
        eventType: 'approval.requested',
        correlationId: args.context.correlationId,
        payload: {
          approvalRequestId: approval.id,
          toolExecutionId: execution.id,
          toolName: args.tool.name,
          requiredApprovals: args.plan.requiredApprovals,
        },
      });

      await enqueueOutbox(tx, {
        orgId: args.context.orgId,
        eventType: 'finance.exposure.breached',
        correlationId: args.context.correlationId,
        payload: {
          approvalRequestId: approval.id,
          toolExecutionId: execution.id,
          toolName: args.tool.name,
          bucket: args.plan.bucket,
          amountCents: args.plan.amountCents,
          usedCents: args.plan.usedCents,
          projectedCents: args.plan.projectedCents,
          limitCents: args.plan.limitCents,
          reason: args.reason,
        },
      });

      return {
        status: 'QUEUED_APPROVAL' as const,
        executionId: execution.id,
        approvalRequestId: approval.id,
        requiredApprovals: args.plan.requiredApprovals,
      };
    });
  }

  private async writeBlockedExecution(args: {
    tool: ToolDefinition;
    payload: Record<string, unknown>;
    context: ExecutionContext;
    reason: string;
    decision?: PolicyDecision;
  }): Promise<ToolExecutionResponse> {
    return this.prisma.$transaction(async (tx) => {
      const execution = await tx.toolExecution.create({
        data: {
          orgId: args.context.orgId,
          toolDefinitionId: args.tool.id,
          agentRunId: args.context.agentRunId,
          policyId: args.context.policyId,
          actorType: args.context.actorType,
          actorUserId: args.context.actorUserId,
          actorLabel: args.context.actorLabel,
          clientActionId: args.context.clientActionId,
          correlationId: args.context.correlationId,
          isAutonomous: args.context.isAutonomous,
          status: ExecutionStatus.BLOCKED,
          riskLevelSnapshot: args.tool.riskLevel,
          autonomyLevelSnapshot: args.tool.autonomyLevel,
          riskLevelAtExec: args.tool.riskLevel,
          autonomyLevelAtExec: args.tool.autonomyLevel,
          inputPayload: toInputJson(args.payload),
          outputPayload: args.decision
            ? decisionEnvelope(args.decision)
            : undefined,
          blockedReason: args.reason,
          reason: args.context.reason,
          executedAt: new Date(),
        },
      });

      await tx.auditLog.create({
        data: {
          orgId: args.context.orgId,
          actorType: args.context.actorType,
          actorUserId: args.context.actorUserId,
          correlationId: args.context.correlationId,
          action: 'tool.blocked',
          entityType: 'ToolExecution',
          entityId: execution.id,
          metadata: toInputJson({
            toolName: args.tool.name,
            reason: args.reason,
            riskLevel: args.tool.riskLevel,
            autonomyLevel: args.tool.autonomyLevel,
            decision: args.decision,
          }),
        },
      });

      await enqueueOutbox(tx, {
        orgId: args.context.orgId,
        eventType: 'tool.blocked',
        correlationId: args.context.correlationId,
        payload: toInputJson({
          executionId: execution.id,
          toolName: args.tool.name,
          reason: args.reason,
          decision: args.decision,
        }),
      });

      return {
        status: 'BLOCKED' as const,
        executionId: execution.id,
        reason: args.reason,
      };
    });
  }

  private getValidator(tool: ToolDefinition): ValidateFunction {
    const cacheKey = `${tool.id}:${tool.version}`;
    const existing = this.validationCache.get(cacheKey);
    if (existing) {
      return existing;
    }

    const validator = this.ajv.compile(tool.inputSchema as object);
    this.validationCache.set(cacheKey, validator);
    return validator;
  }

  private async getActorPermissions(context: ExecutionContext): Promise<string[]> {
    if (!context.actorUserId) {
      return [];
    }

    const userRoles = await this.prisma.userRole.findMany({
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

    const keys = new Set<string>();
    for (const userRole of userRoles) {
      for (const rolePermission of userRole.role.rolePermissions) {
        keys.add(rolePermission.permission.key);
      }
    }

    return [...keys.values()];
  }

  private async resolveToolDefinition(
    toolName: string,
    orgId: string,
    version?: string,
  ): Promise<ToolDefinition | null> {
    const tools = await this.prisma.toolDefinition.findMany({
      where: {
        orgId,
        name: toolName,
        active: true,
      },
    });

    if (tools.length === 0) {
      return null;
    }

    if (version) {
      return tools.find((tool) => tool.version === version) ?? null;
    }

    return tools.sort((a, b) => semver.rcompare(a.version, b.version))[0] ?? null;
  }
}
