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

async function computePackDigest(rootPath) {
  const absoluteRoot = path.join(REPO_ROOT, rootPath);
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
      sha256: fileHash,
    });
    contentRows.push(`${relativeToPack}:${fileHash}`);
  }
  rows.sort((a, b) => a.path.localeCompare(b.path));
  contentRows.sort((a, b) => a.localeCompare(b));
  return {
    packSha256: sha256(rows.map((row) => `${row.path}:${row.sha256}`).join('\n')),
    packContentSha256: sha256(contentRows.join('\n')),
  };
}

async function main() {
  const manifestRaw = await fs.readFile(MANIFEST_PATH, 'utf8');
  const manifest = JSON.parse(manifestRaw);
  if (!manifest || !Array.isArray(manifest.packs)) {
    throw new Error('Invalid external pack manifest format');
  }

  const mismatches = [];
  for (const pack of manifest.packs) {
    const expected = String(pack.packSha256 || '');
    const expectedContent = String(pack.packContentSha256 || '');
    const actual = await computePackDigest(String(pack.rootPath));
    if (expected !== actual.packSha256 || (expectedContent && expectedContent !== actual.packContentSha256)) {
      mismatches.push({
        id: pack.id,
        expectedPackSha256: expected,
        actualPackSha256: actual.packSha256,
        expectedPackContentSha256: expectedContent || null,
        actualPackContentSha256: actual.packContentSha256,
      });
    }
  }

  if (mismatches.length > 0) {
    console.error('External fixture pack drift detected:');
    for (const mismatch of mismatches) {
      console.error(
        `- ${mismatch.id}: expected pack=${mismatch.expectedPackSha256}, actual pack=${mismatch.actualPackSha256}, expected content=${mismatch.expectedPackContentSha256}, actual content=${mismatch.actualPackContentSha256}`,
      );
    }
    process.exitCode = 1;
    return;
  }

  console.log('External fixture pack manifest is up to date.');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[verify-external-pack-manifest] ${message}`);
  process.exitCode = 1;
});
