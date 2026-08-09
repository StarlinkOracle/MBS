import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Ajv = require('ajv');

const execFileAsync = promisify(execFile);

export type RegistryLike = {
  execute: (
    toolName: string,
    payload: Record<string, unknown>,
    context: Record<string, unknown>,
  ) => Promise<
    | { status: 'EXECUTED'; executionId: string; output: unknown }
    | {
        status: 'QUEUED_APPROVAL';
        executionId: string;
        approvalRequestId: string;
        requiredApprovals: number;
      }
    | { status: 'BLOCKED'; executionId: string; reason: string }
    | {
        status: 'FAILED';
        executionId: string;
        error: string;
        errorCode?: string;
        recoverable?: boolean;
      }
  >;
};

export type LegalPackArtifacts = {
  legalPackRaw: string;
  legalPack: Record<string, unknown>;
  clauses: Array<Record<string, unknown>>;
  templates: Array<Record<string, unknown>>;
  variableSchemas: Array<Record<string, unknown>>;
  placeholderWhitelist: string[];
  schemas: Record<string, Record<string, unknown>>;
  packDir: string;
};

export type ValidationResult = {
  placeholderKeys: string[];
  clauseStableIds: string[];
  templateStableIds: string[];
};

export type ImportStepResult = {
  toolName: string;
  requestId: string;
  targetStableId: string;
  status: 'EXECUTED' | 'QUEUED_APPROVAL' | 'BLOCKED' | 'FAILED';
  executionId: string;
  detail?: Record<string, unknown>;
};

export type ImportSummary = {
  status: 'COMPLETED' | 'NEEDS_APPROVAL' | 'BLOCKED' | 'FAILED';
  batchRequestId: string;
  executedSteps: ImportStepResult[];
  approval?: {
    toolName: string;
    approvalRequestId: string;
    requiredApprovals: number;
  };
  error?: {
    toolName: string;
    message: string;
    code?: string;
    details?: Record<string, unknown>;
  };
};

type DownloadArgs = {
  repo: string;
  tag: string;
  tempDir: string;
  fetchImpl?: typeof fetch;
  expectedArchiveSha256?: string;
};

type ImportArgs = {
  artifacts: LegalPackArtifacts;
  registry: RegistryLike;
  context: Record<string, unknown>;
  repo: string;
  tag: string;
  governanceGate?: (
    args: {
      repo: string;
      tag: string;
      batchRequestId: string;
      clauseCount: number;
      templateCount: number;
      legalPackStableId: string;
      legalPackVersion: string;
    },
  ) =>
    | Promise<
        | { allowed: true }
        | {
            allowed: false;
            code: string;
            message: string;
            details?: Record<string, unknown>;
          }
      >
    | {
        allowed: true;
      }
    | {
        allowed: false;
        code: string;
        message: string;
        details?: Record<string, unknown>;
      };
};

type ImportArchiveLimits = {
  maxArchiveBytes: number;
  maxExtractedBytes: number;
  maxExtractedFiles: number;
};

type ImportDownloadPolicy = {
  maxAttempts: number;
  timeoutMs: number;
  retryDelayMs: number;
};

type ExternalPacksManifest = {
  manifestVersion?: number;
  packs?: Array<{
    id?: string;
    sourceRepo?: string;
    sourceRef?: string;
    packContentSha256?: string;
  }>;
};

function resolvePackPathWithinRoot(rootDir: string, packPath: string): string {
  const normalizedPackPath = packPath.trim();
  if (!normalizedPackPath) {
    throw new Error('packPath is required');
  }
  const absoluteRoot = resolve(rootDir);
  const absolutePackDir = resolve(absoluteRoot, normalizedPackPath);
  const rel = relative(absoluteRoot, absolutePackDir);
  if (rel.startsWith('..') || rel === '' || rel.startsWith('../')) {
    if (rel === '') {
      return absolutePackDir;
    }
    throw new Error(`packPath escapes source root: ${packPath}`);
  }
  return absolutePackDir;
}

