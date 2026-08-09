import type {
  ExecutionContext,
  ToolExecutionResponse,
} from '@rcs/tool-registry';

export type PlaybookStatus = 'READY' | 'SPEC_ONLY';
export type StepRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type ToolCatalogEntry = {
  toolName: string;
  title?: string;
  description?: string;
};

export type ToolsCatalog = {
  packId?: string;
  version?: string;
  tools: ToolCatalogEntry[];
};

export type SkillStep = {
  stableId: string;
  toolName: string;
  payload?: Record<string, unknown>;
  passInputs?: boolean;
  requiresRequestId?: boolean;
  requestIdField?: string;
  riskLevel?: StepRiskLevel;
  retryOnRecoverableFailure?: boolean;
  keyInputFields?: string[];
};

export type SkillDefinition = {
  stableId: string;
  title: string;
  requestIdPolicy?: {
    mode: 'DETERMINISTIC';
    includeCorrelationId?: boolean;
  };
  toolSequence: SkillStep[];
};

export type PlaybookDefinition = {
  stableId: string;
  title: string;
  status: PlaybookStatus;
  requiresTools: string[];
  skillSequence: string[];
  resultSchemaId?: string;
};

export type LoadedPack = {
  packId: string;
  packVersion?: string;
  rootDir: string;
  schemas: {
    toolsCatalog: Record<string, unknown>;
    skill: Record<string, unknown>;
    playbook: Record<string, unknown>;
    results?: Record<string, unknown>;
  };
  toolsCatalog: ToolsCatalog;
  skills: SkillDefinition[];
  playbooks: PlaybookDefinition[];
  skillsByStableId: Map<string, SkillDefinition>;
  playbooksByStableId: Map<string, PlaybookDefinition>;
};

export type PlaybookValidationIssue = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export class PlaybookValidationError extends Error {
  readonly issues: PlaybookValidationIssue[];

  constructor(issues: PlaybookValidationIssue[]) {
    super(`Playbook validation failed with ${issues.length} issue${issues.length === 1 ? '' : 's'}`);
    this.name = 'PlaybookValidationError';
    this.issues = issues;
  }
}

export type PlaybookToolAdapter = {
  execute: (
    toolName: string,
    payload: Record<string, unknown>,
    context: ExecutionContext,
  ) => Promise<ToolExecutionResponse>;
};

export type ExecutedStep = {
  skillStableId: string;
  stepStableId: string;
  stepIndex: number;
  toolName: string;
  outcome: 'EXECUTED' | 'QUEUED_APPROVAL' | 'BLOCKED' | 'FAILED';
  toolExecutionId?: string;
  requestId?: string;
  data?: unknown;
};

export type PlaybookRuntimeResult = {
  status: 'COMPLETED' | 'NEEDS_APPROVAL' | 'BLOCKED' | 'FAILED';
  executedSteps: ExecutedStep[];
  finalResult?: {
    diffSummary?: unknown;
    references?: unknown[];
    lastOutput?: unknown;
  };
  approval?: {
    approvalRequestId?: string;
    reason?: string;
    stage?: string;
    details?: Record<string, unknown>;
  };
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  missingTools?: string[];
};

export type ExecutePlaybookArgs = {
  pack: LoadedPack;
  playbookStableId: string;
  packVersion?: string;
  inputs: Record<string, unknown>;
  executionContext: ExecutionContext;
  correlationId: string;
  registry: PlaybookToolAdapter;
  maxSteps?: number;
  maxStepExecutionMs?: number;
  maxStepPayloadBytes?: number;
  maxStepPayloadDepth?: number;
  maxStepPayloadKeys?: number;
};
