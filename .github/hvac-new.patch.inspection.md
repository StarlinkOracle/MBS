# HVAC staged patch inspection

Generated: 2026-08-09T22:35:13Z

XZ status: 1

## Decoder output
```text
xz: /tmp/hvac-new.patch.xz: Unexpected end of input
```

## Recovered patch bytes
```text
52394 /tmp/hvac-new.partial.patch
```

## Recovered file paths
```text
.github/workflows/generate-hvac-migration.yml
.github/workflows/hvac-diagnostic-ci.yml
apps/api/src/hvac-diagnostic-ai.ts
apps/api/src/hvac-diagnostic-report.ts
apps/api/src/hvac-diagnostic-routes.ts
apps/web/public/icon.svg
```

## Recovered patch header
```diff
diff --git a/.github/workflows/generate-hvac-migration.yml b/.github/workflows/generate-hvac-migration.yml
new file mode 100644
index 0000000000000000000000000000000000000000..5f9706dc48c51e9e1ee409f1a452f050ac10053a
--- /dev/null
+++ b/.github/workflows/generate-hvac-migration.yml
@@ -0,0 +1,47 @@
+name: Generate HVAC diagnostic migration
+
+on:
+  push:
+    branches:
+      - feature/hvac-diagnostic-pwa
+    paths:
+      - "packages/db/prisma/schema.prisma"
+      - ".github/workflows/generate-hvac-migration.yml"
+  workflow_dispatch:
+
+permissions:
+  contents: read
+
+jobs:
+  migration:
+    runs-on: ubuntu-latest
+    timeout-minutes: 15
+    steps:
+      - uses: actions/checkout@v4
+      - uses: actions/setup-node@v4
+        with:
+          node-version: 20
+          cache: npm
+      - name: Install dependencies
+        run: npm ci --no-audit --no-fund
+      - name: Extract pre-feature Prisma schema
+        shell: bash
+        run: |
+          set -euo pipefail
+          unzip -p MBS_FULL_REPO_BUNDLE.zip packages/db/prisma/schema.prisma > /tmp/schema-before.prisma
+          test -s /tmp/schema-before.prisma
+      - name: Generate SQL migration
+        shell: bash
+        run: |
+          set -euo pipefail
+          mkdir -p generated-migration
+          npx prisma migrate diff \
+            --from-schema-datamodel /tmp/schema-before.prisma \
+            --to-schema-datamodel packages/db/prisma/schema.prisma \
+            --script > generated-migration/migration.sql
+          test -s generated-migration/migration.sql
+      - uses: actions/upload-artifact@v4
+        with:
+          name: hvac-diagnostic-migration
+          path: generated-migration/migration.sql
+          retention-days: 3
diff --git a/.github/workflows/hvac-diagnostic-ci.yml b/.github/workflows/hvac-diagnostic-ci.yml
new file mode 100644
index 0000000000000000000000000000000000000000..e0a543d0f97d78983521d681850d3f3daf0d8525
--- /dev/null
+++ b/.github/workflows/hvac-diagnostic-ci.yml
@@ -0,0 +1,51 @@
+name: HVAC diagnostic CI
+
+on:
+  push:
+    branches:
+      - feature/hvac-diagnostic-pwa
+    paths:
+      - "apps/api/**"
+      - "apps/web/**"
+      - "packages/db/**"
+      - "packages/shared/**"
+      - "packages/tool-registry/**"
+      - "docker-compose.yml"
+      - "docs/HVAC_DIAGNOSTIC_PWA.md"
+      - ".github/workflows/hvac-diagnostic-ci.yml"
+  pull_request:
+    paths:
+      - "apps/api/**"
+      - "apps/web/**"
+      - "packages/db/**"
+      - "packages/shared/**"
+      - "packages/tool-registry/**"
+      - "docker-compose.yml"
+      - "docs/HVAC_DIAGNOSTIC_PWA.md"
+      - ".github/workflows/hvac-diagnostic-ci.yml"
+
+permissions:
+  contents: read
+
+jobs:
+  validate:
+    runs-on: ubuntu-latest
+    timeout-minutes: 25
+    steps:
+      - uses: actions/checkout@v4
+      - uses: actions/setup-node@v4
+        with:
+          node-version: 20
+          cache: npm
+      - name: Install dependencies
+        run: npm ci --no-audit --no-fund
+      - name: Generate Prisma client
+        run: npm run db:generate
+      - name: Validate Prisma schema
+        run: npx prisma validate --schema packages/db/prisma/schema.prisma
+      - name: Typecheck
+        run: npm run typecheck
+      - name: Test
+        run: npm test
+      - name: Build
+        run: npm run build
diff --git a/apps/api/src/hvac-diagnostic-ai.ts b/apps/api/src/hvac-diagnostic-ai.ts
new file mode 100644
index 0000000000000000000000000000000000000000..2d93647bc1dc8d04f4fd28e81ae8db03f91cea9f
--- /dev/null
+++ b/apps/api/src/hvac-diagnostic-ai.ts
@@ -0,0 +1,364 @@
+import type {
+  HvacDiagnosticSnapshot,
+  HvacFindingDraft,
+  HvacNextStep,
+} from '@rcs/shared';
+
+const DEFAULT_MODEL = process.env.OPENAI_DIAGNOSTIC_MODEL?.trim() || 'gpt-5-mini';
+const DEFAULT_TIMEOUT_MS = Number(process.env.OPENAI_DIAGNOSTIC_TIMEOUT_MS ?? 20_000);
+const RESPONSES_URL = 'https://api.openai.com/v1/responses';
+
+export type HvacAiReplyResult = {
+  text: string;
+  provider: 'openai' | 'deterministic';
+  model: string | null;
+  fallbackReason?: string;
+};
+
+export type HvacNameplateExtraction = {
+  manufacturer: string | null;
+  model: string | null;
+  serial: string | null;
+  equipmentType: string | null;
+  refrigerant: string | null;
+  voltage: string | null;
+  phase: string | null;
+  frequencyHz: number | null;
+  minimumCircuitAmpacity: number | null;
+  maximumOvercurrentProtection: number | null;
+  compressorRla: number | null;
+  factoryCharge: string | null;
+  notes: string[];
+};
+
+export type HvacNameplateExtractionResult = {
+  extraction: HvacNameplateExtraction;
+  provider: 'openai';
+  model: string;
+};
+
+function aiEnabled(): boolean {
+  const configured = (process.env.OPENAI_DIAGNOSTIC_AI_ENABLED ?? '').trim().toLowerCase();
+  if (configured === 'false' || configured === '0' || configured === 'off') {
+    return false;
+  }
+  return Boolean(process.env.OPENAI_API_KEY?.trim());
+}
+
+function safeTimeoutMs(): number {
+  return Number.isFinite(DEFAULT_TIMEOUT_MS)
+    ? Math.min(Math.max(DEFAULT_TIMEOUT_MS, 2_000), 60_000)
+    : 20_000;
+}
+
+function redactSensitiveText(value: string): string {
+  return value
+    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email redacted]')
+    .replace(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, '[phone redacted]')
+    .replace(/\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,4}\s+(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Court|Ct|Boulevard|Blvd|Way)\b/gi, '[address redacted]');
+}
+
+function outputTextFromResponse(payload: unknown): string | null {
+  if (!payload || typeof payload !== 'object') {
+    return null;
+  }
+
+  const record = payload as Record<string, unknown>;
+  if (typeof record.output_text === 'string' && record.output_text.trim()) {
+    return record.output_text.trim();
+  }
+
+  if (!Array.isArray(record.output)) {
+    return null;
+  }
+
+  const parts: string[] = [];
+  for (const item of record.output) {
+    if (!item || typeof item !== 'object') {
+      continue;
+    }
+    const content = (item as Record<string, unknown>).content;
+    if (!Array.isArray(content)) {
+      continue;
+    }
+    for (const part of content) {
+      if (!part || typeof part !== 'object') {
+        continue;
+      }
+      const partRecord = part as Record<string, unknown>;
+      if (typeof partRecord.text === 'string' && partRecord.text.trim()) {
+        parts.push(partRecord.text.trim());
+      }
+    }
+  }
+  return parts.length > 0 ? parts.join('\n') : null;
+}
+
+async function callResponsesApi(body: Record<string, unknown>): Promise<unknown> {
+  const apiKey = process.env.OPENAI_API_KEY?.trim();
+  if (!apiKey) {
+    throw new Error('OPENAI_API_KEY is not configured');
+  }
+
+  const controller = new AbortController();
+  const timeout = setTimeout(() => controller.abort(), safeTimeoutMs());
+  try {
+    const response = await fetch(RESPONSES_URL, {
+      method: 'POST',
+      headers: {
+        Authorization: `Bearer ${apiKey}`,
+        'Content-Type': 'application/json',
+      },
+      body: JSON.stringify(body),
+      signal: controller.signal,
+    });
+
+    const rawText = await response.text();
+    let payload: unknown = null;
+    try {
+      payload = rawText ? JSON.parse(rawText) : null;
+    } catch {
+      payload = null;
+    }
+
+    if (!response.ok) {
```
