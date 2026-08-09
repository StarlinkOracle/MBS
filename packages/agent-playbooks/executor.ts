import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import type {
  ExecutePlaybookArgs,
  PlaybookRuntimeResult,
  SkillStep,
  StepRiskLevel,
} from './types.js';

const require = createRequire(import.meta.url);
const Ajv = require('ajv');

const DEFAULT_KEY_IDENTIFIERS = [
  'quoteId',
  'leadId',
  'jobId',
  'contractId',
  'draftId',
  'templateId',
  'customerId',
  'assessmentId',
] as const;

class StepExecutionTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Tool step execution timed out after ${timeoutMs}ms`);
    this.name = 'StepExecutionTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

async function executeWithTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number | undefined,
): Promise<T> {
  if (!timeoutMs || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return operation();
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new StepExecutionTimeoutError(Math.floor(timeoutMs)));
        }, Math.floor(timeoutMs));
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort((a, b) => a.localeCompare(b));
  const rows = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${rows.join(',')}}`;
}

function safeJsonByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

type PayloadShapeReason = 'MAX_DEPTH_EXCEEDED' | 'MAX_KEYS_EXCEEDED';

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || (value as number) < 1) {
    return fallback;
  }
  return Math.max(1, Math.floor(value as number));
}

function inspectPayloadShape(args: {
  value: unknown;
  maxDepth: number;
  maxKeys: number;
}): {
  reason?: PayloadShapeReason;
  actualDepth: number;
  actualKeys: number;
} {
  const maxDepth = normalizePositiveInt(args.maxDepth, 25);
  const maxKeys = normalizePositiveInt(args.maxKeys, 6_000);
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

  return {
    actualDepth,
    actualKeys,
  };
}

function sanitizeRiskLevel(value: unknown): StepRiskLevel {
  if (value === 'LOW' || value === 'MEDIUM' || value === 'HIGH' || value === 'CRITICAL') {
    return value;
  }
  return 'HIGH';
}

function collectKeyIdentifiers(
  inputs: Record<string, unknown>,
  explicitFields?: string[],
): Record<string, unknown> {
  const fields = explicitFields && explicitFields.length > 0
    ? explicitFields
    : [...DEFAULT_KEY_IDENTIFIERS];
  const collected: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.hasOwn(inputs, field)) {
      collected[field] = inputs[field];
    }
  }
  return collected;
}

