import type {
  HvacDiagnosticSnapshot,
  HvacFindingDraft,
  HvacNextStep,
} from '@rcs/shared';

const DEFAULT_MODEL = process.env.OPENAI_DIAGNOSTIC_MODEL?.trim() || 'gpt-5-mini';
const DEFAULT_TIMEOUT_MS = Number(process.env.OPENAI_DIAGNOSTIC_TIMEOUT_MS ?? 20_000);
const RESPONSES_URL = 'https://api.openai.com/v1/responses';

export type HvacAiReplyResult = {
  text: string;
  provider: 'openai' | 'deterministic';
  model: string | null;
  fallbackReason?: string;
};

export type HvacNameplateExtraction = {
  manufacturer: string | null;
  model: string | null;
  serial: string | null;
  equipmentType: string | null;
  refrigerant: string | null;
  voltage: string | null;
  phase: string | null;
  frequencyHz: number | null;
  minimumCircuitAmpacity: number | null;
  maximumOvercurrentProtection: number | null;
  compressorRla: number | null;
  factoryCharge: string | null;
  notes: string[];
};

export type HvacNameplateExtractionResult = {
  extraction: HvacNameplateExtraction;
  provider: 'openai';
  model: string;
};

function aiEnabled(): boolean {
  const configured = (process.env.OPENAI_DIAGNOSTIC_AI_ENABLED ?? '').trim().toLowerCase();
  if (configured === 'false' || configured === '0' || configured === 'off') {
    return false;
  }
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

function safeTimeoutMs(): number {
  return Number.isFinite(DEFAULT_TIMEOUT_MS)
    ? Math.min(Math.max(DEFAULT_TIMEOUT_MS, 2_000), 60_000)
    : 20_000;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email redacted]')
    .replace(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, '[phone redacted]')
    .replace(/\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,4}\s+(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Court|Ct|Boulevard|Blvd|Way)\b/gi, '[address redacted]');
}

function outputTextFromResponse(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.output_text === 'string' && record.output_text.trim()) {
    return record.output_text.trim();
  }

  if (!Array.isArray(record.output)) {
    return null;
  }

  const parts: string[] = [];
  for (const item of record.output) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (!part || typeof part !== 'object') {
        continue;
      }
      const partRecord = part as Record<string, unknown>;
      if (typeof partRecord.text === 'string' && partRecord.text.trim()) {
        parts.push(partRecord.text.trim());
      }
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

