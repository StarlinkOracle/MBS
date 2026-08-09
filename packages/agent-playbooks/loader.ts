import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  LoadedPack,
  PlaybookDefinition,
  SkillDefinition,
  ToolsCatalog,
} from './types.js';

const JSON_FILE_SUFFIX = '.json';

type PackLoadBudget = {
  maxFiles: number;
  maxTotalBytes: number;
  maxJsonFileBytes: number;
  filesRead: number;
  bytesRead: number;
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

function createPackLoadBudget(): PackLoadBudget {
  return {
    maxFiles: parsePositiveInt(process.env.AGENT_PLAYBOOK_MAX_FILES, 500),
    maxTotalBytes: parsePositiveInt(process.env.AGENT_PLAYBOOK_MAX_TOTAL_BYTES, 5 * 1024 * 1024),
    maxJsonFileBytes: parsePositiveInt(
      process.env.AGENT_PLAYBOOK_MAX_JSON_FILE_BYTES,
      512 * 1024,
    ),
    filesRead: 0,
    bytesRead: 0,
  };
}

async function readJsonFile<T>(filePath: string, budget: PackLoadBudget): Promise<T> {
  const fileInfo = await lstat(filePath);
  if (fileInfo.isSymbolicLink()) {
    throw new Error(`Symlinked pack files are not allowed: ${filePath}`);
  }
  if (!fileInfo.isFile()) {
    throw new Error(`Expected JSON file at ${filePath}`);
  }
  if (fileInfo.size > budget.maxJsonFileBytes) {
    throw new Error(
      `Pack JSON file exceeds max size (${fileInfo.size} > ${budget.maxJsonFileBytes}): ${filePath}`,
    );
  }
  if (budget.filesRead + 1 > budget.maxFiles) {
    throw new Error(
      `Pack exceeds max JSON file count (${budget.maxFiles})`,
    );
  }
  if (budget.bytesRead + fileInfo.size > budget.maxTotalBytes) {
    throw new Error(
      `Pack exceeds max JSON bytes (${budget.bytesRead + fileInfo.size} > ${budget.maxTotalBytes})`,
    );
  }
  budget.filesRead += 1;
  budget.bytesRead += fileInfo.size;
  const raw = await readFile(filePath, 'utf8');
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown parse error';
    throw new Error(`Invalid JSON at ${filePath}: ${message}`);
  }
}

async function readJsonDirectory<T>(directoryPath: string, budget: PackLoadBudget): Promise<T[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const fileNames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(JSON_FILE_SUFFIX))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const rows: T[] = [];
  for (const fileName of fileNames) {
    rows.push(await readJsonFile<T>(join(directoryPath, fileName), budget));
  }
  return rows;
}

async function readSchemaWithFallback(args: {
  packDir: string;
  schemaDir: string;
  schemaFile: string;
  rootFallbackFile: string;
  budget: PackLoadBudget;
}): Promise<Record<string, unknown>> {
  const isMissingFile = (error: unknown): boolean =>
    Boolean(
      error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT',
    );
  try {
    return await readJsonFile<Record<string, unknown>>(
      join(args.schemaDir, args.schemaFile),
      args.budget,
    );
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
    return await readJsonFile<Record<string, unknown>>(
      join(args.packDir, args.rootFallbackFile),
      args.budget,
    );
  }
}

export async function loadPackFromDir(packDir: string): Promise<LoadedPack> {
  const budget = createPackLoadBudget();
  const schemaDir = join(packDir, 'schema');
  const [
    toolsCatalog,
    skills,
    playbooks,
    toolsCatalogSchema,
    skillSchema,
    playbookSchema,
    resultsSchema,
  ] = await Promise.all([
    readJsonFile<ToolsCatalog>(join(packDir, 'tools_catalog.json'), budget),
    readJsonDirectory<SkillDefinition>(join(packDir, 'skills'), budget),
    readJsonDirectory<PlaybookDefinition>(join(packDir, 'playbooks'), budget),
    readSchemaWithFallback({
      packDir,
      schemaDir,
      schemaFile: 'tools_catalog.schema.json',
      rootFallbackFile: 'tools_catalog.schema.json',
      budget,
    }),
    readSchemaWithFallback({
      packDir,
      schemaDir,
      schemaFile: 'skill.schema.json',
      rootFallbackFile: 'skill.schema.json',
      budget,
    }),
    readSchemaWithFallback({
      packDir,
      schemaDir,
      schemaFile: 'playbook.schema.json',
      rootFallbackFile: 'playbook.schema.json',
      budget,
    }),
    (async () => {
      try {
        return await readSchemaWithFallback({
          packDir,
          schemaDir,
          schemaFile: 'results.schema.json',
          rootFallbackFile: 'results.schema.json',
          budget,
        });
      } catch {
        return undefined;
      }
    })(),
  ]);

  return {
    packId: toolsCatalog.packId ?? 'unknown',
    packVersion: toolsCatalog.version,
    rootDir: packDir,
    schemas: {
      toolsCatalog: toolsCatalogSchema,
      skill: skillSchema,
      playbook: playbookSchema,
      ...(resultsSchema ? { results: resultsSchema } : {}),
    },
    toolsCatalog,
    skills,
    playbooks,
    skillsByStableId: new Map(skills.map((skill) => [skill.stableId, skill])),
    playbooksByStableId: new Map(playbooks.map((playbook) => [playbook.stableId, playbook])),
  };
}
