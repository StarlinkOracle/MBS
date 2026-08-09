#!/usr/bin/env node

const { register } = require('tsx/cjs/api');
const { PrismaClient, ActorType } = require('@prisma/client');
const { join } = require('node:path');
const { readFile } = require('node:fs/promises');

register();

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = 'true';
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function printUsage() {
  console.log(
    [
      'Usage:',
      '  node scripts/import-legal-pack.ts \\',
      '    --repo StarlinkOracle/Artifacts-Legal-Packs \\',
      '    --tag CO-v1.0.0 \\',
      '    --pack packs/CO/v1 \\',
      '    [--orgId <orgId>] [--sourceDir <localDir>] \\',
      '    [--expectedPackSha256 <sha256>] [--expectedArchiveSha256 <sha256>] \\',
      '    [--enforceManifest true|false] [--manifestPath <path>]',
      '',
      'Notes:',
      '  - --sourceDir is for offline/fixture runs and should point at extracted repo root.',
      '  - If --orgId is omitted, the importer uses MBS_IMPORT_ORG_ID or the oldest org row.',
      '  - --enforceManifest defaults to true.',
    ].join('\n'),
  );
}

function normalizedOptionalPath(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'undefined' || trimmed === 'null') {
    return undefined;
  }
  return trimmed;
}

function parseBoolean(value, fallback) {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseIssueKeys(value) {
  if (typeof value !== 'string') {
    return [];
  }
  return [...new Set(value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0))]
    .sort((a, b) => a.localeCompare(b));
}

function resolveHealthSnapshotPath() {
  return normalizedOptionalPath(process.env.LEGAL_PACK_IMPORT_HEALTH_SNAPSHOT_PATH)
    || normalizedOptionalPath(process.env.HEALTH_SNAPSHOT_LOG_PATH)
    || join(process.env.HOME || '', 'mbs-backups', 'health-history.jsonl');
}

function normalizeHealthSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const row = raw;
  const statusRaw = row.status ?? row.overall;
  const status = typeof statusRaw === 'string' ? statusRaw.toUpperCase() : 'UNKNOWN';
  if (!['OK', 'WARN', 'CRITICAL'].includes(status)) {
    return null;
  }
  const issuesRaw = Array.isArray(row.issues) ? row.issues : [];
  const issues = issuesRaw
    .map((issue) => {
      if (!issue || typeof issue !== 'object' || Array.isArray(issue)) {
        return null;
      }
      const key = typeof issue.key === 'string' ? issue.key.trim() : '';
      const levelRaw = typeof issue.level === 'string' ? issue.level.trim().toUpperCase() : 'WARN';
      if (!key) {
        return null;
      }
      return {
        key,
        level: levelRaw === 'CRITICAL' ? 'CRITICAL' : 'WARN',
      };
    })
    .filter((issue) => issue !== null);
  return {
    status,
    issues,
  };
}

async function loadLatestHealthSnapshot(path) {
  const raw = await readFile(path, 'utf8');
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`Health snapshot file is empty: ${path}`);
  }

  const lines = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      const normalized = normalizeHealthSnapshot(parsed);
      if (normalized) {
        return normalized;
      }
    } catch {
      // ignore malformed line and continue searching backward
    }
  }
  throw new Error(`No valid health snapshot rows found in ${path}`);
}

function buildGovernanceGateFromEnv() {
  const enabled = parseBoolean(process.env.LEGAL_PACK_IMPORT_FAIL_CLOSED_ENABLED, false);
  if (!enabled) {
    return undefined;
  }
  const blockOnCritical = parseBoolean(
    process.env.LEGAL_PACK_IMPORT_FAIL_CLOSED_ON_CRITICAL,
    false,
  );
  const blockedIssueKeys = parseIssueKeys(process.env.LEGAL_PACK_IMPORT_FAIL_CLOSED_ISSUE_KEYS);
  const healthSnapshotPath = resolveHealthSnapshotPath();

  return async () => {
    let snapshot;
    try {
      snapshot = await loadLatestHealthSnapshot(healthSnapshotPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        allowed: false,
        code: 'LEGAL_PACK_GOVERNANCE_UNAVAILABLE',
        message: `Failed to load health snapshot for fail-closed gate: ${message}`,
        details: {
          healthSnapshotPath,
        },
      };
    }

    const matchedIssueKeys = snapshot.issues
      .filter((issue) => blockedIssueKeys.includes(issue.key))
      .map((issue) => issue.key)
      .sort((a, b) => a.localeCompare(b));

    if (blockOnCritical && snapshot.status === 'CRITICAL') {
      const criticalKeys = snapshot.issues
        .filter((issue) => issue.level === 'CRITICAL')
        .map((issue) => issue.key)
        .sort((a, b) => a.localeCompare(b));
      return {
        allowed: false,
        code: 'LEGAL_PACK_FAIL_CLOSED',
        message: 'Legal pack import blocked by fail-closed governance: health status is CRITICAL',
        details: {
          healthStatus: snapshot.status,
          blockedIssueKeys: criticalKeys,
          configuredIssueKeys: blockedIssueKeys,
          healthSnapshotPath,
        },
      };
    }

    if (matchedIssueKeys.length > 0) {
      return {
        allowed: false,
        code: 'LEGAL_PACK_FAIL_CLOSED',
        message: 'Legal pack import blocked by fail-closed governance issue keys',
        details: {
          healthStatus: snapshot.status,
          blockedIssueKeys: matchedIssueKeys,
          configuredIssueKeys: blockedIssueKeys,
          healthSnapshotPath,
        },
      };
    }

    return { allowed: true };
  };
}

