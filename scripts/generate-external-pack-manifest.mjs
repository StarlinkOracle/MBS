#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const MANIFEST_PATH = path.join(
  REPO_ROOT,
  'apps',
  'api',
  'tests',
  'fixtures',
  'EXTERNAL_PACKS_MANIFEST.json',
);

const PACKS = [
  {
    id: 'mbs_agent_v1_1',
    sourceRepo: 'StarlinkOracle/MBS-Agent-Orchestration-Packs',
    sourceRef: 'mbs_agent_v1_1',
    path: 'apps/api/tests/fixtures/agent-playbooks/mbs_agent_v1_1',
  },
  {
    id: 'mbs_agent_v1',
    sourceRepo: 'StarlinkOracle/MBS-Agent-Orchestration-Packs',
    sourceRef: 'mbs_agent_v1',
    path: 'apps/api/tests/fixtures/agent-playbooks/mbs_agent_v1',
  },
  {
    id: 'co_legal_pack_v1',
    sourceRepo: 'StarlinkOracle/Artifacts-Legal-Packs',
    sourceRef: 'CO-v1.0.0',
    path: 'apps/api/tests/fixtures/legal-packs/CO/v1',
  },
];

function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

async function walkFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(directory, entry.name);
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

async function buildPackManifest(pack) {
  const absoluteRoot = path.join(REPO_ROOT, pack.path);
  const files = await walkFiles(absoluteRoot);
  const rows = [];
  const contentRows = [];
  for (const file of files) {
    const relative = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    const relativeToPack = path.relative(absoluteRoot, file).split(path.sep).join('/');
    const content = await fs.readFile(file);
    const fileHash = sha256(content);
    rows.push({
      path: relative,
      sizeBytes: content.byteLength,
      sha256: fileHash,
    });
    contentRows.push(`${relativeToPack}:${fileHash}`);
  }
  rows.sort((a, b) => a.path.localeCompare(b.path));
  contentRows.sort((a, b) => a.localeCompare(b));

  const packDigestInput = rows.map((row) => `${row.path}:${row.sha256}`).join('\n');
  return {
    id: pack.id,
    sourceRepo: pack.sourceRepo,
    sourceRef: pack.sourceRef,
    rootPath: pack.path,
    fileCount: rows.length,
    packSha256: sha256(packDigestInput),
    packContentSha256: sha256(contentRows.join('\n')),
    files: rows,
  };
}

async function main() {
  const packs = [];
  for (const pack of PACKS) {
    packs.push(await buildPackManifest(pack));
  }
  packs.sort((a, b) => a.id.localeCompare(b.id));

  const manifest = {
    manifestVersion: 1,
    generatedAt: new Date().toISOString(),
    packs,
  };

  await fs.writeFile(`${MANIFEST_PATH}`, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${MANIFEST_PATH}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[generate-external-pack-manifest] ${message}`);
  process.exitCode = 1;
});