async function ensureRealpathWithinRoot(args: {
  rootDir: string;
  candidatePath: string;
  label: string;
}): Promise<void> {
  const [realRoot, realCandidate] = await Promise.all([
    realpath(args.rootDir),
    realpath(args.candidatePath),
  ]);
  const rel = relative(realRoot, realCandidate);
  if (rel === '') {
    return;
  }
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `${args.label} resolves outside source root via symlink: ${args.candidatePath}`,
    );
  }
}

function objectOrThrow(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function arrayObjectsOrThrow(value: unknown, message: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    throw new Error(message);
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(message);
    }
    rows.push(row as Record<string, unknown>);
  }
  return rows;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((row) => (typeof row === 'string' ? row.trim() : ''))
    .filter((row) => row.length > 0);
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

function parseNonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function getImportArchiveLimits(): ImportArchiveLimits {
  return {
    maxArchiveBytes: parsePositiveIntEnv(
      'LEGAL_PACK_IMPORT_MAX_ARCHIVE_BYTES',
      20 * 1024 * 1024,
    ),
    maxExtractedBytes: parsePositiveIntEnv(
      'LEGAL_PACK_IMPORT_MAX_EXTRACTED_BYTES',
      150 * 1024 * 1024,
    ),
    maxExtractedFiles: parsePositiveIntEnv(
      'LEGAL_PACK_IMPORT_MAX_EXTRACTED_FILES',
      5000,
    ),
  };
}

function getImportDownloadPolicy(): ImportDownloadPolicy {
  return {
    maxAttempts: parsePositiveIntEnv('LEGAL_PACK_IMPORT_DOWNLOAD_MAX_ATTEMPTS', 3),
    timeoutMs: parsePositiveIntEnv('LEGAL_PACK_IMPORT_DOWNLOAD_TIMEOUT_MS', 15000),
    retryDelayMs: parseNonNegativeIntEnv('LEGAL_PACK_IMPORT_DOWNLOAD_RETRY_DELAY_MS', 250),
  };
}

async function waitMs(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return;
  }
  await new Promise<void>((resolveDelay) => {
    setTimeout(resolveDelay, delayMs);
  });
}

function isAbortError(error: Error): boolean {
  return error.name === 'AbortError';
}

async function readUtf8FileNoSymlink(filePath: string): Promise<string> {
  const fileInfo = await lstat(filePath);
  if (fileInfo.isSymbolicLink()) {
    throw new Error(`Symlinked pack files are not allowed: ${filePath}`);
  }
  return readFile(filePath, 'utf8');
}

function collectPlaceholders(text: string): string[] {
  const placeholders = new Set<string>();
  const pattern = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match) {
    const key = toStringOrNull(match[1]);
    if (key) {
      placeholders.add(key);
    }
    match = pattern.exec(text);
  }
  return Array.from(placeholders);
}

function collectPlaceholderStringsFromUnknown(value: unknown): string[] {
  if (typeof value === 'string') {
    return collectPlaceholders(value);
  }
  if (Array.isArray(value)) {
    return value.flatMap((row) => collectPlaceholderStringsFromUnknown(row));
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  const record = value as Record<string, unknown>;
  return Object.values(record).flatMap((entry) =>
    collectPlaceholderStringsFromUnknown(entry),
  );
}

function ensureJurisdictionCO(value: unknown, label: string) {
  const jurisdiction = toStringOrNull(value);
  if (jurisdiction !== 'CO') {
    throw new Error(`${label} jurisdiction must be CO`);
  }
}

function ensureSemver(value: unknown, label: string) {
  const version = toStringOrNull(value);
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`${label} version must match x.y.z`);
  }
}

function ensurePositiveInt(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function ajvErrors(errors: Array<{ instancePath?: string; message?: string }> | null | undefined): string {
  if (!errors || errors.length === 0) {
    return 'unknown schema validation error';
  }
  return errors
    .map((row) => `${row.instancePath || '/'} ${row.message || 'invalid'}`.trim())
    .join('; ');
}

export function buildBatchRequestId(repo: string, tag: string, legalPackRaw: string): string {
  const repoName = repo.includes('/') ? repo.split('/')[1] : repo;
  const hash = createHash('sha256').update(legalPackRaw).digest('hex');
  return `import:${repoName}:${tag}:${hash}`;
}

async function walkFiles(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(absolute)));
      continue;
    }
    if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

