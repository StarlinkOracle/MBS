import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  cp,
  mkdir,
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
} from 'vitest';

import {
  downloadRepoArchive,
  computePackContentSha256,
  executeLegalPackImport,
  loadLegalPackArtifacts,
  resolvePackDirectory,
  verifyPackContentFromManifest,
  verifyPackContentSha256,
  validateLegalPackArtifacts,
  type RegistryLike,
} from '../src/legal-pack-importer.js';

const fixturesRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'legal-packs',
);
const coPackRoot = join(fixturesRoot, 'CO', 'v1');

const baseContext = {
  orgId: 'org_test',
  actorType: ActorType.SYSTEM,
  actorLabel: 'legal-pack-importer-test',
  isAutonomous: false,
} as const;

type MockState = {
  clauses: Map<string, { status: 'DRAFT' | 'PUBLISHED' | 'DEPRECATED' }>;
  templates: Map<string, { status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' }>;
  legalPacks: Set<string>;
  createdClauseCount: number;
  createdTemplateCount: number;
  calls: Array<{
    toolName: string;
    payload: Record<string, unknown>;
  }>;
};

function key(stableId: string, version: number): string {
  return `${stableId}:v${version}`;
}

function createMockRegistry(state: MockState): RegistryLike {
  let execCounter = 0;
  const nextExecId = () => `exec_${++execCounter}`;

  return {
    execute: async (toolName, payload) => {
      state.calls.push({ toolName, payload });

      if (toolName === 'contract.clause.createDraft') {
        const stableId = String(payload.stableId);
        const version = Number(payload.version);
        const recordKey = key(stableId, version);
        const existing = state.clauses.get(recordKey);
        if (existing) {
          return {
            status: 'EXECUTED',
            executionId: nextExecId(),
            output: {
              clause: {
                stableId,
                version,
                status: existing.status,
              },
              idempotent: true,
            },
          };
        }
        state.clauses.set(recordKey, { status: 'DRAFT' });
        state.createdClauseCount += 1;
        return {
          status: 'EXECUTED',
          executionId: nextExecId(),
          output: {
            clause: {
              stableId,
              version,
              status: 'DRAFT',
            },
            idempotent: false,
          },
        };
      }

      if (toolName === 'contract.clause.updateDraft') {
        const stableId = String(payload.stableId);
        const version = Number(payload.version);
        const recordKey = key(stableId, version);
        const existing = state.clauses.get(recordKey);
        if (!existing) {
          return {
            status: 'FAILED',
            executionId: nextExecId(),
            error: `Missing clause ${recordKey}`,
            errorCode: 'MISSING',
          };
        }
        return {
          status: 'EXECUTED',
          executionId: nextExecId(),
          output: {
            clause: {
              stableId,
              version,
              status: existing.status,
            },
          },
        };
      }

      if (toolName === 'contract.clause.publish') {
        const stableId = String(payload.stableId);
        const version = Number(payload.version);
        const recordKey = key(stableId, version);
        state.clauses.set(recordKey, { status: 'PUBLISHED' });
        return {
          status: 'EXECUTED',
          executionId: nextExecId(),
          output: {
            clause: {
              stableId,
              version,
              status: 'PUBLISHED',
            },
          },
        };
      }

      if (toolName === 'contract.template.createDraft') {
        const templateStableId = String(payload.templateStableId);
        const version = Number(payload.version);
        const recordKey = key(templateStableId, version);
        const existing = state.templates.get(recordKey);
        if (existing) {
          return {
            status: 'EXECUTED',
            executionId: nextExecId(),
            output: {
              template: {
                templateStableId,
                version,
                status: existing.status,
              },
              idempotent: true,
            },
          };
        }
        state.templates.set(recordKey, { status: 'DRAFT' });
        state.createdTemplateCount += 1;
        return {
          status: 'EXECUTED',
          executionId: nextExecId(),
          output: {
            template: {
              templateStableId,
              version,
              status: 'DRAFT',
            },
            idempotent: false,
          },
        };
      }

      if (
        toolName === 'contract.template.updateStructure' ||
        toolName === 'contract.template.updateVariableSchema'
      ) {
        const templateStableId = String(payload.templateStableId);
        const version = Number(payload.version);
        const recordKey = key(templateStableId, version);
        const existing = state.templates.get(recordKey);
        if (!existing) {
          return {
            status: 'FAILED',
            executionId: nextExecId(),
            error: `Missing template ${recordKey}`,
            errorCode: 'MISSING',
          };
        }
        return {
          status: 'EXECUTED',
          executionId: nextExecId(),
          output: {
            template: {
              templateStableId,
              version,
              status: existing.status,
            },
          },
        };
      }

      if (toolName === 'contract.template.publish') {
        const templateStableId = String(payload.templateStableId);
        const version = Number(payload.version);
        const recordKey = key(templateStableId, version);
        state.templates.set(recordKey, { status: 'PUBLISHED' });
        return {
          status: 'EXECUTED',
          executionId: nextExecId(),
          output: {
            template: {
              templateStableId,
              version,
              status: 'PUBLISHED',
            },
          },
        };
      }

      if (toolName === 'contract.legalPack.upsert') {
        const packStableId = String(payload.packStableId);
        const version = String(payload.version);
        state.legalPacks.add(`${packStableId}:${version}`);
        return {
          status: 'EXECUTED',
          executionId: nextExecId(),
          output: {
            legalPack: {
              packStableId,
              version,
            },
          },
        };
      }

      return {
        status: 'FAILED',
        executionId: nextExecId(),
        error: `Unsupported tool ${toolName}`,
        errorCode: 'UNSUPPORTED_TOOL',
      };
    },
  };
}

async function createTempFixtureCopy(): Promise<{ tempDir: string; packDir: string }> {
  const tempDir = await mkdtemp(join(tmpdir(), 'legal-pack-fixture-'));
  const dest = join(tempDir, 'CO', 'v1');
  await cp(coPackRoot, dest, { recursive: true });
  return {
    tempDir,
    packDir: dest,
  };
}

describe('legal pack importer (offline fixtures)', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map(async (dir) => rm(dir, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
  });

  it('loads and validates CO/v1 fixture pack', async () => {
    const artifacts = await loadLegalPackArtifacts(coPackRoot);
    const validation = validateLegalPackArtifacts(artifacts);

    expect(validation.clauseStableIds).toEqual([
      'co_payment_terms',
      'co_warranty_notice',
    ]);
    expect(validation.templateStableIds).toEqual(['co_install_contract_standard']);
  });

  it('fails validation when placeholder whitelist is violated', async () => {
    const copy = await createTempFixtureCopy();
    tempDirs.push(copy.tempDir);

    const clausesPath = join(copy.packDir, 'clauses.json');
    const clauses = JSON.parse(await readFile(clausesPath, 'utf8')) as Array<Record<string, unknown>>;
    clauses[0].bodyText = 'Unsupported placeholder {{unknown.placeholder}}';
    await writeFile(clausesPath, `${JSON.stringify(clauses, null, 2)}\n`, 'utf8');

    const artifacts = await loadLegalPackArtifacts(copy.packDir);
    expect(() => validateLegalPackArtifacts(artifacts)).toThrow(
      /Unknown placeholders not in whitelist/i,
    );
  });

  it('fails validation when a duplicate clause stableId exists', async () => {
    const copy = await createTempFixtureCopy();
    tempDirs.push(copy.tempDir);

    const clausesPath = join(copy.packDir, 'clauses.json');
    const clauses = JSON.parse(await readFile(clausesPath, 'utf8')) as Array<Record<string, unknown>>;
    clauses.push({
      ...clauses[0],
      title: 'Duplicate title',
    });
    await writeFile(clausesPath, `${JSON.stringify(clauses, null, 2)}\n`, 'utf8');

    const artifacts = await loadLegalPackArtifacts(copy.packDir);
    expect(() => validateLegalPackArtifacts(artifacts)).toThrow(/Duplicate clause stableId/i);
  });

  it('supports wildcard legal-pack file names from artifact repo conventions', async () => {
    const copy = await createTempFixtureCopy();
    tempDirs.push(copy.tempDir);

    await Promise.all([
      rename(join(copy.packDir, 'clauses.json'), join(copy.packDir, 'clauses_co_v1.json')),
      rename(join(copy.packDir, 'templates.json'), join(copy.packDir, 'templates_co_v1.json')),
      rename(
        join(copy.packDir, 'variable_schemas.json'),
        join(copy.packDir, 'variable_schemas_co_v1.json'),
      ),
    ]);

    const artifacts = await loadLegalPackArtifacts(copy.packDir);
    const validation = validateLegalPackArtifacts(artifacts);
    expect(validation.clauseStableIds).toContain('co_payment_terms');
    expect(validation.templateStableIds).toContain('co_install_contract_standard');
  });

  it('verifies deterministic pack content digest and detects tampering', async () => {
    const copy = await createTempFixtureCopy();
    tempDirs.push(copy.tempDir);

    const digest = await computePackContentSha256(copy.packDir);
    await verifyPackContentSha256({
      packDir: copy.packDir,
      expectedSha256: digest,
    });

    const legalPackPath = join(copy.packDir, 'legal_pack.json');
    const legalPack = JSON.parse(await readFile(legalPackPath, 'utf8')) as Record<string, unknown>;
    legalPack.name = `${String(legalPack.name ?? 'pack')} (tampered)`;
    await writeFile(legalPackPath, `${JSON.stringify(legalPack, null, 2)}\n`, 'utf8');

    await expect(
      verifyPackContentSha256({
        packDir: copy.packDir,
        expectedSha256: digest,
      }),
    ).rejects.toThrow(/Pack integrity mismatch/i);
  });

  it('verifies content digest from external manifest entry', async () => {
    const copy = await createTempFixtureCopy();
    tempDirs.push(copy.tempDir);

    const digest = await computePackContentSha256(copy.packDir);
    const manifestPath = join(copy.tempDir, 'manifest.json');
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          manifestVersion: 1,
          packs: [
            {
              id: 'co_legal_pack_v1',
              sourceRepo: 'StarlinkOracle/Artifacts-Legal-Packs',
              sourceRef: 'CO-v1.0.0',
              packContentSha256: digest,
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    await verifyPackContentFromManifest({
      packDir: copy.packDir,
      sourceRepo: 'StarlinkOracle/Artifacts-Legal-Packs',
      sourceRef: 'CO-v1.0.0',
      manifestPath,
    });
  });

  it('ingests in deterministic order and remains idempotent across reruns', async () => {
    const copy = await createTempFixtureCopy();
    tempDirs.push(copy.tempDir);

    const clausesPath = join(copy.packDir, 'clauses.json');
    const templatesPath = join(copy.packDir, 'templates.json');

    const clauses = JSON.parse(await readFile(clausesPath, 'utf8')) as Array<Record<string, unknown>>;
    const templates = JSON.parse(await readFile(templatesPath, 'utf8')) as Array<Record<string, unknown>>;

    await writeFile(clausesPath, `${JSON.stringify([...clauses].reverse(), null, 2)}\n`, 'utf8');
    await writeFile(templatesPath, `${JSON.stringify([...templates].reverse(), null, 2)}\n`, 'utf8');

    const artifacts = await loadLegalPackArtifacts(copy.packDir);
    validateLegalPackArtifacts(artifacts);

    const state: MockState = {
      clauses: new Map(),
      templates: new Map(),
      legalPacks: new Set(),
      createdClauseCount: 0,
      createdTemplateCount: 0,
      calls: [],
    };
    const registry = createMockRegistry(state);

    const first = await executeLegalPackImport({
      artifacts,
      registry,
      context: baseContext,
      repo: 'StarlinkOracle/Artifacts-Legal-Packs',
      tag: 'CO-v1.0.0',
    });
    const firstCalls = [...state.calls];

    const firstClauseCreates = firstCalls
      .filter((row) => row.toolName === 'contract.clause.createDraft')
      .map((row) => String(row.payload.stableId));
    const firstTemplateCreates = firstCalls
      .filter((row) => row.toolName === 'contract.template.createDraft')
      .map((row) => String(row.payload.templateStableId));

    expect(first.status).toBe('COMPLETED');
    expect(firstClauseCreates).toEqual(['co_payment_terms', 'co_warranty_notice']);
    expect(firstTemplateCreates).toEqual(['co_install_contract_standard']);
    expect(state.createdClauseCount).toBe(2);
    expect(state.createdTemplateCount).toBe(1);

    state.calls = [];
    const second = await executeLegalPackImport({
      artifacts,
      registry,
      context: baseContext,
      repo: 'StarlinkOracle/Artifacts-Legal-Packs',
      tag: 'CO-v1.0.0',
    });

    expect(second.status).toBe('COMPLETED');
    expect(second.batchRequestId).toBe(first.batchRequestId);
    expect(state.createdClauseCount).toBe(2);
    expect(state.createdTemplateCount).toBe(1);
  });

  it('does not mutate published versions on rerun', async () => {
    const artifacts = await loadLegalPackArtifacts(coPackRoot);
    validateLegalPackArtifacts(artifacts);

    const state: MockState = {
      clauses: new Map(),
      templates: new Map(),
      legalPacks: new Set(),
      createdClauseCount: 0,
      createdTemplateCount: 0,
      calls: [],
    };
    const registry = createMockRegistry(state);

    await executeLegalPackImport({
      artifacts,
      registry,
      context: baseContext,
      repo: 'StarlinkOracle/Artifacts-Legal-Packs',
      tag: 'CO-v1.0.0',
    });

    state.calls = [];
    const rerun = await executeLegalPackImport({
      artifacts,
      registry,
      context: baseContext,
      repo: 'StarlinkOracle/Artifacts-Legal-Packs',
      tag: 'CO-v1.0.0',
    });
    expect(rerun.status).toBe('COMPLETED');

    const clauseUpdateOnPublished = state.calls.some(
      (row) =>
        row.toolName === 'contract.clause.updateDraft' &&
        String(row.payload.stableId) === 'co_payment_terms',
    );
    const clausePublishOnPublished = state.calls.some(
      (row) =>
        row.toolName === 'contract.clause.publish' &&
        String(row.payload.stableId) === 'co_payment_terms',
    );
    const templateStructureOnPublished = state.calls.some(
      (row) =>
        row.toolName === 'contract.template.updateStructure' &&
        String(row.payload.templateStableId) === 'co_install_contract_standard',
    );
    const templatePublishOnPublished = state.calls.some(
      (row) =>
        row.toolName === 'contract.template.publish' &&
        String(row.payload.templateStableId) === 'co_install_contract_standard',
    );

    expect(clauseUpdateOnPublished).toBe(false);
    expect(clausePublishOnPublished).toBe(false);
    expect(templateStructureOnPublished).toBe(false);
    expect(templatePublishOnPublished).toBe(false);
  });

  it('blocks deterministically when governance preflight denies import', async () => {
    const artifacts = await loadLegalPackArtifacts(coPackRoot);
    validateLegalPackArtifacts(artifacts);

    const state: MockState = {
      clauses: new Map(),
      templates: new Map(),
      legalPacks: new Set(),
      createdClauseCount: 0,
      createdTemplateCount: 0,
      calls: [],
    };
    const registry = createMockRegistry(state);

    const result = await executeLegalPackImport({
      artifacts,
      registry,
      context: baseContext,
      repo: 'StarlinkOracle/Artifacts-Legal-Packs',
      tag: 'CO-v1.0.0',
      governanceGate: async () => ({
        allowed: false,
        code: 'LEGAL_PACK_FAIL_CLOSED',
        message: 'Importer blocked by governance policy',
        details: {
          blockedIssueKeys: ['backup_checksum_mismatch'],
        },
      }),
    });

    expect(result.status).toBe('BLOCKED');
    expect(result.error?.code).toBe('LEGAL_PACK_FAIL_CLOSED');
    expect(result.error?.toolName).toBe('governance.preflight');
    expect(state.calls).toHaveLength(0);
  });

  it('fails deterministically when governance preflight is unavailable', async () => {
    const artifacts = await loadLegalPackArtifacts(coPackRoot);
    validateLegalPackArtifacts(artifacts);

    const state: MockState = {
      clauses: new Map(),
      templates: new Map(),
      legalPacks: new Set(),
      createdClauseCount: 0,
      createdTemplateCount: 0,
      calls: [],
    };
    const registry = createMockRegistry(state);

    const result = await executeLegalPackImport({
      artifacts,
      registry,
      context: baseContext,
      repo: 'StarlinkOracle/Artifacts-Legal-Packs',
      tag: 'CO-v1.0.0',
      governanceGate: async () => {
        throw new Error('health snapshot unavailable');
      },
    });

    expect(result.status).toBe('FAILED');
    expect(result.error?.code).toBe('LEGAL_PACK_GOVERNANCE_UNAVAILABLE');
    expect(result.error?.toolName).toBe('governance.preflight');
    expect(state.calls).toHaveLength(0);
  });

  it('uses fixture sourceDir resolution and importer stays ToolRegistry-only', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), `legal-pack-source-${randomUUID()}-`));
    tempDirs.push(tempDir);
    const vendoredRoot = join(tempDir, 'vendor-root');
    await cp(coPackRoot, join(vendoredRoot, 'packs', 'CO', 'v1'), { recursive: true });

    const resolved = await resolvePackDirectory({
      repo: 'StarlinkOracle/Artifacts-Legal-Packs',
      tag: 'CO-v1.0.0',
      packPath: 'packs/CO/v1',
      sourceDir: vendoredRoot,
    });
    expect(resolved.packDir.endsWith('packs/CO/v1')).toBe(true);

    const artifacts = await loadLegalPackArtifacts(resolved.packDir);
    validateLegalPackArtifacts(artifacts);

    const state: MockState = {
      clauses: new Map(),
      templates: new Map(),
      legalPacks: new Set(),
      createdClauseCount: 0,
      createdTemplateCount: 0,
      calls: [],
    };
    const registry = createMockRegistry(state);

    const result = await executeLegalPackImport({
      artifacts,
      registry,
      context: baseContext,
      repo: 'StarlinkOracle/Artifacts-Legal-Packs',
      tag: 'CO-v1.0.0',
    });

    expect(result.status).toBe('COMPLETED');
    expect(state.calls.every((row) => row.toolName.startsWith('contract.'))).toBe(true);
  });

  it('rejects packPath traversal outside sourceDir root', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), `legal-pack-source-${randomUUID()}-`));
    tempDirs.push(tempDir);

    await expect(
      resolvePackDirectory({
        repo: 'StarlinkOracle/Artifacts-Legal-Packs',
        tag: 'CO-v1.0.0',
        packPath: '../outside',
        sourceDir: tempDir,
      }),
    ).rejects.toThrow(/packPath escapes source root/i);
  });

  it('rejects packPath that resolves outside sourceDir via symlink directory', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), `legal-pack-source-${randomUUID()}-`));
    tempDirs.push(tempDir);

    const sourceRoot = join(tempDir, 'vendor-root');
    const escapedRoot = join(tempDir, 'outside-root');
    await cp(coPackRoot, join(escapedRoot, 'CO', 'v1'), { recursive: true });

    await mkdir(sourceRoot, { recursive: true });
    await symlink(escapedRoot, join(sourceRoot, 'packs'));

    await expect(
      resolvePackDirectory({
        repo: 'StarlinkOracle/Artifacts-Legal-Packs',
        tag: 'CO-v1.0.0',
        packPath: 'packs/CO/v1',
        sourceDir: sourceRoot,
      }),
    ).rejects.toThrow(/resolves outside source root via symlink/i);
  });

  it('enforces max extracted files limit for sourceDir pack resolution', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), `legal-pack-source-${randomUUID()}-`));
    tempDirs.push(tempDir);
    const sourceRoot = join(tempDir, 'vendor-root');
    const packDir = join(sourceRoot, 'packs', 'CO', 'v1');
    await mkdir(packDir, { recursive: true });
    await Promise.all(
      ['a.json', 'b.json', 'c.json'].map((name) =>
        writeFile(join(packDir, name), '{}\n', 'utf8')
      ),
    );

    const previousLimit = process.env.LEGAL_PACK_IMPORT_MAX_EXTRACTED_FILES;
    process.env.LEGAL_PACK_IMPORT_MAX_EXTRACTED_FILES = '2';
    try {
      await expect(
        resolvePackDirectory({
          repo: 'StarlinkOracle/Artifacts-Legal-Packs',
          tag: 'CO-v1.0.0',
          packPath: 'packs/CO/v1',
          sourceDir: sourceRoot,
        }),
      ).rejects.toThrow(/exceeds max files/i);
    } finally {
      process.env.LEGAL_PACK_IMPORT_MAX_EXTRACTED_FILES = previousLimit;
    }
  });

  it('verifies downloaded archive sha256 when expectedArchiveSha256 is provided', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), `legal-pack-archive-${randomUUID()}-`));
    tempDirs.push(tempDir);
    const bytes = Buffer.from('fixture-archive-bytes');
    const expectedArchiveSha256 = createHash('sha256').update(bytes).digest('hex');

    const zipPath = await downloadRepoArchive({
      repo: 'StarlinkOracle/Artifacts-Legal-Packs',
      tag: 'CO-v1.0.0',
      tempDir,
      expectedArchiveSha256,
      fetchImpl: async () =>
        new Response(bytes, {
          status: 200,
          headers: { 'content-type': 'application/zip' },
        }),
    });

    const saved = await readFile(zipPath);
    expect(saved.equals(bytes)).toBe(true);
  });

  it('retries transient archive download failures and succeeds deterministically', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), `legal-pack-archive-${randomUUID()}-`));
    tempDirs.push(tempDir);
    const bytes = Buffer.from('fixture-archive-bytes-retry');
    const priorMaxAttempts = process.env.LEGAL_PACK_IMPORT_DOWNLOAD_MAX_ATTEMPTS;
    const priorRetryDelay = process.env.LEGAL_PACK_IMPORT_DOWNLOAD_RETRY_DELAY_MS;
    let attempts = 0;

    process.env.LEGAL_PACK_IMPORT_DOWNLOAD_MAX_ATTEMPTS = '3';
    process.env.LEGAL_PACK_IMPORT_DOWNLOAD_RETRY_DELAY_MS = '0';

    try {
      const zipPath = await downloadRepoArchive({
        repo: 'StarlinkOracle/Artifacts-Legal-Packs',
        tag: 'CO-v1.0.0',
        tempDir,
        fetchImpl: async () => {
          attempts += 1;
          if (attempts === 1) {
            return new Response('retryable', { status: 503 });
          }
          return new Response(bytes, {
            status: 200,
            headers: { 'content-type': 'application/zip' },
          });
        },
      });

      const saved = await readFile(zipPath);
      expect(saved.equals(bytes)).toBe(true);
      expect(attempts).toBe(2);
    } finally {
      if (priorMaxAttempts == null) {
        delete process.env.LEGAL_PACK_IMPORT_DOWNLOAD_MAX_ATTEMPTS;
      } else {
        process.env.LEGAL_PACK_IMPORT_DOWNLOAD_MAX_ATTEMPTS = priorMaxAttempts;
      }
      if (priorRetryDelay == null) {
        delete process.env.LEGAL_PACK_IMPORT_DOWNLOAD_RETRY_DELAY_MS;
      } else {
        process.env.LEGAL_PACK_IMPORT_DOWNLOAD_RETRY_DELAY_MS = priorRetryDelay;
      }
    }
  });

  it('fails after max retry attempts for transient download failures', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), `legal-pack-archive-${randomUUID()}-`));
    tempDirs.push(tempDir);
    const priorMaxAttempts = process.env.LEGAL_PACK_IMPORT_DOWNLOAD_MAX_ATTEMPTS;
    const priorRetryDelay = process.env.LEGAL_PACK_IMPORT_DOWNLOAD_RETRY_DELAY_MS;
    let attempts = 0;

    process.env.LEGAL_PACK_IMPORT_DOWNLOAD_MAX_ATTEMPTS = '2';
    process.env.LEGAL_PACK_IMPORT_DOWNLOAD_RETRY_DELAY_MS = '0';

    try {
      await expect(
        downloadRepoArchive({
          repo: 'StarlinkOracle/Artifacts-Legal-Packs',
          tag: 'CO-v1.0.0',
          tempDir,
          fetchImpl: async () => {
            attempts += 1;
            throw new Error('transient network failure');
          },
        }),
      ).rejects.toThrow(/after 2 attempts/i);
      expect(attempts).toBe(2);
    } finally {
      if (priorMaxAttempts == null) {
        delete process.env.LEGAL_PACK_IMPORT_DOWNLOAD_MAX_ATTEMPTS;
      } else {
        process.env.LEGAL_PACK_IMPORT_DOWNLOAD_MAX_ATTEMPTS = priorMaxAttempts;
      }
      if (priorRetryDelay == null) {
        delete process.env.LEGAL_PACK_IMPORT_DOWNLOAD_RETRY_DELAY_MS;
      } else {
        process.env.LEGAL_PACK_IMPORT_DOWNLOAD_RETRY_DELAY_MS = priorRetryDelay;
      }
    }
  });

  it('fails deterministically on download timeout when fetch is aborted', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), `legal-pack-archive-${randomUUID()}-`));
    tempDirs.push(tempDir);
    const priorMaxAttempts = process.env.LEGAL_PACK_IMPORT_DOWNLOAD_MAX_ATTEMPTS;
    const priorTimeoutMs = process.env.LEGAL_PACK_IMPORT_DOWNLOAD_TIMEOUT_MS;
    const priorRetryDelay = process.env.LEGAL_PACK_IMPORT_DOWNLOAD_RETRY_DELAY_MS;

    process.env.LEGAL_PACK_IMPORT_DOWNLOAD_MAX_ATTEMPTS = '1';
    process.env.LEGAL_PACK_IMPORT_DOWNLOAD_TIMEOUT_MS = '25';
    process.env.LEGAL_PACK_IMPORT_DOWNLOAD_RETRY_DELAY_MS = '0';

    try {
      await expect(
        downloadRepoArchive({
          repo: 'StarlinkOracle/Artifacts-Legal-Packs',
          tag: 'CO-v1.0.0',
          tempDir,
          fetchImpl: async (_url: string | URL | globalThis.Request, init?: RequestInit) =>
            await new Promise<Response>((_resolve, reject) => {
              const signal = init?.signal;
              if (signal) {
                signal.addEventListener(
                  'abort',
                  () => {
                    const abortError = new Error('aborted');
                    abortError.name = 'AbortError';
                    reject(abortError);
                  },
                  { once: true },
                );
              }
            }),
        }),
      ).rejects.toThrow(/request timed out/i);
    } finally {
      if (priorMaxAttempts == null) {
        delete process.env.LEGAL_PACK_IMPORT_DOWNLOAD_MAX_ATTEMPTS;
      } else {
        process.env.LEGAL_PACK_IMPORT_DOWNLOAD_MAX_ATTEMPTS = priorMaxAttempts;
      }
      if (priorTimeoutMs == null) {
        delete process.env.LEGAL_PACK_IMPORT_DOWNLOAD_TIMEOUT_MS;
      } else {
        process.env.LEGAL_PACK_IMPORT_DOWNLOAD_TIMEOUT_MS = priorTimeoutMs;
      }
      if (priorRetryDelay == null) {
        delete process.env.LEGAL_PACK_IMPORT_DOWNLOAD_RETRY_DELAY_MS;
      } else {
        process.env.LEGAL_PACK_IMPORT_DOWNLOAD_RETRY_DELAY_MS = priorRetryDelay;
      }
    }
  });

  it('rejects downloaded archive when expectedArchiveSha256 does not match', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), `legal-pack-archive-${randomUUID()}-`));
    tempDirs.push(tempDir);
    const bytes = Buffer.from('fixture-archive-bytes');

    await expect(
      downloadRepoArchive({
        repo: 'StarlinkOracle/Artifacts-Legal-Packs',
        tag: 'CO-v1.0.0',
        tempDir,
        expectedArchiveSha256: '0'.repeat(64),
        fetchImpl: async () =>
          new Response(bytes, {
            status: 200,
            headers: { 'content-type': 'application/zip' },
          }),
      }),
    ).rejects.toThrow(/archive integrity mismatch/i);
  });

  it('enforces max extracted bytes limit for sourceDir pack resolution', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), `legal-pack-source-${randomUUID()}-`));
    tempDirs.push(tempDir);
    const sourceRoot = join(tempDir, 'vendor-root');
    const packDir = join(sourceRoot, 'packs', 'CO', 'v1');
    await mkdir(packDir, { recursive: true });
    await writeFile(join(packDir, 'large.json'), 'x'.repeat(512), 'utf8');

    const previousLimit = process.env.LEGAL_PACK_IMPORT_MAX_EXTRACTED_BYTES;
    process.env.LEGAL_PACK_IMPORT_MAX_EXTRACTED_BYTES = '64';
    try {
      await expect(
        resolvePackDirectory({
          repo: 'StarlinkOracle/Artifacts-Legal-Packs',
          tag: 'CO-v1.0.0',
          packPath: 'packs/CO/v1',
          sourceDir: sourceRoot,
        }),
      ).rejects.toThrow(/exceeds max size/i);
    } finally {
      process.env.LEGAL_PACK_IMPORT_MAX_EXTRACTED_BYTES = previousLimit;
    }
  });

  it('rejects symlinked pack files during artifact load', async () => {
    const { packDir } = await createTempFixtureCopy();
    const linkedPath = join(packDir, 'legal_pack.json');
    const targetPath = join(packDir, 'legal_pack_real.json');
    const original = await readFile(linkedPath, 'utf8');

    await writeFile(targetPath, original, 'utf8');
    await rm(linkedPath);
    await symlink(targetPath, linkedPath);

    await expect(loadLegalPackArtifacts(packDir)).rejects.toThrow(
      /symlinked pack files are not allowed/i,
    );
  });
});