async function resolveOrgId(prisma, args) {
  if (typeof args.orgId === 'string' && args.orgId.trim().length > 0) {
    return args.orgId.trim();
  }
  if (typeof process.env.MBS_IMPORT_ORG_ID === 'string' && process.env.MBS_IMPORT_ORG_ID.trim().length > 0) {
    return process.env.MBS_IMPORT_ORG_ID.trim();
  }
  const org = await prisma.organization.findFirst({
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!org) {
    throw new Error('No organization found. Pass --orgId or set MBS_IMPORT_ORG_ID.');
  }
  return org.id;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.repo || !args.tag || !args.pack) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient();
  let cleanup = async () => {};
  try {
    const startedAtMs = Date.now();
    const { ToolRegistry } = require('@rcs/tool-registry');
    const importerPath = join(process.cwd(), 'apps', 'api', 'src', 'legal-pack-importer.ts');
    const importerModule = require(importerPath);
    const {
      computePackContentSha256,
      executeLegalPackImport,
      loadLegalPackArtifacts,
      resolvePackDirectory,
      verifyPackContentFromManifest,
      verifyPackContentSha256,
      validateLegalPackArtifacts,
    } = importerModule;

    const orgId = await resolveOrgId(prisma, args);
    const actorUserId =
      typeof process.env.MBS_IMPORT_ACTOR_USER_ID === 'string' && process.env.MBS_IMPORT_ACTOR_USER_ID.trim().length > 0
        ? process.env.MBS_IMPORT_ACTOR_USER_ID.trim()
        : undefined;

    const resolved = await resolvePackDirectory({
      repo: String(args.repo),
      tag: String(args.tag),
      packPath: String(args.pack),
      sourceDir: normalizedOptionalPath(args.sourceDir),
      expectedArchiveSha256: normalizedOptionalPath(args.expectedArchiveSha256),
    });
    cleanup = resolved.cleanup;

    const enforceManifest = String(args.enforceManifest ?? 'true').toLowerCase() !== 'false';
    const expectedPackSha256 = normalizedOptionalPath(args.expectedPackSha256) ?? null;
    const manifestPath = normalizedOptionalPath(args.manifestPath) ||
      normalizedOptionalPath(process.env.EXTERNAL_PACKS_MANIFEST_PATH) ||
      join(process.cwd(), 'apps', 'api', 'tests', 'fixtures', 'EXTERNAL_PACKS_MANIFEST.json');

    const contentSha256 = await computePackContentSha256(resolved.packDir);
    if (expectedPackSha256) {
      await verifyPackContentSha256({
        packDir: resolved.packDir,
        expectedSha256: expectedPackSha256,
      });
    } else if (enforceManifest) {
      await verifyPackContentFromManifest({
        packDir: resolved.packDir,
        sourceRepo: String(args.repo),
        sourceRef: String(args.tag),
        manifestPath,
      });
    }

    console.log(
      JSON.stringify(
        {
          phase: 'integrity',
          repo: args.repo,
          tag: args.tag,
          packPath: args.pack,
          contentSha256,
          integritySource: expectedPackSha256 ? 'expectedPackSha256' : (enforceManifest ? 'manifest' : 'none'),
        },
        null,
        2,
      ),
    );

    const artifacts = await loadLegalPackArtifacts(resolved.packDir);
    const validation = validateLegalPackArtifacts(artifacts);

    console.log(
      JSON.stringify(
        {
          phase: 'validation',
          repo: args.repo,
          tag: args.tag,
          packPath: args.pack,
          orgId,
          clauses: validation.clauseStableIds.length,
          templates: validation.templateStableIds.length,
          placeholders: validation.placeholderKeys.length,
        },
        null,
        2,
      ),
    );

    const registry = new ToolRegistry(prisma);
    const governanceGate = buildGovernanceGateFromEnv();
    const result = await executeLegalPackImport({
      artifacts,
      registry,
      repo: String(args.repo),
      tag: String(args.tag),
      governanceGate,
      context: {
        orgId,
        actorType: ActorType.SYSTEM,
        actorUserId,
        actorLabel: 'legal-pack-importer',
        isAutonomous: false,
        reason: `import legal pack ${args.tag}`,
      },
    });

    console.log(JSON.stringify(result, null, 2));
    console.log(
      JSON.stringify(
        {
          phase: 'complete',
          status: result.status,
          durationMs: Date.now() - startedAtMs,
          executedStepCount: result.executedSteps.length,
          queuedApproval: result.approval ?? null,
          error: result.error ?? null,
        },
        null,
        2,
      ),
    );

    if (result.status === 'FAILED' || result.status === 'BLOCKED') {
      process.exitCode = 2;
    } else if (result.status === 'NEEDS_APPROVAL') {
      process.exitCode = 3;
    }
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[import-legal-pack] ${message}`);
  process.exitCode = 1;
});