export async function computePackContentSha256(packDir: string): Promise<string> {
  const files = await walkFiles(packDir);
  const digestRows: string[] = [];
  for (const file of files) {
    const content = await readFile(file);
    const rel = relative(packDir, file).split('\\').join('/');
    digestRows.push(`${rel}:${createHash('sha256').update(content).digest('hex')}`);
  }
  digestRows.sort((a, b) => a.localeCompare(b));
  return createHash('sha256').update(digestRows.join('\n')).digest('hex');
}

export async function verifyPackContentSha256(args: {
  packDir: string;
  expectedSha256: string;
}): Promise<void> {
  const expected = args.expectedSha256.trim().toLowerCase();
  const actual = (await computePackContentSha256(args.packDir)).toLowerCase();
  if (actual !== expected) {
    throw new Error(`Pack integrity mismatch: expected ${expected}, got ${actual}`);
  }
}

export async function verifyPackContentFromManifest(args: {
  packDir: string;
  sourceRepo: string;
  sourceRef: string;
  manifestPath: string;
}): Promise<void> {
  const raw = await readFile(args.manifestPath, 'utf8');
  const parsed = JSON.parse(raw) as ExternalPacksManifest;
  const entry = (parsed.packs ?? []).find(
    (row) =>
      row.sourceRepo === args.sourceRepo &&
      row.sourceRef === args.sourceRef &&
      typeof row.packContentSha256 === 'string' &&
      row.packContentSha256.length > 0,
  );
  if (!entry || !entry.packContentSha256) {
    throw new Error(
      `No manifest pack entry with packContentSha256 for ${args.sourceRepo}@${args.sourceRef}`,
    );
  }
  await verifyPackContentSha256({
    packDir: args.packDir,
    expectedSha256: entry.packContentSha256,
  });
}

export async function downloadRepoArchive(args: DownloadArgs): Promise<string> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const url = `https://codeload.github.com/${args.repo}/zip/refs/tags/${args.tag}`;
  const zipPath = join(args.tempDir, `${args.tag}.zip`);
  const limits = getImportArchiveLimits();
  const policy = getImportDownloadPolicy();

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      abortController.abort();
    }, policy.timeoutMs);

    try {
      const response = await fetchImpl(url, { signal: abortController.signal });
      if (!response.ok) {
        const status = response.status;
        const statusError = new Error(`Failed to download ${url}: HTTP ${status}`);
        (statusError as Error & { retryable?: boolean }).retryable =
          status === 429 || status >= 500;
        throw statusError;
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > limits.maxArchiveBytes) {
        const sizeError = new Error(
          `Archive exceeds max size (${bytes.byteLength} > ${limits.maxArchiveBytes})`,
        );
        (sizeError as Error & { retryable?: boolean }).retryable = false;
        throw sizeError;
      }

      const expectedArchiveSha256 = toStringOrNull(args.expectedArchiveSha256);
      if (expectedArchiveSha256) {
        const actualArchiveSha256 = createHash('sha256').update(bytes).digest('hex').toLowerCase();
        if (actualArchiveSha256 !== expectedArchiveSha256.toLowerCase()) {
          const integrityError = new Error(
            `Archive integrity mismatch: expected ${expectedArchiveSha256.toLowerCase()}, got ${actualArchiveSha256}`,
          );
          (integrityError as Error & { retryable?: boolean }).retryable = false;
          throw integrityError;
        }
      }

      await writeFile(zipPath, bytes);
      return zipPath;
    } catch (error) {
      const resolvedError =
        error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'unknown');
      const retryableFlag = (resolvedError as Error & { retryable?: boolean }).retryable;
      const retryable = retryableFlag !== false;

      if (attempt >= policy.maxAttempts || !retryable) {
        if (isAbortError(resolvedError)) {
          throw new Error(
            `Failed to download ${url}: request timed out after ${policy.timeoutMs}ms (attempt ${attempt}/${policy.maxAttempts})`,
          );
        }
        if (attempt > 1 && retryable) {
          throw new Error(`${resolvedError.message} (after ${attempt} attempts)`);
        }
        throw resolvedError;
      }

      await waitMs(policy.retryDelayMs);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  throw new Error(`Failed to download ${url}: exhausted retry attempts`);
}

