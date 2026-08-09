import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const manifestPath = join(
  repoRoot,
  'apps',
  'api',
  'tests',
  'fixtures',
  'EXTERNAL_PACKS_MANIFEST.json',
);

type ManifestFile = {
  path: string;
  sizeBytes: number;
  sha256: string;
};

type ManifestPack = {
  id: string;
  sourceRepo: string;
  sourceRef: string;
  rootPath: string;
  fileCount: number;
  packSha256: string;
  packContentSha256?: string;
  files: ManifestFile[];
};

type Manifest = {
  manifestVersion: number;
  generatedAt: string;
  packs: ManifestPack[];
};

function sha256(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
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

describe('external pack fixtures manifest', () => {
  it('pins fixture snapshots for legal and orchestration packs', async () => {
    const raw = await readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(raw) as Manifest;

    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.packs.length).toBeGreaterThanOrEqual(2);

    for (const pack of manifest.packs) {
      expect(pack.sourceRepo.startsWith('StarlinkOracle/')).toBe(true);
      expect(pack.sourceRef.length).toBeGreaterThan(0);
      const rootPath = join(repoRoot, pack.rootPath);

      const files = (await walkFiles(rootPath)).sort((a, b) => a.localeCompare(b));
      expect(files.length).toBe(pack.fileCount);

      const computedFiles: ManifestFile[] = [];
      const contentRows: string[] = [];
      for (const file of files) {
        const relative = file.replace(`${repoRoot}/`, '');
        const relativeToPack = file.replace(`${rootPath}/`, '');
        const content = await readFile(file);
        const fileHash = sha256(content);
        computedFiles.push({
          path: relative,
          sizeBytes: content.byteLength,
          sha256: fileHash,
        });
        contentRows.push(`${relativeToPack}:${fileHash}`);
      }
      computedFiles.sort((a, b) => a.path.localeCompare(b.path));
      contentRows.sort((a, b) => a.localeCompare(b));

      const computedPackHash = sha256(
        computedFiles.map((row) => `${row.path}:${row.sha256}`).join('\n'),
      );
      const computedPackContentHash = sha256(contentRows.join('\n'));

      expect(computedFiles).toEqual(pack.files);
      expect(computedPackHash).toBe(pack.packSha256);
      if (pack.packContentSha256) {
        expect(computedPackContentHash).toBe(pack.packContentSha256);
      }
    }
  });
});
