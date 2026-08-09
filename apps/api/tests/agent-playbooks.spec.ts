import { randomUUID } from 'node:crypto';
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

import { ActorType } from '@prisma/client';
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  assertPlaybookInputSize,
  executePlaybook,
  loadPlaybookPack,
  PlaybookInputTooLargeError,
  PlaybookPackValidationError,
  type PlaybookRegistryLike,
} from '../src/agent-playbooks.js';

const fixturesBaseDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'agent-playbooks');
const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const packId = 'mbs_agent_v1_1';

const baseExecutionContext = {
  orgId: 'org_test',
  actorType: ActorType.HUMAN,
  actorUserId: 'user_test',
  actorLabel: 'Agent Playbook Test',
  isAutonomous: false,
  correlationId: 'corr-fixed-test',
} as const;

async function createTempPackCopy(): Promise<{ tempRoot: string; packPath: string }> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'mbs-agent-pack-'));
  const sourceDir = join(fixturesBaseDir, packId);
  const destDir = join(tempRoot, packId);
  await cp(sourceDir, destDir, { recursive: true });
  return {
    tempRoot,
    packPath: destDir,
  };
}

describe('agent playbooks pack v1.1', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.map(async (dir) => {
        await rm(dir, { recursive: true, force: true });
      }),
    );
    tempRoots.length = 0;
  });

  it('loads and validates mbs_agent_v1_1 pack fixtures', async () => {
    const pack = await loadPlaybookPack({
      packId,
      baseDir: fixturesBaseDir,
    });

    expect(pack.packId).toBe(packId);
    expect(pack.playbooksByStableId.has('contract_redline_review_v1_1')).toBe(true);
    expect(pack.playbooksByStableId.has('admin_template_publish')).toBe(true);
    expect(pack.skillsByStableId.has('contract_redline_generate_skill_v1_1')).toBe(true);
  });

  it('rejects symlinked pack files when loading from explicit fixture directories', async () => {
    const { tempRoot, packPath } = await createTempPackCopy();
    tempRoots.push(tempRoot);

    const originalPath = join(packPath, 'tools_catalog.json');
    const movedPath = join(packPath, 'tools_catalog.real.json');
    await rename(originalPath, movedPath);
    await symlink('tools_catalog.real.json', originalPath);

    await expect(
      loadPlaybookPack({
        packId,
        baseDir: tempRoot,
      }),
    ).rejects.toThrow(/Symlinked pack files are not allowed/i);
  });

  it('enforces manifest integrity when loading runtime default pack path', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'mbs-agent-manifest-'));
    tempRoots.push(tempRoot);

    const manifestPath = join(tempRoot, 'EXTERNAL_PACKS_MANIFEST.json');
    const manifest = JSON.parse(
      await readFile(join(fixturesRoot, 'EXTERNAL_PACKS_MANIFEST.json'), 'utf8'),
    ) as {
      packs?: Array<Record<string, unknown>>;
    };
    const packEntry = (manifest.packs ?? []).find((row) => row.id === packId);
    if (!packEntry) {
      throw new Error(`Missing ${packId} manifest fixture entry`);
    }
    packEntry.packSha256 = '0000000000000000000000000000000000000000000000000000000000000000';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const previousManifestPath = process.env.EXTERNAL_PACKS_MANIFEST_PATH;
    const previousEnforce = process.env.AGENT_PLAYBOOK_ENFORCE_MANIFEST;
    process.env.EXTERNAL_PACKS_MANIFEST_PATH = manifestPath;
    process.env.AGENT_PLAYBOOK_ENFORCE_MANIFEST = 'true';

    try {
      await expect(loadPlaybookPack({ packId })).rejects.toThrow(/integrity mismatch/i);
    } finally {
      process.env.EXTERNAL_PACKS_MANIFEST_PATH = previousManifestPath;
      process.env.AGENT_PLAYBOOK_ENFORCE_MANIFEST = previousEnforce;
    }
  });

  it('fails validation when READY playbook references an unknown toolSequence.toolName', async () => {
    const { tempRoot, packPath } = await createTempPackCopy();
    tempRoots.push(tempRoot);

    const skillPath = join(packPath, 'skills', 'contract_redline_generate_skill_v1_1.json');
    const rawSkill = await readFile(skillPath, 'utf8');
    const skill = JSON.parse(rawSkill) as Record<string, unknown>;
    const toolSequence = Array.isArray(skill.toolSequence) ? [...skill.toolSequence] : [];
    toolSequence[0] = {
      ...(toolSequence[0] as Record<string, unknown>),
      toolName: 'contract.redline.unknownTool',
    };
    skill.toolSequence = toolSequence;
    await writeFile(skillPath, `${JSON.stringify(skill, null, 2)}\n`, 'utf8');

    await expect(
      loadPlaybookPack({
        packId,
        baseDir: tempRoot,
      }),
    ).rejects.toBeInstanceOf(PlaybookPackValidationError);
  });

  it('rejects invalid packId values before resolving pack paths', async () => {
    await expect(
      loadPlaybookPack({
        packId: '../mbs_agent_v1_1',
      }),
    ).rejects.toThrow(/Invalid packId/i);
  });

  it('rejects unknown packId when it is not present in external pack manifest', async () => {
    await expect(
      loadPlaybookPack({
        packId: 'mbs_agent_v9_9',
      }),
    ).rejects.toThrow(/missing from external packs manifest/i);
  });

  it('enforces deterministic playbook input byte limits', () => {
    expect(() =>
      assertPlaybookInputSize(
        {
          contractId: 'ctr_100',
          notes: 'ok',
        },
        128,
      ),
    ).not.toThrow();

    expect(() =>
      assertPlaybookInputSize(
        {
          contractText: 'x'.repeat(512),
        },
        128,
      ),
    ).toThrow(PlaybookInputTooLargeError);
  });

  it('ignores literal "undefined" env values for manifest and packs directory paths', async () => {
    const previousManifest = process.env.EXTERNAL_PACKS_MANIFEST_PATH;
    const previousPacksDir = process.env.AGENT_PLAYBOOK_PACKS_DIR;
    process.env.EXTERNAL_PACKS_MANIFEST_PATH = 'undefined';
    process.env.AGENT_PLAYBOOK_PACKS_DIR = 'undefined';
    try {
      const pack = await loadPlaybookPack({ packId });
      expect(pack.packId).toBe(packId);
    } finally {
      process.env.EXTERNAL_PACKS_MANIFEST_PATH = previousManifest;
      process.env.AGENT_PLAYBOOK_PACKS_DIR = previousPacksDir;
    }
  });

  it('rejects pack when tools_catalog packId does not match requested packId', async () => {
    const { tempRoot, packPath } = await createTempPackCopy();
    tempRoots.push(tempRoot);

    const toolsCatalogPath = join(packPath, 'tools_catalog.json');
    const toolsCatalog = JSON.parse(
      await readFile(toolsCatalogPath, 'utf8'),
    ) as Record<string, unknown>;
    toolsCatalog.packId = 'tampered_pack_id';
    await writeFile(
      toolsCatalogPath,
      `${JSON.stringify(toolsCatalog, null, 2)}\n`,
      'utf8',
    );

    await expect(
      loadPlaybookPack({
        packId,
        baseDir: tempRoot,
      }),
    ).rejects.toThrow(/Pack identity mismatch/i);
  });

  it('blocks SPEC_ONLY execution with PLAYBOOK_SPEC_ONLY and does not call tools', async () => {
    const pack = await loadPlaybookPack({
      packId,
      baseDir: fixturesBaseDir,
    });
    const execute = vi.fn<PlaybookRegistryLike['execute']>();

    const result = await executePlaybook({
      pack,
      playbookStableId: 'admin_template_publish',
      inputs: {
        templateId: 'tpl_123',
      },
      registry: {
        execute,
      },
      context: baseExecutionContext,
      correlationId: baseExecutionContext.correlationId,
    });

    expect(result.status).toBe('BLOCKED');
    expect(result.error?.code).toBe('PLAYBOOK_SPEC_ONLY');
    expect(result.missingTools).toEqual([
      'admin.template.publish',
      'admin.template.promote',
    ]);
    expect(result.executedSteps).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it('executes READY playbook tool sequence in order and returns completed summary', async () => {
    const pack = await loadPlaybookPack({
      packId,
      baseDir: fixturesBaseDir,
    });

    const execute = vi.fn<PlaybookRegistryLike['execute']>()
      .mockResolvedValueOnce({
        status: 'EXECUTED',
        executionId: 'exec_1',
        output: {
          diffSummary: 'Updated payment terms and warranty clause',
          references: ['Section 2.1', 'Section 5.4'],
        },
      })
      .mockResolvedValueOnce({
        status: 'EXECUTED',
        executionId: 'exec_2',
        output: {
          pdfUrl: 'https://example.test/redline.pdf',
        },
      })
      .mockResolvedValueOnce({
        status: 'EXECUTED',
        executionId: 'exec_3',
        output: {
          references: ['Exhibit A'],
        },
      });

    const result = await executePlaybook({
      pack,
      playbookStableId: 'contract_redline_review_v1_1',
      inputs: {
        contractId: 'ctr_101',
        contractText: 'Example contract body',
      },
      registry: {
        execute,
      },
      context: baseExecutionContext,
      correlationId: baseExecutionContext.correlationId,
    });

    expect(result.status).toBe('COMPLETED');
    expect(execute.mock.calls.map((row) => row[0])).toEqual([
      'contract.redline.generate',
      'contract.draft.generatePdf',
      'contract.references.extract',
    ]);
    expect(result.finalResult?.diffSummary).toBe('Updated payment terms and warranty clause');
    expect(result.finalResult?.references).toEqual([
      'Section 2.1',
      'Section 5.4',
      'Exhibit A',
    ]);
  });

  it('returns NEEDS_APPROVAL and stops on queued approval', async () => {
    const pack = await loadPlaybookPack({
      packId,
      baseDir: fixturesBaseDir,
    });

    const execute = vi.fn<PlaybookRegistryLike['execute']>()
      .mockResolvedValueOnce({
        status: 'EXECUTED',
        executionId: 'exec_1',
        output: { diffSummary: 'Any' },
      })
      .mockResolvedValueOnce({
        status: 'QUEUED_APPROVAL',
        executionId: 'exec_2',
        approvalRequestId: 'approval_2',
        requiredApprovals: 1,
      });

    const result = await executePlaybook({
      pack,
      playbookStableId: 'contract_redline_review_v1_1',
      inputs: {
        contractId: randomUUID(),
      },
      registry: {
        execute,
      },
      context: baseExecutionContext,
      correlationId: baseExecutionContext.correlationId,
    });

    expect(result.status).toBe('NEEDS_APPROVAL');
    expect(result.approval?.approvalRequestId).toBe('approval_2');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('returns BLOCKED or FAILED and stops execution on tool halt statuses', async () => {
    const pack = await loadPlaybookPack({
      packId,
      baseDir: fixturesBaseDir,
    });

    const blockedExecute = vi.fn<PlaybookRegistryLike['execute']>()
      .mockResolvedValueOnce({
        status: 'BLOCKED',
        executionId: 'exec_blocked',
        reason: 'Policy denied this tool',
      });

    const blockedResult = await executePlaybook({
      pack,
      playbookStableId: 'contract_redline_review_v1_1',
      inputs: { contractId: 'blocked' },
      registry: { execute: blockedExecute },
      context: baseExecutionContext,
      correlationId: baseExecutionContext.correlationId,
    });

    expect(blockedResult.status).toBe('BLOCKED');
    expect(blockedResult.error?.code).toBe('PLAYBOOK_STEP_BLOCKED');
    expect(blockedExecute).toHaveBeenCalledTimes(1);

    const failedExecute = vi.fn<PlaybookRegistryLike['execute']>()
      .mockResolvedValueOnce({
        status: 'FAILED',
        executionId: 'exec_failed',
        error: 'Tool handler error',
        errorCode: 'TOOL_HANDLER_ERROR',
      });

    const failedResult = await executePlaybook({
      pack,
      playbookStableId: 'contract_redline_review_v1_1',
      inputs: { contractId: 'failed' },
      registry: { execute: failedExecute },
      context: baseExecutionContext,
      correlationId: baseExecutionContext.correlationId,
    });

    expect(failedResult.status).toBe('FAILED');
    expect(failedResult.error?.code).toBe('TOOL_HANDLER_ERROR');
    expect(failedExecute).toHaveBeenCalledTimes(1);
  });

  it('rejects execution when correlationId is absent from args and context', async () => {
    const pack = await loadPlaybookPack({
      packId,
      baseDir: fixturesBaseDir,
    });

    const execute = vi.fn<PlaybookRegistryLike['execute']>()
      .mockResolvedValue({
        status: 'EXECUTED',
        executionId: 'exec_unused',
        output: {},
      });

    await expect(
      executePlaybook({
        pack,
        playbookStableId: 'contract_redline_review_v1_1',
        inputs: { contractId: 'ctr_missing_corr' },
        registry: { execute },
        context: {
          ...baseExecutionContext,
          correlationId: undefined,
        },
        correlationId: undefined,
      }),
    ).rejects.toThrow(/correlationId is required/i);

    expect(execute).not.toHaveBeenCalled();
  });

  it('generates deterministic requestId when skill requests deterministic IDs', async () => {
    const pack = await loadPlaybookPack({
      packId,
      baseDir: fixturesBaseDir,
    });

    const execute = vi.fn<PlaybookRegistryLike['execute']>()
      .mockResolvedValue({
        status: 'EXECUTED',
        executionId: 'exec_ok',
        output: {},
      });

    const args = {
      pack,
      playbookStableId: 'contract_redline_review_v1_1',
      inputs: {
        contractId: 'ctr_same',
        contractText: 'same payload',
      },
      registry: { execute },
      context: baseExecutionContext,
      correlationId: baseExecutionContext.correlationId,
    } as const;

    await executePlaybook(args);
    const firstPayload = execute.mock.calls[0]?.[1] as Record<string, unknown>;
    const firstRequestId = firstPayload.requestId;
    expect(typeof firstRequestId).toBe('string');

    execute.mockClear();
    await executePlaybook(args);
    const secondPayload = execute.mock.calls[0]?.[1] as Record<string, unknown>;
    const secondRequestId = secondPayload.requestId;

    expect(secondRequestId).toBe(firstRequestId);
  });
});