export async function extractArchive(zipPath: string, outputDir: string): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await execFileAsync('unzip', ['-q', zipPath, '-d', outputDir]);
}

export async function enforceExtractedTreeLimits(args: {
  rootDir: string;
  maxExtractedBytes: number;
  maxExtractedFiles: number;
}): Promise<void> {
  const files = await walkFiles(args.rootDir);
  if (files.length > args.maxExtractedFiles) {
    throw new Error(
      `Extracted content exceeds max files (${files.length} > ${args.maxExtractedFiles})`,
    );
  }

  let totalBytes = 0;
  for (const file of files) {
    const fileStat = await stat(file);
    totalBytes += fileStat.size;
    if (totalBytes > args.maxExtractedBytes) {
      throw new Error(
        `Extracted content exceeds max size (${totalBytes} > ${args.maxExtractedBytes})`,
      );
    }
  }
}

export async function resolvePackDirectory(args: {
  repo: string;
  tag: string;
  packPath: string;
  sourceDir?: string;
  expectedArchiveSha256?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ tempDir: string; packDir: string; cleanup: () => Promise<void> }> {
  const limits = getImportArchiveLimits();
  if (args.sourceDir) {
    const packDir = resolvePackPathWithinRoot(args.sourceDir, args.packPath);
    await ensureRealpathWithinRoot({
      rootDir: args.sourceDir,
      candidatePath: packDir,
      label: 'packPath',
    });
    await enforceExtractedTreeLimits({
      rootDir: packDir,
      maxExtractedBytes: limits.maxExtractedBytes,
      maxExtractedFiles: limits.maxExtractedFiles,
    });
    return {
      tempDir: args.sourceDir,
      packDir,
      cleanup: async () => {},
    };
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'mbs-legal-pack-'));
  const zipPath = await downloadRepoArchive({
    repo: args.repo,
    tag: args.tag,
    tempDir,
    fetchImpl: args.fetchImpl,
    expectedArchiveSha256: args.expectedArchiveSha256,
  });
  const extractDir = join(tempDir, 'extract');
  await extractArchive(zipPath, extractDir);
  const repoName = args.repo.includes('/') ? args.repo.split('/')[1] : args.repo;
  const rootDir = join(extractDir, `${repoName}-${args.tag}`);
  const packDir = resolvePackPathWithinRoot(rootDir, args.packPath);
  await ensureRealpathWithinRoot({
    rootDir,
    candidatePath: packDir,
    label: 'packPath',
  });
  await enforceExtractedTreeLimits({
    rootDir: packDir,
    maxExtractedBytes: limits.maxExtractedBytes,
    maxExtractedFiles: limits.maxExtractedFiles,
  });
  return {
    tempDir,
    packDir,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

export async function loadLegalPackArtifacts(packDir: string): Promise<LegalPackArtifacts> {
  const loadPackJson = async (args: {
    exact: string;
    prefixed: string;
  }): Promise<string> => {
    const exactPath = join(packDir, args.exact);
    try {
      return await readUtf8FileNoSymlink(exactPath);
    } catch (error) {
      const entries = await readdir(packDir, { withFileTypes: true });
      const match = entries
        .filter((entry) => entry.isFile() && entry.name.startsWith(args.prefixed) && entry.name.endsWith('.json'))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b))[0];
      if (!match) {
        throw error;
      }
      return readUtf8FileNoSymlink(join(packDir, match));
    }
  };

  const [
    legalPackRaw,
    clausesRaw,
    templatesRaw,
    variableSchemasRaw,
    whitelistRaw,
    legalPackSchemaRaw,
    clausesSchemaRaw,
    templatesSchemaRaw,
    variableSchemasSchemaRaw,
  ] = await Promise.all([
    readUtf8FileNoSymlink(join(packDir, 'legal_pack.json')),
    loadPackJson({ exact: 'clauses.json', prefixed: 'clauses_' }),
    loadPackJson({ exact: 'templates.json', prefixed: 'templates_' }),
    loadPackJson({ exact: 'variable_schemas.json', prefixed: 'variable_schemas_' }),
    readUtf8FileNoSymlink(join(packDir, 'placeholder_whitelist.json')),
    readUtf8FileNoSymlink(join(packDir, 'schema', 'legal_pack.schema.json')),
    readUtf8FileNoSymlink(join(packDir, 'schema', 'clauses.schema.json')),
    readUtf8FileNoSymlink(join(packDir, 'schema', 'templates.schema.json')),
    readUtf8FileNoSymlink(join(packDir, 'schema', 'variable_schemas.schema.json')),
  ]);

  const legalPack = objectOrThrow(JSON.parse(legalPackRaw), 'legal_pack.json must be an object');
  const clauses = arrayObjectsOrThrow(JSON.parse(clausesRaw), 'clauses.json must be an array of objects');
  const templates = arrayObjectsOrThrow(JSON.parse(templatesRaw), 'templates.json must be an array of objects');
  const variableSchemas = arrayObjectsOrThrow(
    JSON.parse(variableSchemasRaw),
    'variable_schemas.json must be an array of objects',
  );
  const placeholderWhitelist = stringArray(JSON.parse(whitelistRaw));
  const schemas = {
    legalPack: objectOrThrow(JSON.parse(legalPackSchemaRaw), 'legal_pack schema must be object'),
    clauses: objectOrThrow(JSON.parse(clausesSchemaRaw), 'clauses schema must be object'),
    templates: objectOrThrow(JSON.parse(templatesSchemaRaw), 'templates schema must be object'),
    variableSchemas: objectOrThrow(
      JSON.parse(variableSchemasSchemaRaw),
      'variable_schemas schema must be object',
    ),
  };

  return {
    legalPackRaw,
    legalPack,
    clauses,
    templates,
    variableSchemas,
    placeholderWhitelist,
    schemas,
    packDir,
  };
}

