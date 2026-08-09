import { createHash } from 'node:crypto';
import {
  readdir,
  readFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  dirname,
  relative,
} from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildDeterministicRequestId,
  executePlaybook as executePlaybookRuntime,
  loadPackFromDir,
  PlaybookValidationError,
  validatePack,
  type LoadedPack,
  type PlaybookRuntimeResult,
  type PlaybookToolAdapter,
} from '@rcs/agent-playbooks';
import type { ExecutionContext } from '@rcs/tool-registry';

export {
  buildDeterministicRequestId,
  loadPackFromDir,
  validatePack,
};

export {
  PlaybookValidationError as PlaybookPackValidationError,
};

export type LoadedPlaybookPack = LoadedPack;
export type PlaybookExecutionResult = PlaybookRuntimeResult;
export type PlaybookRegistryLike = PlaybookToolAdapter;

type LoadPackOptions = {
  packId?: string;
  baseDir?: string;
};

export class PlaybookInputTooLargeError extends Error {
  readonly code = 'PLAYBOOK_INPUT_TOO_LARGE';
  readonly maxBytes: number;
  readonly inputBytes: number;

  constructor(maxBytes: number, inputBytes: number) {
    super(`Playbook inputs exceed max size (${inputBytes} > ${maxBytes})`);
    this.name = 'PlaybookInputTooLargeError';
    this.maxBytes = maxBytes;
    this.inputBytes = inputBytes;
  }
}

type PlaybookInputShapeReason = 'MAX_DEPTH_EXCEEDED' | 'MAX_KEYS_EXCEEDED';

export class PlaybookInputShapeError extends Error {
  readonly code = 'PLAYBOOK_INPUT_SHAPE_INVALID';
  readonly reason: PlaybookInputShapeReason;
  readonly maxDepth: number;
  readonly maxKeys: number;
  readonly actualDepth: number;
  readonly actualKeys: number;

  constructor(args: {
    reason: PlaybookInputShapeReason;
    maxDepth: number;
    maxKeys: number;
    actualDepth: number;
    actualKeys: number;
  }) {
    const message =
      args.reason === 'MAX_DEPTH_EXCEEDED'
        ? `Playbook inputs exceed max depth (${args.actualDepth} > ${args.maxDepth})`
        : `Playbook inputs exceed max key count (${args.actualKeys} > ${args.maxKeys})`;
    super(message);
    this.name = 'PlaybookInputShapeError';
    this.reason = args.reason;
    this.maxDepth = args.maxDepth;
    this.maxKeys = args.maxKeys;
    this.actualDepth = args.actualDepth;
    this.actualKeys = args.actualKeys;
  }
}

type ExecutePlaybookCompatArgs = {
  pack: LoadedPack;
  playbookStableId: string;
  packVersion?: string;
  inputs: Record<string, unknown>;
  registry: PlaybookToolAdapter;
  context: ExecutionContext;
  correlationId?: string;
  maxSteps?: number;
  maxStepExecutionMs?: number;
  maxStepPayloadBytes?: number;
  maxStepPayloadDepth?: number;
  maxStepPayloadKeys?: number;
};

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PACK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function normalizedOptionalPath(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'undefined' || trimmed === 'null') {
    return undefined;
  }
  return trimmed;
}

