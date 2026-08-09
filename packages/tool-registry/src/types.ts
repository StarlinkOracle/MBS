import {
  ActorType,
  AutonomyLevel,
  Prisma,
  RiskLevel,
  ToolDefinition,
} from '@prisma/client';

export type ExecutionContext = {
  orgId: string;
  actorType: ActorType;
  actorUserId?: string;
  actorLabel?: string;
  correlationId?: string;
  clientActionId?: string;
  agentRunId?: string;
  isAutonomous: boolean;
  policyId?: string;
  reason?: string;
  endpointAllowsCritical?: boolean;
  approvedExecution?: boolean;
  version?: string;
};

export class ToolExecutionError extends Error {
  readonly code: string;
  readonly recoverable: boolean;

  constructor(args: { code: string; message: string; recoverable: boolean }) {
    super(args.message);
    this.name = 'ToolExecutionError';
    this.code = args.code;
    this.recoverable = args.recoverable;
  }
}

export type ToolExecutionResponse =
  | {
      status: 'EXECUTED';
      executionId: string;
      output: Prisma.JsonValue;
    }
  | {
      status: 'QUEUED_APPROVAL';
      executionId: string;
      approvalRequestId: string;
      requiredApprovals: number;
    }
  | {
      status: 'BLOCKED';
      executionId: string;
      reason: string;
    }
  | {
      status: 'FAILED';
      executionId: string;
      error: string;
      errorCode?: string;
      recoverable?: boolean;
    };

export type RegistryHandlerArgs = {
  tool: ToolDefinition;
  payload: Record<string, unknown>;
  context: ExecutionContext;
};

export type ToolHandler = (args: RegistryHandlerArgs) => Promise<Prisma.JsonValue>;

export type HandlerMap = Record<string, ToolHandler>;

export type AutonomyDecision =
  | { action: 'EXECUTE' }
  | { action: 'QUEUE_APPROVAL'; requiredApprovals: number }
  | { action: 'BLOCK'; reason: string };

export type AutonomyDecisionInput = {
  actorType: ActorType;
  isAutonomous: boolean;
  riskLevel: RiskLevel;
  autonomyLevel: AutonomyLevel;
  endpointAllowsHumanOverride: boolean;
};