export function validateLegalPackArtifacts(artifacts: LegalPackArtifacts): ValidationResult {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validators = {
    legalPack: ajv.compile(artifacts.schemas.legalPack),
    clauses: ajv.compile(artifacts.schemas.clauses),
    templates: ajv.compile(artifacts.schemas.templates),
    variableSchemas: ajv.compile(artifacts.schemas.variableSchemas),
  };

  const schemaInputs = {
    legalPack: artifacts.legalPack,
    clauses: artifacts.clauses,
    templates: artifacts.templates,
    variableSchemas: artifacts.variableSchemas,
  };

  for (const [label, validator] of Object.entries(validators)) {
    const input = schemaInputs[label as keyof typeof schemaInputs];
    if (!validator(input)) {
      throw new Error(`Schema validation failed for ${label}: ${ajvErrors(validator.errors)}`);
    }
  }

  ensureJurisdictionCO(artifacts.legalPack.jurisdiction, 'legal_pack');
  ensureSemver(artifacts.legalPack.version, 'legal_pack');

  const clauseIds = new Set<string>();
  for (const clause of artifacts.clauses) {
    ensureJurisdictionCO(clause.jurisdiction, `clause ${String(clause.stableId ?? '')}`);
    ensurePositiveInt(clause.version, `clause ${String(clause.stableId ?? '')} version`);
    const stableId = toStringOrNull(clause.stableId);
    if (!stableId) {
      throw new Error('Clause stableId is required');
    }
    if (clauseIds.has(stableId)) {
      throw new Error(`Duplicate clause stableId: ${stableId}`);
    }
    clauseIds.add(stableId);
  }

  const templateIds = new Set<string>();
  for (const template of artifacts.templates) {
    ensureJurisdictionCO(
      template.jurisdiction,
      `template ${String(template.templateStableId ?? '')}`,
    );
    ensurePositiveInt(template.version, `template ${String(template.templateStableId ?? '')} version`);
    const stableId = toStringOrNull(template.templateStableId);
    if (!stableId) {
      throw new Error('Template templateStableId is required');
    }
    if (templateIds.has(stableId)) {
      throw new Error(`Duplicate templateStableId: ${stableId}`);
    }
    templateIds.add(stableId);
  }

  const whitelist = new Set(artifacts.placeholderWhitelist);
  const placeholders = new Set<string>();

  for (const clause of artifacts.clauses) {
    const bodyText = toStringOrNull(clause.bodyText) ?? '';
    for (const key of collectPlaceholders(bodyText)) {
      placeholders.add(key);
    }
  }
  for (const template of artifacts.templates) {
    const bodyText = toStringOrNull(template.bodyText) ?? toStringOrNull(template.layoutText) ?? '';
    for (const key of collectPlaceholders(bodyText)) {
      placeholders.add(key);
    }
    const structure = template.structureJson;
    for (const key of collectPlaceholderStringsFromUnknown(structure)) {
      placeholders.add(key);
    }
  }
  for (const row of artifacts.variableSchemas) {
    for (const key of collectPlaceholderStringsFromUnknown(row)) {
      placeholders.add(key);
    }
  }

  const unknownPlaceholders = Array.from(placeholders)
    .filter((key) => !whitelist.has(key))
    .sort((a, b) => a.localeCompare(b));
  if (unknownPlaceholders.length > 0) {
    throw new Error(`Unknown placeholders not in whitelist: ${unknownPlaceholders.join(', ')}`);
  }

  return {
    placeholderKeys: Array.from(placeholders).sort((a, b) => a.localeCompare(b)),
    clauseStableIds: Array.from(clauseIds).sort((a, b) => a.localeCompare(b)),
    templateStableIds: Array.from(templateIds).sort((a, b) => a.localeCompare(b)),
  };
}