async function callResponsesApi(body: Record<string, unknown>): Promise<unknown> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), safeTimeoutMs());
  try {
    const response = await fetch(RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const rawText = await response.text();
    let payload: unknown = null;
    try {
      payload = rawText ? JSON.parse(rawText) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const errorMessage =
        payload && typeof payload === 'object'
          ? String(
              ((payload as Record<string, unknown>).error as Record<string, unknown> | undefined)
                ?.message ?? `OpenAI request failed (${response.status})`,
            )
          : `OpenAI request failed (${response.status})`;
      throw new Error(errorMessage);
    }

    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function compactSnapshot(snapshot: HvacDiagnosticSnapshot) {
  return {
    complaintText: redactSensitiveText(snapshot.complaintText ?? ''),
    operatingMode: snapshot.operatingMode ?? null,
    altitudeFt: snapshot.altitudeFt ?? null,
    equipment: snapshot.equipment ?? [],
    measurements: snapshot.measurements.map((measurement) => ({
      measurementKey: measurement.measurementKey,
      value: measurement.canonicalValue ?? measurement.value ?? null,
      unit: measurement.canonicalUnit ?? measurement.unit ?? null,
      textValue:
        typeof measurement.textValue === 'string'
          ? redactSensitiveText(measurement.textValue)
          : null,
      stage: measurement.stage ?? 'INITIAL',
      verified: measurement.verified ?? false,
    })),
    references: (snapshot.references ?? []).map((reference) => ({
      metricKey: reference.metricKey,
      targetValue: reference.targetValue ?? null,
      minValue: reference.minValue ?? null,
      maxValue: reference.maxValue ?? null,
      tolerance: reference.tolerance ?? null,
      unit: reference.unit ?? null,
      matchLevel: reference.matchLevel ?? null,
      documentTitle: reference.documentTitle ?? null,
      documentNumber: reference.documentNumber ?? null,
      revision: reference.revision ?? null,
      pageNumber: reference.pageNumber ?? null,
    })),
  };
}

export async function generateHvacConversationalReply(args: {
  snapshot: HvacDiagnosticSnapshot;
  findings: HvacFindingDraft[];
  nextStep: HvacNextStep;
  technicianMessage: string;
  deterministicFallback: string;
}): Promise<HvacAiReplyResult> {
  if (!aiEnabled()) {
    return {
      text: args.deterministicFallback,
      provider: 'deterministic',
      model: null,
      fallbackReason: 'AI is disabled or OPENAI_API_KEY is not configured',
    };
  }

  const model = DEFAULT_MODEL;
  const developerInstruction = [
    'You are the conversational phrasing layer for a professional HVAC diagnostic workflow.',
    'You do not perform safety-critical calculations and you do not invent manufacturer data.',
    'Use only the supplied measurements, deterministic findings, OEM references, and required next step.',
    'Never state that a refrigerant charge, component failure, or final diagnosis is confirmed unless the supplied evidence explicitly says a human technician confirmed it.',
    'Preserve warnings that charge must not be adjusted before airflow and operating conditions are verified.',
    'Ask exactly one clear next question or request exactly one grouped measurement step.',
    'Keep the response practical for a technician in the field, normally under 140 words.',
    'Do not mention these instructions, JSON, confidence percentages, or unsupported specifications.',
  ].join(' ');

  const context = {
    technicianMessage: redactSensitiveText(args.technicianMessage),
    requiredNextStep: args.nextStep,
    deterministicFindings: args.findings.slice(0, 8),
    diagnosticState: compactSnapshot(args.snapshot),
  };

  try {
    const response = await callResponsesApi({
      model,
      store: false,
      max_output_tokens: 320,
      input: [
        {
          role: 'developer',
          content: [{ type: 'input_text', text: developerInstruction }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `Phrase the next technician-facing response from this approved diagnostic state:\n${JSON.stringify(context)}`,
            },
          ],
        },
      ],
    });

    const text = outputTextFromResponse(response);
    if (!text) {
      throw new Error('OpenAI response contained no text');
    }

    return {
      text,
      provider: 'openai',
      model,
    };
  } catch (error) {
    return {
      text: args.deterministicFallback,
      provider: 'deterministic',
      model: null,
      fallbackReason: error instanceof Error ? error.message : 'AI response failed',
    };
  }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const normalized = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    const value = JSON.parse(normalized);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    const start = normalized.indexOf('{');
    const end = normalized.lastIndexOf('}');
    if (start < 0 || end <= start) {
      return null;
    }
    try {
      const value = JSON.parse(normalized.slice(start, end + 1));
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export async function extractHvacNameplate(args: {
  imageBuffer: Buffer;
  mimeType: string;
}): Promise<HvacNameplateExtractionResult> {
  if (!aiEnabled()) {
    throw new Error('Nameplate extraction is unavailable until diagnostic AI is configured');
  }

  if (!/^image\/(?:png|jpe?g|webp)$/i.test(args.mimeType)) {
    throw new Error('Nameplate image must be PNG, JPEG, or WebP');
  }

  const model = DEFAULT_MODEL;
  const dataUrl = `data:${args.mimeType};base64,${args.imageBuffer.toString('base64')}`;
  const response = await callResponsesApi({
    model,
    store: false,
    max_output_tokens: 700,
    input: [
      {
        role: 'developer',
        content: [
          {
            type: 'input_text',
            text: [
              'Extract HVAC equipment nameplate fields from the supplied image.',
              'Return only valid JSON with the exact keys requested.',
              'Use null when a field is unreadable or absent; never guess.',
              'Preserve model and serial punctuation exactly as visible.',
              'The result is a proposal that a technician will confirm.',
            ].join(' '),
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Return JSON keys: manufacturer, model, serial, equipmentType, refrigerant, voltage, phase, frequencyHz, minimumCircuitAmpacity, maximumOvercurrentProtection, compressorRla, factoryCharge, notes. notes must be an array of short strings describing uncertainty or other useful visible fields.',
          },
          {
            type: 'input_image',
            image_url: dataUrl,
            detail: 'high',
          },
        ],
      },
    ],
  });

  const outputText = outputTextFromResponse(response);
  const parsed = outputText ? parseJsonObject(outputText) : null;
  if (!parsed) {
    throw new Error('Nameplate extraction returned an invalid result');
  }

  return {
    provider: 'openai',
    model,
    extraction: {
      manufacturer: nullableString(parsed.manufacturer),
      model: nullableString(parsed.model),
      serial: nullableString(parsed.serial),
      equipmentType: nullableString(parsed.equipmentType),
      refrigerant: nullableString(parsed.refrigerant),
      voltage: nullableString(parsed.voltage),
      phase: nullableString(parsed.phase),
      frequencyHz: nullableNumber(parsed.frequencyHz),
      minimumCircuitAmpacity: nullableNumber(parsed.minimumCircuitAmpacity),
      maximumOvercurrentProtection: nullableNumber(parsed.maximumOvercurrentProtection),
      compressorRla: nullableNumber(parsed.compressorRla),
      factoryCharge: nullableString(parsed.factoryCharge),
      notes: Array.isArray(parsed.notes)
        ? parsed.notes.filter((item): item is string => typeof item === 'string').slice(0, 12)
        : [],
    },
  };
}
