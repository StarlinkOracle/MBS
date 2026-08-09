import {
  cp,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  executePlaybook,
  loadPackFromDir,
  PlaybookValidationError,
  validatePack,
  type PlaybookToolAdapter,
} from '../index.js';

const fixturePackDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'apps',
  'api',
  'tests',
  'fixtures',
  'agent-playbooks',
  'mbs_agent_v1',
);

const baseExecutionContext = {
  orgId: 'org_test',
  actorType: 'HUMAN',
  actorUserId: 'user_test',
  actorLabel: 'Playbook Engine Test',
  isAutonomous: false,
} as const;

async function copyFixtureToTemp(): Promise<{ tempDir: string; packDir: string }> {
  const tempDir = await mkdtemp(join(tmpdir(), 'mbs-agent-pack-v1-'));
  const packDir = join(tempDir, 'mbs_agent_v1');
  await cp(fixturePackDir, packDir, { recursive: true });
  return { tempDir, packDir };
}

describe('agent playbook engine (mbs_agent_v1)', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  it('fails when JSON parse is invalid', async () => {
    const { tempDir, packDir } = await copyFixtureToTemp();
    tempRoots.push(tempDir);
    await writeFile(join(packDir, 'tools_catalog.json'), '{invalid json', 'utf8');
    await expect(loadPackFromDir(packDir)).rejects.toThrow(/Invalid JSON/i);
  });

  it('rejects packs when a JSON file exceeds configured max size', async () => {
    const previous = process.env.AGENT_PLAYBOOK_MAX_JSON_FILE_BYTES;
    process.env.AGENT_PLAYBOOK_MAX_JSON_FILE_BYTES = '16';
    try {
      await expect(loadPackFromDir(fixturePackDir)).rejects.toThrow(
        /exceeds max size/i,
      );
    } finally {
      if (previous == null) {
        delete process.env.AGENT_PLAYBOOK_MAX_JSON_FILE_BYTES;
      } else {
        process.env.AGENT_PLAYBOOK_MAX_JSON_FILE_BYTES = previous;
      }
    }
  });

  it('rejects packs when JSON file count exceeds configured limit', async () => {
    const previous = process.env.AGENT_PLAYBOOK_MAX_FILES;
    process.env.AGENT_PLAYBOOK_MAX_FILES = '1';
    try {
      await expect(loadPackFromDir(fixturePackDir)).rejects.toThrow(
        /max JSON file count/i,
      );
    } finally {
      if (previous == null) {
        delete process.env.AGENT_PLAYBOOK_MAX_FILES;
      } else {
        process.env.AGENT_PLAYBOOK_MAX_FILES = previous;
      }
    }
  });

  it('rejects symlinked JSON artifacts in pack directories', async () => {
    const { tempDir, packDir } = await copyFixtureToTemp();
    tempRoots.push(tempDir);

    const originalPath = join(packDir, 'tools_catalog.json');
    const movedPath = join(packDir, 'tools_catalog.real.json');
    await rename(originalPath, movedPath);
    await symlink('tools_catalog.real.json', originalPath);

    await expect(loadPackFromDir(packDir)).rejects.toThrow(/Symlinked pack files are not allowed/i);
  });

  it('fails schema validation for malformed skill', async () => {
    const { tempDir, packDir } = await copyFixtureToTemp();
    tempRoots.push(tempDir);

    const skillPath = join(packDir, 'skills', 'contract_redline_skill_v1.json');
    const skill = JSON.parse(await readFile(skillPath, 'utf8')) as Record<string, unknown>;
    delete skill.title;
    await writeFile(skillPath, `${JSON.stringify(skill, null, 2)}\n`, 'utf8');

    const pack = await loadPackFromDir(packDir);
    expect(() => validatePack(pack)).toThrow(PlaybookValidationError);
  });

  it('fails validation when skill references an unknown tool', async () => {
    const { tempDir, packDir } = await copyFixtureToTemp();
    tempRoots.push(tempDir);

    const skillPath = join(packDir, 'skills', 'contract_redline_skill_v1.json');
    const skill = JSON.parse(await readFile(skillPath, 'utf8')) as Record<string, unknown>;
    const toolSequence = Array.isArray(skill.toolSequence) ? [...skill.toolSequence] : [];
    toolSequence[0] = {
      ...(toolSequence[0] as Record<string, unknown>),
      toolName: 'unknown.tool',
    };
    skill.toolSequence = toolSequence;
    await writeFile(skillPath, `${JSON.stringify(skill, null, 2)}\n`, 'utf8');

    const pack = await loadPackFromDir(packDir);
    expect(() => validatePack(pack)).toThrow(PlaybookValidationError);
  });

  it('fails validation when tools_catalog contains duplicate toolName rows', async () => {
    const { tempDir, packDir } = await copyFixtureToTemp();
    tempRoots.push(tempDir);

    const catalogPath = join(packDir, 'tools_catalog.json');
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as {
      tools?: Array<Record<string, unknown>>;
    };
    const tools = Array.isArray(catalog.tools) ? [...catalog.tools] : [];
    if (tools.length < 1) {
      throw new Error('Fixture tools_catalog.json has no tools');
    }
    tools.push({
      ...tools[0],
    });
    catalog.tools = tools;
    await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');

    const pack = await loadPackFromDir(packDir);
    expect(() => validatePack(pack)).toThrow(PlaybookValidationError);
  });

  it('fails validation when a skill has duplicate step stableId values', async () => {
    const { tempDir, packDir } = await copyFixtureToTemp();
    tempRoots.push(tempDir);

    const skillPath = join(packDir, 'skills', 'contract_redline_skill_v1.json');
    const skill = JSON.parse(await readFile(skillPath, 'utf8')) as {
      toolSequence?: Array<Record<string, unknown>>;
    };
    const toolSequence = Array.isArray(skill.toolSequence) ? [...skill.toolSequence] : [];
    if (toolSequence.length < 2) {
      throw new Error('Fixture skill does not contain at least two toolSequence steps');
    }
    toolSequence[1] = {
      ...toolSequence[1],
      stableId: toolSequence[0]?.stableId,
    };
    skill.toolSequence = toolSequence;
    await writeFile(skillPath, `${JSON.stringify(skill, null, 2)}\n`, 'utf8');

    const pack = await loadPackFromDir(packDir);
    expect(() => validatePack(pack)).toThrow(PlaybookValidationError);
  });

  it('executes all steps and completes when all tool calls EXECUTED', async () => {
    const pack = await loadPackFromDir(fixturePackDir);
    validatePack(pack);

    const execute = vi.fn<PlaybookToolAdapter['execute']>()
      .mockResolvedValueOnce({
        status: 'EXECUTED',
        executionId: 'exec_1',
        output: { diffSummary: 'summary 1' },
      })
      .mockResolvedValueOnce({
        status: 'EXECUTED',
        executionId: 'exec_2',
        output: { pdf: 'url' },
      })
      .mockResolvedValueOnce({
        status: 'EXECUTED',
        executionId: 'exec_3',
        output: { refs: ['A'] },
      });

    const result = await executePlaybook({
      pack,
      playbookStableId: 'contract_redline_review_v1',
      inputs: {
        contractId: 'ctr_1',
      },
      executionContext: baseExecutionContext,
      correlationId: 'corr_1',
      registry: { execute },
    });

    expect(result.status).toBe('COMPLETED');
    expect(result.executedSteps).toHaveLength(3);
    expect(execute.mock.calls.map((row) => row[0])).toEqual([
      'contract.redline.generate',
      'contract.draft.generatePdf',
      'contract.references.extract',
    ]);
  });

  it('stops and returns NEEDS_APPROVAL on QUEUED_APPROVAL', async () => {
    const pack = await loadPackFromDir(fixturePackDir);
    validatePack(pack);

    const execute = vi.fn<PlaybookToolAdapter['execute']>()
      .mockResolvedValueOnce({
        status: 'EXECUTED',
        executionId: 'exec_1',
        output: { ok: true },
      })
      .mockResolvedValueOnce({
        status: 'QUEUED_APPROVAL',
        executionId: 'exec_2',
        approvalRequestId: 'approval_2',
        requiredApprovals: 1,
      });

    const result = await executePlaybook({
      pack,
      playbookStableId: 'contract_redline_review_v1',
      inputs: { contractId: 'ctr_2' },
      executionContext: baseExecutionContext,
      correlationId: 'corr_2',
      registry: { execute },
    });

    expect(result.status).toBe('NEEDS_APPROVAL');
    expect(result.approval?.approvalRequestId).toBe('approval_2');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('stops and returns BLOCKED on BLOCKED tool result', async () => {
    const pack = await loadPackFromDir(fixturePackDir);
    validatePack(pack);

    const execute = vi.fn<PlaybookToolAdapter['execute']>()
      .mockResolvedValueOnce({
        status: 'BLOCKED',
        executionId: 'exec_b',
        reason: 'policy denied',
      });

    const result = await executePlaybook({
      pack,
      playbookStableId: 'contract_redline_review_v1',
      inputs: { contractId: 'ctr_3' },
      executionContext: baseExecutionContext,
      correlationId: 'corr_3',
      registry: { execute },
    });

    expect(result.status).toBe('BLOCKED');
    expect(result.error?.code).toBe('PLAYBOOK_STEP_BLOCKED');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('stops and returns FAILED on FAILED tool result', async () => {
    const pack = await loadPackFromDir(fixturePackDir);
    validatePack(pack);

    const execute = vi.fn<PlaybookToolAdapter['execute']>()
      .mockResolvedValueOnce({
        status: 'FAILED',
        executionId: 'exec_f',
        error: 'handler failure',
        errorCode: 'TOOL_HANDLER_FAILED',
        recoverable: false,
      });

    const result = await executePlaybook({
      pack,
      playbookStableId: 'contract_redline_review_v1',
      inputs: { contractId: 'ctr_4' },
      executionContext: baseExecutionContext,
      correlationId: 'corr_4',
      registry: { execute },
    });

    expect(result.status).toBe('FAILED');
    expect(result.error?.code).toBe('TOOL_HANDLER_FAILED');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not auto-retry HIGH risk steps even when recoverable', async () => {
    const { tempDir, packDir } = await copyFixtureToTemp();
    tempRoots.push(tempDir);

    const skillPath = join(packDir, 'skills', 'contract_redline_skill_v1.json');
    const skill = JSON.parse(await readFile(skillPath, 'utf8')) as Record<string, unknown>;
    const toolSequence = Array.isArray(skill.toolSequence) ? [...skill.toolSequence] : [];
    toolSequence[1] = {
      ...(toolSequence[1] as Record<string, unknown>),
      riskLevel: 'HIGH',
      retryOnRecoverableFailure: true,
    };
    skill.toolSequence = toolSequence;
    await writeFile(skillPath, `${JSON.stringify(skill, null, 2)}\n`, 'utf8');

    const pack = await loadPackFromDir(packDir);
    validatePack(pack);

    const execute = vi.fn<PlaybookToolAdapter['execute']>()
      .mockResolvedValueOnce({
        status: 'EXECUTED',
        executionId: 'exec_1',
        output: { ok: true },
      })
      .mockResolvedValueOnce({
        status: 'FAILED',
        executionId: 'exec_2',
        error: 'recoverable fail',
        errorCode: 'RECOVERABLE_FAIL',
        recoverable: true,
      });

    const result = await executePlaybook({
      pack,
      playbookStableId: 'contract_redline_review_v1',
      inputs: { contractId: 'ctr_high_risk' },
      executionContext: baseExecutionContext,
      correlationId: 'corr_high_risk',
      registry: { execute },
    });

    expect(result.status).toBe('FAILED');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('fails when finalResult does not match results schema', async () => {
    const { tempDir, packDir } = await copyFixtureToTemp();
    tempRoots.push(tempDir);

    const resultsSchemaPath = join(packDir, 'schema', 'results.schema.json');
    const strictSchema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      additionalProperties: false,
      required: ['diffSummary'],
      properties: {
        diffSummary: { type: 'string', minLength: 1 },
        references: {
          type: 'array',
          items: { type: 'string' },
        },
        lastOutput: { type: 'object' },
      },
    };
    await writeFile(resultsSchemaPath, `${JSON.stringify(strictSchema, null, 2)}\n`, 'utf8');

    const pack = await loadPackFromDir(packDir);
    validatePack(pack);

    const execute = vi.fn<PlaybookToolAdapter['execute']>()
      .mockResolvedValue({
        status: 'EXECUTED',
        executionId: 'exec_schema',
        output: {},
      });

    const result = await executePlaybook({
      pack,
      playbookStableId: 'contract_redline_review_v1',
      inputs: { contractId: 'ctr_schema' },
      executionContext: baseExecutionContext,
      correlationId: 'corr_schema',
      registry: { execute },
    });

    expect(result.status).toBe('FAILED');
    expect(result.error?.code).toBe('RESULT_SCHEMA_VALIDATION_FAILED');
  });

  it('fails when playbook requires a result schema but schema file is missing', async () => {
    const { tempDir, packDir } = await copyFixtureToTemp();
    tempRoots.push(tempDir);

    await rm(join(packDir, 'schema', 'results.schema.json'));

    const pack = await loadPackFromDir(packDir);
    validatePack(pack);

    const execute = vi.fn<PlaybookToolAdapter['execute']>()
      .mockResolvedValue({
        status: 'EXECUTED',
        executionId: 'exec_no_schema',
        output: { diffSummary: 'ok' },
      });

    const result = await executePlaybook({
      pack,
      playbookStableId: 'contract_redline_review_v1',
      inputs: { contractId: 'ctr_no_schema' },
      executionContext: baseExecutionContext,
      correlationId: 'corr_no_schema',
      registry: { execute },
    });

    expect(result.status).toBe('FAILED');
    expect(result.error?.code).toBe('RESULT_SCHEMA_MISSING');
  });

  it('enforces max step limit', async () => {
    const pack = await loadPackFromDir(fixturePackDir);
    validatePack(pack);

    const execute = vi.fn<PlaybookToolAdapter['execute']>()
      .mockResolvedValue({
        status: 'EXECUTED',
        executionId: 'exec_max',
        output: {},
      });

    const result = await executePlaybook({
      pack,
      playbookStableId: 'contract_redline_review_v1',
      inputs: { contractId: 'ctr_max' },
      executionContext: baseExecutionContext,
      correlationId: 'corr_max',
      registry: { execute },
      maxSteps: 1,
    });

    expect(result.status).toBe('FAILED');
    expect(result.error?.code).toBe('PLAYBOOK_MAX_STEPS_EXCEEDED');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('fails deterministically when a step payload exceeds maxStepPayloadBytes', async () => {
    const pack = await loadPackFromDir(fixturePackDir);
    validatePack(pack);

    const execute = vi.fn<PlaybookToolAdapter['execute']>()
      .mockResolvedValue({
        status: 'EXECUTED',
        executionId: 'exec_payload',
        output: {},
      });

    const result = await executePlaybook({
      pack,
      playbookStableId: 'contract_redline_review_v1',
      inputs: {
        contractId: 'ctr_payload',
        largeBlob: 'x'.repeat(2048),
      },
      executionContext: baseExecutionContext,
      correlationId: 'corr_payload',
      registry: { execute },
      maxStepPayloadBytes: 512,
    });

    expect(result.status).toBe('FAILED');
    expect(result.error?.code).toBe('PLAYBOOK_STEP_PAYLOAD_TOO_LARGE');
    expect(result.executedSteps).toHaveLength(1);
    expect(result.executedSteps[0]?.outcome).toBe('FAILED');
    expect(result.executedSteps[0]?.data).toMatchObject({
      errorCode: 'PLAYBOOK_STEP_PAYLOAD_TOO_LARGE',
      maxStepPayloadBytes: 512,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails deterministically when a step payload exceeds maxStepPayloadDepth', async () => {
    const pack = await loadPackFromDir(fixturePackDir);
    validatePack(pack);

    const execute = vi.fn<PlaybookToolAdapter['execute']>()
      .mockResolvedValue({
        status: 'EXECUTED',
        executionId: 'exec_payload_depth',
        output: {},
      });

    const result = await executePlaybook({
      pack,
      playbookStableId: 'contract_redline_review_v1',
      inputs: {
        contractId: 'ctr_payload_depth',
        nested: { a: { b: { c: { d: { e: true } } } } },
      },
      executionContext: baseExecutionContext,
      correlationId: 'corr_payload_depth',
      registry: { execute },
      maxStepPayloadDepth: 4,
    });

    expect(result.status).toBe('FAILED');
    expect(result.error?.code).toBe('PLAYBOOK_STEP_PAYLOAD_SHAPE_INVALID');
    expect(result.executedSteps).toHaveLength(1);
    expect(result.executedSteps[0]?.outcome).toBe('FAILED');
    expect(result.executedSteps[0]?.data).toMatchObject({
      errorCode: 'PLAYBOOK_STEP_PAYLOAD_SHAPE_INVALID',
      reason: 'MAX_DEPTH_EXCEEDED',
      maxStepPayloadDepth: 4,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('generates deterministic requestId for same inputs and different values for different correlationId', async () => {
    const pack = await loadPackFromDir(fixturePackDir);
    validatePack(pack);

    const execute = vi.fn<PlaybookToolAdapter['execute']>()
      .mockResolvedValue({
        status: 'EXECUTED',
        executionId: 'exec_x',
        output: {},
      });

    await executePlaybook({
      pack,
      playbookStableId: 'contract_redline_review_v1',
      inputs: { contractId: 'ctr_same' },
      executionContext: baseExecutionContext,
      correlationId: 'corr_same',
      registry: { execute },
    });
    const firstRequestId = (execute.mock.calls[0]?.[1] as Record<string, unknown>).requestId;

    execute.mockClear();
    await executePlaybook({
      pack,
      playbookStableId: 'contract_redline_review_v1',
      inputs: { contractId: 'ctr_same' },
      executionContext: baseExecutionContext,
      correlationId: 'corr_same',
      registry: { execute },
    });
    const secondRequestId = (execute.mock.calls[0]?.[1] as Record<string, unknown>).requestId;

    execute.mockClear();
    await executePlaybook({
      pack,
      playbookStableId: 'contract_redline_review_v1',
      inputs: { contractId: 'ctr_same' },
      executionContext: baseExecutionContext,
      correlationId: 'corr_diff',
      registry: { execute },
    });
    const thirdRequestId = (execute.mock.calls[0]?.[1] as Record<string, unknown>).requestId;

    expect(firstRequestId).toBe(secondRequestId);
    expect(thirdRequestId).not.toBe(firstRequestId);
  });

  it('fails when requested packVersion mismatches loaded pack version', async () => {
    const pack = await loadPackFromDir(fixturePackDir);
    validatePack(pack);

    const execute = vi.fn<PlaybookToolAdapter['execute']>();
    const result = await executePlaybook({
      pack,
      packVersion: '9.9.9',
      playbookStableId: 'contract_redline_review_v1',
      inputs: { contractId: 'ctr_mismatch' },
      executionContext: baseExecutionContext,
      correlationId: 'corr_mismatch',
      registry: { execute },
    });

    expect(result.status).toBe('FAILED');
    expect(result.error?.code).toBe('PACK_VERSION_MISMATCH');
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails deterministicly when a step exceeds maxStepExecutionMs', async () => {
    vi.useFakeTimers();
    try {
      const pack = await loadPackFromDir(fixturePackDir);
      validatePack(pack);

      const execute = vi.fn<PlaybookToolAdapter['execute']>().mockImplementation(
        () => new Promise(() => {}),
      );

      const pending = executePlaybook({
        pack,
        playbookStableId: 'contract_redline_review_v1',
        inputs: { contractId: 'ctr_timeout' },
        executionContext: baseExecutionContext,
        correlationId: 'corr_timeout',
        registry: { execute },
        maxStepExecutionMs: 50,
      });

      await vi.advanceTimersByTimeAsync(50);
      const result = await pending;

      expect(result.status).toBe('FAILED');
      expect(result.error?.code).toBe('PLAYBOOK_STEP_TIMEOUT');
      expect(result.executedSteps).toHaveLength(1);
      expect(result.executedSteps[0]?.outcome).toBe('FAILED');
      expect(result.executedSteps[0]?.data).toMatchObject({
        errorCode: 'PLAYBOOK_STEP_TIMEOUT',
        timeoutMs: 50,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails deterministically when retry-once step exceeds maxStepExecutionMs', async () => {
    vi.useFakeTimers();
    try {
      const { tempDir, packDir } = await copyFixtureToTemp();
      tempRoots.push(tempDir);

      const skillPath = join(packDir, 'skills', 'contract_redline_skill_v1.json');
      const skill = JSON.parse(await readFile(skillPath, 'utf8')) as Record<string, unknown>;
      const toolSequence = Array.isArray(skill.toolSequence) ? [...skill.toolSequence] : [];
      toolSequence[0] = {
        ...(toolSequence[0] as Record<string, unknown>),
        riskLevel: 'LOW',
        retryOnRecoverableFailure: true,
      };
      skill.toolSequence = toolSequence;
      await writeFile(skillPath, `${JSON.stringify(skill, null, 2)}\n`, 'utf8');

      const pack = await loadPackFromDir(packDir);
      validatePack(pack);

      const execute = vi.fn<PlaybookToolAdapter['execute']>()
        .mockResolvedValueOnce({
          status: 'FAILED',
          executionId: 'exec_retry_fail',
          error: 'temporary fail',
          errorCode: 'TEMP_FAIL',
          recoverable: true,
        })
        .mockImplementationOnce(() => new Promise(() => {}));

      const pending = executePlaybook({
        pack,
        playbookStableId: 'contract_redline_review_v1',
        inputs: { contractId: 'ctr_retry_timeout' },
        executionContext: baseExecutionContext,
        correlationId: 'corr_retry_timeout',
        registry: { execute },
        maxStepExecutionMs: 50,
      });

      await vi.advanceTimersByTimeAsync(50);
      const result = await pending;

      expect(result.status).toBe('FAILED');
      expect(result.error?.code).toBe('PLAYBOOK_STEP_TIMEOUT');
      expect(result.executedSteps).toHaveLength(1);
      expect(result.executedSteps[0]?.outcome).toBe('FAILED');
      expect(result.executedSteps[0]?.data).toMatchObject({
        errorCode: 'PLAYBOOK_STEP_TIMEOUT',
        timeoutMs: 50,
      });
      expect(execute).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