function outputRecord(output: unknown): Record<string, unknown> {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return {};
  }
  return output as Record<string, unknown>;
}

async function executeStep(args: {
  registry: RegistryLike;
  context: Record<string, unknown>;
  toolName: string;
  payload: Record<string, unknown>;
  requestId: string;
  targetStableId: string;
  steps: ImportStepResult[];
}): Promise<{ halt?: ImportSummary; output?: Record<string, unknown> }> {
  const response = await args.registry.execute(args.toolName, args.payload, args.context);
  if (response.status === 'EXECUTED') {
    args.steps.push({
      toolName: args.toolName,
      requestId: args.requestId,
      targetStableId: args.targetStableId,
      status: 'EXECUTED',
      executionId: response.executionId,
    });
    return { output: outputRecord(response.output) };
  }

  if (response.status === 'QUEUED_APPROVAL') {
    args.steps.push({
      toolName: args.toolName,
      requestId: args.requestId,
      targetStableId: args.targetStableId,
      status: 'QUEUED_APPROVAL',
      executionId: response.executionId,
      detail: {
        approvalRequestId: response.approvalRequestId,
        requiredApprovals: response.requiredApprovals,
      },
    });
    return {
      halt: {
        status: 'NEEDS_APPROVAL',
        batchRequestId: '',
        executedSteps: args.steps,
        approval: {
          toolName: args.toolName,
          approvalRequestId: response.approvalRequestId,
          requiredApprovals: response.requiredApprovals,
        },
      },
    };
  }

  if (response.status === 'BLOCKED') {
    args.steps.push({
      toolName: args.toolName,
      requestId: args.requestId,
      targetStableId: args.targetStableId,
      status: 'BLOCKED',
      executionId: response.executionId,
      detail: { reason: response.reason },
    });
    return {
      halt: {
        status: 'BLOCKED',
        batchRequestId: '',
        executedSteps: args.steps,
        error: {
          toolName: args.toolName,
          message: response.reason,
          code: 'BLOCKED',
        },
      },
    };
  }

  args.steps.push({
    toolName: args.toolName,
    requestId: args.requestId,
    targetStableId: args.targetStableId,
    status: 'FAILED',
    executionId: response.executionId,
    detail: {
      error: response.error,
      errorCode: response.errorCode,
    },
  });
  return {
    halt: {
      status: 'FAILED',
      batchRequestId: '',
      executedSteps: args.steps,
      error: {
        toolName: args.toolName,
        message: response.error,
        code: response.errorCode,
      },
    },
  };
}