function sha256(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

function jsonUtf8ByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function assertPlaybookInputSize(inputs: Record<string, unknown>, maxBytes: number): void {
  if (!Number.isFinite(maxBytes) || maxBytes < 1) {
    throw new Error('maxBytes must be a positive integer');
  }
  const inputBytes = jsonUtf8ByteLength(inputs);
  if (inputBytes > maxBytes) {
    throw new PlaybookInputTooLargeError(maxBytes, inputBytes);
  }
}

type InputNode = {
  value: unknown;
  depth: number;
};

export function assertPlaybookInputShape(args: {
  inputs: Record<string, unknown>;
  maxDepth: number;
  maxKeys: number;
}): void {
  if (!Number.isFinite(args.maxDepth) || args.maxDepth < 1) {
    throw new Error('maxDepth must be a positive integer');
  }
  if (!Number.isFinite(args.maxKeys) || args.maxKeys < 1) {
    throw new Error('maxKeys must be a positive integer');
  }

  const maxDepth = Math.floor(args.maxDepth);
  const maxKeys = Math.floor(args.maxKeys);
  const stack: InputNode[] = [{ value: args.inputs, depth: 1 }];
  let keyCount = 0;
  let deepest = 1;

  while (stack.length > 0) {
    const current = stack.pop() as InputNode;
    deepest = Math.max(deepest, current.depth);
    if (current.depth > maxDepth) {
      throw new PlaybookInputShapeError({
        reason: 'MAX_DEPTH_EXCEEDED',
        maxDepth,
        maxKeys,
        actualDepth: current.depth,
        actualKeys: keyCount,
      });
    }

    if (Array.isArray(current.value)) {
      keyCount += current.value.length;
      if (keyCount > maxKeys) {
        throw new PlaybookInputShapeError({
          reason: 'MAX_KEYS_EXCEEDED',
          maxDepth,
          maxKeys,
          actualDepth: deepest,
          actualKeys: keyCount,
        });
      }
      for (const item of current.value) {
        if (item !== null && typeof item === 'object') {
          stack.push({
            value: item,
            depth: current.depth + 1,
          });
        }
      }
      continue;
    }

    if (current.value !== null && typeof current.value === 'object') {
      const entries = Object.keys(current.value as Record<string, unknown>);
      keyCount += entries.length;
      if (keyCount > maxKeys) {
        throw new PlaybookInputShapeError({
          reason: 'MAX_KEYS_EXCEEDED',
          maxDepth,
          maxKeys,
          actualDepth: deepest,
          actualKeys: keyCount,
        });
      }
      for (const key of entries) {
        const item = (current.value as Record<string, unknown>)[key];
        if (item !== null && typeof item === 'object') {
          stack.push({
            value: item,
            depth: current.depth + 1,
          });
        }
      }
    }
  }
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

async function verifyPackIntegrity(args: {
  packId: string;
  packRoot: string;
}): Promise<void> {
  if (process.env.AGENT_PLAYBOOK_ENFORCE_MANIFEST === 'false') {
    return;
  }

  const manifestPath = normalizedOptionalPath(process.env.EXTERNAL_PACKS_MANIFEST_PATH) ||
    join(repoRoot, 'apps', 'api', 'tests', 'fixtures', 'EXTERNAL_PACKS_MANIFEST.json');
  const manifestRaw = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestRaw) as {
    packs?: Array<{
      id?: string;
      rootPath?: string;
      packSha256?: string;
      packContentSha256?: string;
    }>;
  };
  const packEntry = (manifest.packs ?? []).find((row) => row.id === args.packId);
  if (!packEntry || !packEntry.packSha256) {
    throw new Error(`Pack ${args.packId} is missing from external packs manifest`);
  }

  const files = await walkFiles(args.packRoot);
  const digestRows: string[] = [];
  const contentDigestRows: string[] = [];
  for (const file of files) {
    const relativePath = relative(repoRoot, file).split('\\').join('/');
    const relativeToPack = relative(args.packRoot, file).split('\\').join('/');
    const content = await readFile(file);
    const fileHash = sha256(content);
    digestRows.push(`${relativePath}:${fileHash}`);
    contentDigestRows.push(`${relativeToPack}:${fileHash}`);
  }
  digestRows.sort((a, b) => a.localeCompare(b));
  contentDigestRows.sort((a, b) => a.localeCompare(b));
  const computedPackSha = sha256(digestRows.join('\n'));
  const computedContentSha = sha256(contentDigestRows.join('\n'));

  if (packEntry.packSha256 && computedPackSha !== packEntry.packSha256) {
    throw new Error(
      `Pack integrity mismatch for ${args.packId}: expected ${packEntry.packSha256}, got ${computedPackSha}`,
    );
  }
  if (packEntry.packContentSha256 && computedContentSha !== packEntry.packContentSha256) {
    throw new Error(
      `Pack content integrity mismatch for ${args.packId}: expected ${packEntry.packContentSha256}, got ${computedContentSha}`,
    );
  }
}

export async function loadPlaybookPack(options: LoadPackOptions = {}): Promise<LoadedPack> {
  const rawPackId = options.packId?.trim() || 'mbs_agent_v1_1';
  if (!PACK_ID_PATTERN.test(rawPackId)) {
    throw new Error(
      `Invalid packId "${rawPackId}". packId must match ${PACK_ID_PATTERN.toString()}`,
    );
  }
  const packId = rawPackId;
  const explicitBaseDir = normalizedOptionalPath(options.baseDir);
  const baseDir =
    explicitBaseDir ||
    normalizedOptionalPath(process.env.AGENT_PLAYBOOK_PACKS_DIR) ||
    join(repoRoot, 'apps', 'api', 'tests', 'fixtures', 'agent-playbooks');
  const packRoot = join(baseDir, packId);
  if (!explicitBaseDir) {
    await verifyPackIntegrity({
      packId,
      packRoot,
    });
  }
  const pack = await loadPackFromDir(packRoot);
  if (pack.packId !== packId) {
    throw new Error(
      `Pack identity mismatch: requested ${packId}, loaded ${pack.packId}`,
    );
  }
  validatePack(pack);
  return pack;
}

export async function executePlaybook(args: ExecutePlaybookCompatArgs): Promise<PlaybookRuntimeResult> {
  const resolvedCorrelationId = args.correlationId ?? args.context.correlationId;
  if (typeof resolvedCorrelationId !== 'string' || resolvedCorrelationId.trim().length < 1) {
    throw new Error('correlationId is required for deterministic playbook execution');
  }

  return executePlaybookRuntime({
    pack: args.pack,
    playbookStableId: args.playbookStableId,
    packVersion: args.packVersion,
    inputs: args.inputs,
    executionContext: args.context,
    correlationId: resolvedCorrelationId.trim(),
    registry: args.registry,
    maxSteps: args.maxSteps,
    maxStepExecutionMs: args.maxStepExecutionMs,
    maxStepPayloadBytes: args.maxStepPayloadBytes,
    maxStepPayloadDepth: args.maxStepPayloadDepth,
    maxStepPayloadKeys: args.maxStepPayloadKeys,
  });
}