export function buildDeterministicRequestId(args: {
  correlationId: string;
  playbookStableId: string;
  skillStableId: string;
  stepIndex: number;
  keyIdentifiers: Record<string, unknown>;
}): string {
  const seed = stableStringify({
    correlationId: args.correlationId,
    playbookStableId: args.playbookStableId,
    skillStableId: args.skillStableId,
    stepIndex: args.stepIndex,
    keyIdentifiers: args.keyIdentifiers,
  });
  return `pbreq_${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}

function shouldProvideRequestId(step: SkillStep): boolean {
  return step.requiresRequestId === true;
}

function shouldRetryOnce(args: {
  step: SkillStep;
  requestId?: string;
  recoverable?: boolean;
}): boolean {
  if (args.step.retryOnRecoverableFailure !== true) {
    return false;
  }
  if (!args.requestId) {
    return false;
  }
  if (args.recoverable !== true) {
    return false;
  }
  const riskLevel = sanitizeRiskLevel(args.step.riskLevel);
  return riskLevel === 'LOW' || riskLevel === 'MEDIUM';
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function toStringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function buildFinalResult(executedSteps: PlaybookRuntimeResult['executedSteps'], lastOutput: unknown) {
  let diffSummary: unknown;
  const references: unknown[] = [];
  for (const step of executedSteps) {
    if (step.outcome !== 'EXECUTED') {
      continue;
    }
    const output = toRecord(step.data);
    if (diffSummary === undefined && Object.hasOwn(output, 'diffSummary')) {
      diffSummary = output.diffSummary;
    }
    if (Array.isArray(output.references)) {
      references.push(...output.references);
    }
  }
  return {
    diffSummary,
    references: references.length > 0 ? references : undefined,
    lastOutput,
  };
}

function validateFinalResultSchema(args: {
  result: ReturnType<typeof buildFinalResult>;
  schema?: Record<string, unknown>;
}): { valid: boolean; errors?: string[] } {
  if (!args.schema) {
    return { valid: true };
  }
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validator = ajv.compile(args.schema);
  if (validator(args.result)) {
    return { valid: true };
  }
  const errors = (validator.errors ?? []).map((entry: { instancePath?: string; message?: string }) =>
    `${entry.instancePath || '/'} ${entry.message || 'invalid'}`.trim(),
  );
  return { valid: false, errors };
}

export async function executePlaybook(args: ExecutePlaybookArgs): Promise<PlaybookRuntimeResult> {
  if (
    args.packVersion &&
    args.pack.packVersion &&
    args.packVersion !== args.pack.packVersion
  ) {
    return {
      status: 'FAILED',
      executedSteps: [],
      error: {
        code: 'PACK_VERSION_MISMATCH',
        message: `Requested packVersion ${args.packVersion} does not match loaded pack version ${args.pack.packVersion}`,
      },
    };
  }

  const playbook = args.pack.playbooksByStableId.get(args.playbookStableId);
  if (!playbook) {
    return {
      status: 'FAILED',
      executedSteps: [],
      error: {
        code: 'PLAYBOOK_NOT_FOUND',
        message: `Playbook ${args.playbookStableId} was not found`,
      },
    };
  }

  if (playbook.status === 'SPEC_ONLY') {
    return {
      status: 'BLOCKED',
      executedSteps: [],
      missingTools: [...playbook.requiresTools],
      error: {
        code: 'PLAYBOOK_SPEC_ONLY',
        message: `Playbook ${playbook.stableId} is SPEC_ONLY and cannot execute`,
      },
    };
  }

  const executedSteps: PlaybookRuntimeResult['executedSteps'] = [];
  let lastOutput: unknown;
  let globalStepIndex = 0;
  const maxSteps = args.maxSteps ?? 200;
  const maxStepExecutionMs = args.maxStepExecutionMs ?? 15_000;
  const maxStepPayloadBytes = args.maxStepPayloadBytes ?? 64 * 1024;
  const maxStepPayloadDepth = normalizePositiveInt(args.maxStepPayloadDepth, 25);
  const maxStepPayloadKeys = normalizePositiveInt(args.maxStepPayloadKeys, 6_000);

  for (const skillStableId of playbook.skillSequence) {
    const skill = args.pack.skillsByStableId.get(skillStableId);
    if (!skill) {
      return {
        status: 'FAILED',
        executedSteps,
        error: {
          code: 'PLAYBOOK_SKILL_NOT_FOUND',
          message: `Referenced skill ${skillStableId} is missing`,
          details: { playbookStableId: playbook.stableId, skillStableId },
        },
      };
    }

    for (const step of skill.toolSequence) {
      if (globalStepIndex >= maxSteps) {
        return {
          status: 'FAILED',
          executedSteps,
          finalResult: buildFinalResult(executedSteps, lastOutput),
          error: {
            code: 'PLAYBOOK_MAX_STEPS_EXCEEDED',
            message: `Playbook exceeded max step limit (${maxSteps})`,
            details: {
              playbookStableId: playbook.stableId,
              maxSteps,
            },
          },
        };
      }
      const needsRequestId = shouldProvideRequestId(step) || skill.requestIdPolicy?.mode === 'DETERMINISTIC';
      const requestId = needsRequestId
        ? buildDeterministicRequestId({
            correlationId: args.correlationId,
            playbookStableId: playbook.stableId,
            skillStableId: skill.stableId,
            stepIndex: globalStepIndex,
            keyIdentifiers: collectKeyIdentifiers(args.inputs, step.keyInputFields),
          })
        : undefined;

      const payload = {
        ...(step.passInputs === false ? {} : args.inputs),
        ...(step.payload ?? {}),
        ...(requestId
          ? {
              [step.requestIdField ?? 'requestId']: requestId,
            }
          : {}),
      };

      const payloadBytes = safeJsonByteLength(payload);
      if (payloadBytes > maxStepPayloadBytes) {
        globalStepIndex += 1;
        executedSteps.push({
          skillStableId: skill.stableId,
          stepStableId: step.stableId,
          stepIndex: globalStepIndex - 1,
          toolName: step.toolName,
          outcome: 'FAILED',
          requestId,
          data: {
            error: `Tool step payload exceeds max bytes (${payloadBytes} > ${maxStepPayloadBytes})`,
            errorCode: 'PLAYBOOK_STEP_PAYLOAD_TOO_LARGE',
            payloadBytes,
            maxStepPayloadBytes,
            recoverable: false,
          },
        });
        return {
          status: 'FAILED',
          executedSteps,
          finalResult: buildFinalResult(executedSteps, lastOutput),
          error: {
            code: 'PLAYBOOK_STEP_PAYLOAD_TOO_LARGE',
            message: `Tool step payload exceeds max bytes (${payloadBytes} > ${maxStepPayloadBytes})`,
            details: {
              skillStableId: skill.stableId,
              stepStableId: step.stableId,
              toolName: step.toolName,
              payloadBytes,
              maxStepPayloadBytes,
            },
          },
        };
      }

      const payloadShape = inspectPayloadShape({
        value: payload,
        maxDepth: maxStepPayloadDepth,
        maxKeys: maxStepPayloadKeys,
      });
      if (payloadShape.reason) {
        globalStepIndex += 1;
        const reason =
          payloadShape.reason === 'MAX_DEPTH_EXCEEDED'
            ? `Tool step payload exceeds max depth (${payloadShape.actualDepth} > ${maxStepPayloadDepth})`
            : `Tool step payload exceeds max key count (${payloadShape.actualKeys} > ${maxStepPayloadKeys})`;
        executedSteps.push({
          skillStableId: skill.stableId,
          stepStableId: step.stableId,
          stepIndex: globalStepIndex - 1,
          toolName: step.toolName,
          outcome: 'FAILED',
          requestId,
          data: {
            error: reason,
            errorCode: 'PLAYBOOK_STEP_PAYLOAD_SHAPE_INVALID',
            reason: payloadShape.reason,
            maxStepPayloadDepth,
            maxStepPayloadKeys,
            actualDepth: payloadShape.actualDepth,
            actualKeys: payloadShape.actualKeys,
            recoverable: false,
          },
        });
        return {
          status: 'FAILED',
          executedSteps,
          finalResult: buildFinalResult(executedSteps, lastOutput),
          error: {
            code: 'PLAYBOOK_STEP_PAYLOAD_SHAPE_INVALID',
            message: reason,
            details: {
              skillStableId: skill.stableId,
              stepStableId: step.stableId,
              toolName: step.toolName,
              reason: payloadShape.reason,
              maxStepPayloadDepth,
              maxStepPayloadKeys,
              actualDepth: payloadShape.actualDepth,
              actualKeys: payloadShape.actualKeys,
            },
          },
        };
      }

      const executeStep = async (reasonSuffix: string) =>
        args.registry.execute(step.toolName, payload, {
          ...args.executionContext,
          correlationId: args.correlationId,
          reason: `playbook:${playbook.stableId}:skill:${skill.stableId}:step:${step.stableId}${reasonSuffix}`,
        });

      const buildStepTimeoutFailure = (timeoutMs: number): PlaybookRuntimeResult => {
        globalStepIndex += 1;
        executedSteps.push({
          skillStableId: skill.stableId,
          stepStableId: step.stableId,
          stepIndex: globalStepIndex - 1,
          toolName: step.toolName,
          outcome: 'FAILED',
          requestId,
          data: {
            error: `Tool step execution timed out after ${timeoutMs}ms`,
            errorCode: 'PLAYBOOK_STEP_TIMEOUT',
            timeoutMs,
            recoverable: false,
          },
        });
        return {
          status: 'FAILED',
          executedSteps,
          finalResult: buildFinalResult(executedSteps, lastOutput),
          error: {
            code: 'PLAYBOOK_STEP_TIMEOUT',
            message: `Tool step execution timed out after ${timeoutMs}ms`,
            details: {
              skillStableId: skill.stableId,
              stepStableId: step.stableId,
              toolName: step.toolName,
              timeoutMs,
            },
          },
        };
      };

      let toolResponse: Awaited<ReturnType<typeof executeStep>>;
      try {
        toolResponse = await executeWithTimeout(() => executeStep(''), maxStepExecutionMs);
      } catch (error) {
        if (error instanceof StepExecutionTimeoutError) {
          return buildStepTimeoutFailure(error.timeoutMs);
        }
        throw error;
      }
      if (toolResponse.status === 'FAILED' && shouldRetryOnce({
        step,
        requestId,
        recoverable: toolResponse.recoverable,
      })) {
        try {
          toolResponse = await executeWithTimeout(
            () => executeStep(':retry-once'),
            maxStepExecutionMs,
          );
        } catch (error) {
          if (error instanceof StepExecutionTimeoutError) {
            return buildStepTimeoutFailure(error.timeoutMs);
          }
          throw error;
        }
      }

      globalStepIndex += 1;

      if (toolResponse.status === 'EXECUTED') {
        lastOutput = toolResponse.output;
        executedSteps.push({
          skillStableId: skill.stableId,
          stepStableId: step.stableId,
          stepIndex: globalStepIndex - 1,
          toolName: step.toolName,
          outcome: 'EXECUTED',
          toolExecutionId: toolResponse.executionId,
          requestId,
          data: toolResponse.output,
        });
        continue;
      }

      if (toolResponse.status === 'QUEUED_APPROVAL') {
        executedSteps.push({
          skillStableId: skill.stableId,
          stepStableId: step.stableId,
          stepIndex: globalStepIndex - 1,
          toolName: step.toolName,
          outcome: 'QUEUED_APPROVAL',
          toolExecutionId: toolResponse.executionId,
          requestId,
          data: {
            approvalRequestId: toolResponse.approvalRequestId,
            requiredApprovals: toolResponse.requiredApprovals,
          },
        });
        return {
          status: 'NEEDS_APPROVAL',
          executedSteps,
          finalResult: buildFinalResult(executedSteps, lastOutput),
          approval: {
            approvalRequestId: toolResponse.approvalRequestId,
            reason: `Approval required for ${step.toolName}`,
            stage: 'TOOL_EXECUTION',
            details: {
              requiredApprovals: toolResponse.requiredApprovals,
              skillStableId: skill.stableId,
              stepStableId: step.stableId,
            },
          },
        };
      }

      if (toolResponse.status === 'BLOCKED') {
        executedSteps.push({
          skillStableId: skill.stableId,
          stepStableId: step.stableId,
          stepIndex: globalStepIndex - 1,
          toolName: step.toolName,
          outcome: 'BLOCKED',
          toolExecutionId: toolResponse.executionId,
          requestId,
          data: { reason: toolResponse.reason },
        });
        return {
          status: 'BLOCKED',
          executedSteps,
          finalResult: buildFinalResult(executedSteps, lastOutput),
          error: {
            code: 'PLAYBOOK_STEP_BLOCKED',
            message: toolResponse.reason,
            details: {
              skillStableId: skill.stableId,
              stepStableId: step.stableId,
              toolName: step.toolName,
            },
          },
        };
      }

      const responsePayload = toRecord(toolResponse);
      executedSteps.push({
        skillStableId: skill.stableId,
        stepStableId: step.stableId,
        stepIndex: globalStepIndex - 1,
        toolName: step.toolName,
        outcome: 'FAILED',
        toolExecutionId: toolResponse.executionId,
        requestId,
        data: {
          error: toolResponse.error,
          errorCode: toolResponse.errorCode,
          recoverable: toolResponse.recoverable,
        },
      });
      return {
        status: 'FAILED',
        executedSteps,
        finalResult: buildFinalResult(executedSteps, lastOutput),
        error: {
          code: toStringOrUndefined(toolResponse.errorCode) ?? 'PLAYBOOK_STEP_FAILED',
          message: toolResponse.error,
          details: {
            skillStableId: skill.stableId,
            stepStableId: step.stableId,
            toolName: step.toolName,
            recoverable: responsePayload.recoverable === true,
          },
        },
      };
    }
  }

  const finalResult = buildFinalResult(executedSteps, lastOutput);
  if (playbook.resultSchemaId && !args.pack.schemas.results) {
    return {
      status: 'FAILED',
      executedSteps,
      finalResult,
      error: {
        code: 'RESULT_SCHEMA_MISSING',
        message: `Playbook ${playbook.stableId} requires result schema ${playbook.resultSchemaId}, but no results schema is loaded`,
        details: {
          playbookStableId: playbook.stableId,
          resultSchemaId: playbook.resultSchemaId,
        },
      },
    };
  }
  const schemaValidation = validateFinalResultSchema({
    result: finalResult,
    schema: playbook.resultSchemaId ? args.pack.schemas.results : undefined,
  });
  if (!schemaValidation.valid) {
    return {
      status: 'FAILED',
      executedSteps,
      finalResult,
      error: {
        code: 'RESULT_SCHEMA_VALIDATION_FAILED',
        message: 'Playbook final result did not match schema',
        details: {
          playbookStableId: playbook.stableId,
          resultSchemaId: playbook.resultSchemaId,
          errors: schemaValidation.errors,
        },
      },
    };
  }

  return {
    status: 'COMPLETED',
    executedSteps,
    finalResult,
  };
}