export async function executeLegalPackImport(args: ImportArgs): Promise<ImportSummary> {
  const batchRequestId = buildBatchRequestId(args.repo, args.tag, args.artifacts.legalPackRaw);
  const steps: ImportStepResult[] = [];
  const legalPackStableId = String(args.artifacts.legalPack.packStableId);
  const legalPackVersion = String(args.artifacts.legalPack.version);

  if (args.governanceGate) {
    let decision:
      | { allowed: true }
      | {
          allowed: false;
          code: string;
          message: string;
          details?: Record<string, unknown>;
        };
    try {
      decision = await args.governanceGate({
        repo: args.repo,
        tag: args.tag,
        batchRequestId,
        clauseCount: args.artifacts.clauses.length,
        templateCount: args.artifacts.templates.length,
        legalPackStableId,
        legalPackVersion,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: 'FAILED',
        batchRequestId,
        executedSteps: steps,
        error: {
          toolName: 'governance.preflight',
          message,
          code: 'LEGAL_PACK_GOVERNANCE_UNAVAILABLE',
        },
      };
    }
    if (!decision.allowed) {
      return {
        status: 'BLOCKED',
        batchRequestId,
        executedSteps: steps,
        error: {
          toolName: 'governance.preflight',
          message: decision.message,
          code: decision.code,
          details: decision.details,
        },
      };
    }
  }

  const clauses = [...args.artifacts.clauses].sort((a, b) =>
    String(a.stableId).localeCompare(String(b.stableId)),
  );
  for (const clause of clauses) {
    const stableId = String(clause.stableId);
    const version = Number(clause.version);
    const clauseRequestId = `${batchRequestId}:clause:${stableId}:v${version}`;

    const createResult = await executeStep({
      registry: args.registry,
      context: args.context,
      toolName: 'contract.clause.createDraft',
      requestId: clauseRequestId,
      targetStableId: stableId,
      payload: {
        stableId,
        version,
        jurisdiction: String(clause.jurisdiction),
        title: String(clause.title),
        bodyText: String(clause.bodyText ?? ''),
        metadata: objectOrThrow(args.artifacts.legalPack, 'legal_pack metadata object required'),
        requestId: clauseRequestId,
      },
      steps,
    });
    if (createResult.halt) {
      return {
        ...createResult.halt,
        batchRequestId,
      };
    }

    const createOutput = outputRecord(createResult.output);
    const clauseRow = outputRecord(createOutput.clause);
    const clauseStatus = toStringOrNull(clauseRow.status) ?? 'DRAFT';
    const clauseCreateIdempotent = createOutput.idempotent === true;
    if (clauseStatus === 'DRAFT' && !clauseCreateIdempotent) {
      const updateResult = await executeStep({
        registry: args.registry,
        context: args.context,
        toolName: 'contract.clause.updateDraft',
        requestId: clauseRequestId,
        targetStableId: stableId,
        payload: {
          stableId,
          version,
          title: String(clause.title),
          bodyText: String(clause.bodyText ?? ''),
          metadata: clause.metadata ?? {},
          requestId: clauseRequestId,
        },
        steps,
      });
      if (updateResult.halt) {
        return {
          ...updateResult.halt,
          batchRequestId,
        };
      }
    }

    if (clause.publish === true && clauseStatus === 'DRAFT') {
      const publishResult = await executeStep({
        registry: args.registry,
        context: args.context,
        toolName: 'contract.clause.publish',
        requestId: clauseRequestId,
        targetStableId: stableId,
        payload: {
          stableId,
          version,
          requestId: clauseRequestId,
        },
        steps,
      });
      if (publishResult.halt) {
        return {
          ...publishResult.halt,
          batchRequestId,
        };
      }
    }

    if (clause.deprecate === true) {
      const deprecateResult = await executeStep({
        registry: args.registry,
        context: args.context,
        toolName: 'contract.clause.deprecate',
        requestId: clauseRequestId,
        targetStableId: stableId,
        payload: {
          stableId,
          version,
          reason: toStringOrNull(clause.deprecateReason) ?? 'Deprecated by legal pack import',
          requestId: clauseRequestId,
        },
        steps,
      });
      if (deprecateResult.halt) {
        return {
          ...deprecateResult.halt,
          batchRequestId,
        };
      }
    }
  }

  const variableSchemaMap = new Map<string, Record<string, unknown>>();
  for (const row of args.artifacts.variableSchemas) {
    const stableId = String(row.templateStableId);
    const version = Number(row.version);
    variableSchemaMap.set(`${stableId}:${version}`, row);
  }

  const templates = [...args.artifacts.templates].sort((a, b) =>
    String(a.templateStableId).localeCompare(String(b.templateStableId)),
  );
  for (const template of templates) {
    const templateStableId = String(template.templateStableId);
    const version = Number(template.version);
    const templateRequestId = `${batchRequestId}:template:${templateStableId}:v${version}`;

    const createResult = await executeStep({
      registry: args.registry,
      context: args.context,
      toolName: 'contract.template.createDraft',
      requestId: templateRequestId,
      targetStableId: templateStableId,
      payload: {
        templateStableId,
        version,
        jurisdiction: String(template.jurisdiction),
        name: String(template.name),
        bodyText: toStringOrNull(template.bodyText) ?? undefined,
        clauseStableIds: stringArray(template.clauseStableIds),
        structureJson: objectOrThrow(template.structureJson ?? {}, 'template structureJson required'),
        metadata: template.metadata ?? {},
        requestId: templateRequestId,
      },
      steps,
    });
    if (createResult.halt) {
      return {
        ...createResult.halt,
        batchRequestId,
      };
    }

    const createOutput = outputRecord(createResult.output);
    const templateRow = outputRecord(createOutput.template);
    const templateStatus = toStringOrNull(templateRow.status) ?? 'DRAFT';
    const templateCreateIdempotent = createOutput.idempotent === true;
    if (templateStatus === 'DRAFT' && !templateCreateIdempotent) {
      const structureResult = await executeStep({
        registry: args.registry,
        context: args.context,
        toolName: 'contract.template.updateStructure',
        requestId: templateRequestId,
        targetStableId: templateStableId,
        payload: {
          templateStableId,
          version,
          bodyText: toStringOrNull(template.bodyText) ?? undefined,
          clauseStableIds: stringArray(template.clauseStableIds),
          structureJson: objectOrThrow(template.structureJson ?? {}, 'template structureJson required'),
          metadata: template.metadata ?? {},
          requestId: templateRequestId,
        },
        steps,
      });
      if (structureResult.halt) {
        return {
          ...structureResult.halt,
          batchRequestId,
        };
      }

      const variableRow = variableSchemaMap.get(`${templateStableId}:${version}`);
      if (variableRow) {
        const variableResult = await executeStep({
          registry: args.registry,
          context: args.context,
          toolName: 'contract.template.updateVariableSchema',
          requestId: templateRequestId,
          targetStableId: templateStableId,
          payload: {
            templateStableId,
            version,
            variableSchemaJson: variableRow,
            requestId: templateRequestId,
          },
          steps,
        });
        if (variableResult.halt) {
          return {
            ...variableResult.halt,
            batchRequestId,
          };
        }
      }
    }

    if (template.publish === true && templateStatus === 'DRAFT') {
      const publishResult = await executeStep({
        registry: args.registry,
        context: args.context,
        toolName: 'contract.template.publish',
        requestId: templateRequestId,
        targetStableId: templateStableId,
        payload: {
          templateStableId,
          version,
          requestId: templateRequestId,
        },
        steps,
      });
      if (publishResult.halt) {
        return {
          ...publishResult.halt,
          batchRequestId,
        };
      }
    }
  }

  const legalPack = args.artifacts.legalPack;
  const legalPackRequestId = `${batchRequestId}:legal-pack:${legalPackStableId}:v${legalPackVersion}`;
  const packResult = await executeStep({
    registry: args.registry,
    context: args.context,
    toolName: 'contract.legalPack.upsert',
    requestId: legalPackRequestId,
    targetStableId: legalPackStableId,
    payload: {
      packStableId: legalPackStableId,
      jurisdiction: String(legalPack.jurisdiction),
      version: legalPackVersion,
      sourceRepo: args.repo,
      sourceTag: args.tag,
      templateStableIds: templates.map((row) => String(row.templateStableId)),
      legalPackJson: legalPack,
      metadata: {
        importedAt: new Date().toISOString(),
      },
      requestId: legalPackRequestId,
    },
    steps,
  });
  if (packResult.halt) {
    return {
      ...packResult.halt,
      batchRequestId,
    };
  }

  return {
    status: 'COMPLETED',
    batchRequestId,
    executedSteps: steps,
  };
}
