import { getSignedUrl } from '@rcs/storage';

export type ReceiptOcrProvider = 'OPENAI_VISION' | 'GOOGLE_VISION' | 'TESSERACT';

export type ReceiptOcrExtraction = {
  provider: ReceiptOcrProvider;
  extractedMerchant: string | null;
  extractedDate: string | null;
  extractedTotalCents: number | null;
  extractedTaxCents: number | null;
  extractedLineItems: unknown;
  confidence: Record<string, number>;
  rawText: string | null;
  rawPayload: unknown;
};

type ReceiptImageLocation = {
  bucket: string;
  objectKey: string;
  mimeType?: string | null;
};

type OpenAiReceiptResponse = {
  merchant?: unknown;
  purchaseDate?: unknown;
  totalCents?: unknown;
  taxCents?: unknown;
  lineItems?: unknown;
  confidence?: unknown;
  rawText?: unknown;
};

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.replace(/[^0-9.-]/g, ''));
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function clampConfidence(value: unknown): number {
  const numeric = toNumberOrNull(value);
  if (numeric === null) {
    return 0;
  }
  if (numeric <= 0) {
    return 0;
  }
  if (numeric >= 1) {
    return 1;
  }
  return numeric;
}

function normalizeDateIso(value: unknown): string | null {
  const asString = toStringOrNull(value);
  if (!asString) {
    return null;
  }
  const parsed = new Date(asString);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeCents(value: unknown): number | null {
  const numeric = toNumberOrNull(value);
  if (numeric === null) {
    return null;
  }
  return Math.round(numeric);
}

function pickConfidence(
  confidenceValue: unknown,
  key: string,
): number {
  if (!confidenceValue || typeof confidenceValue !== 'object' || Array.isArray(confidenceValue)) {
    return 0;
  }
  return clampConfidence((confidenceValue as Record<string, unknown>)[key]);
}

function normalizeConfidence(confidenceValue: unknown): Record<string, number> {
  const merchant = pickConfidence(confidenceValue, 'merchant');
  const date = pickConfidence(confidenceValue, 'date');
  const total = pickConfidence(confidenceValue, 'total');
  const tax = pickConfidence(confidenceValue, 'tax');
  const lineItems = pickConfidence(confidenceValue, 'lineItems');
  const overall = pickConfidence(confidenceValue, 'overall');

  return {
    merchant,
    date,
    total: total || overall,
    tax,
    lineItems,
    overall,
  };
}

async function loadImageAsDataUrl(input: ReceiptImageLocation): Promise<string> {
  const signedUrl = await getSignedUrl({
    bucket: input.bucket,
    objectKey: input.objectKey,
    expiresSeconds: 300,
  });
  const response = await fetch(signedUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch receipt image (${response.status})`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');
  const mimeType = toStringOrNull(input.mimeType) ?? 'image/jpeg';
  return `data:${mimeType};base64,${base64}`;
}

async function extractWithOpenAi(input: ReceiptImageLocation): Promise<ReceiptOcrExtraction> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OCR provider not configured: OPENAI_API_KEY is missing');
  }

  const imageDataUrl = await loadImageAsDataUrl(input);
  const model = process.env.OPENAI_OCR_MODEL ?? 'gpt-4o-mini';

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: {
        type: 'json_object',
      },
      messages: [
        {
          role: 'system',
          content:
            'You extract receipt fields for accounting. Return JSON only with keys: merchant, purchaseDate, totalCents, taxCents, lineItems, confidence, rawText.',
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'Extract merchant, purchase date, total/tax in cents, optional line items, and confidence values (0..1). If unknown return null.',
            },
            {
              type: 'image_url',
              image_url: {
                url: imageDataUrl,
              },
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`OpenAI OCR request failed (${response.status}): ${message}`);
  }

  const completion = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string;
      };
    }>;
  };

  const content = completion.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('OpenAI OCR returned empty content');
  }

  let parsed: OpenAiReceiptResponse;
  try {
    parsed = JSON.parse(content) as OpenAiReceiptResponse;
  } catch (error) {
    throw new Error(
      `OpenAI OCR returned invalid JSON: ${
        error instanceof Error ? error.message : 'unknown parse error'
      }`,
    );
  }

  const confidence = normalizeConfidence(parsed.confidence);

  return {
    provider: 'OPENAI_VISION',
    extractedMerchant: toStringOrNull(parsed.merchant),
    extractedDate: normalizeDateIso(parsed.purchaseDate),
    extractedTotalCents: normalizeCents(parsed.totalCents),
    extractedTaxCents: normalizeCents(parsed.taxCents),
    extractedLineItems:
      parsed.lineItems === undefined ? null : parsed.lineItems,
    confidence,
    rawText: toStringOrNull(parsed.rawText),
    rawPayload: parsed,
  };
}

export async function extractReceiptFields(
  input: ReceiptImageLocation,
): Promise<ReceiptOcrExtraction> {
  const configuredProvider = String(process.env.OCR_PROVIDER ?? 'OPENAI_VISION')
    .trim()
    .toUpperCase();

  if (configuredProvider === 'GOOGLE_VISION') {
    throw new Error('OCR provider not configured: GOOGLE_VISION not implemented yet');
  }
  if (configuredProvider === 'TESSERACT') {
    throw new Error('OCR provider not configured: TESSERACT not implemented yet');
  }

  return extractWithOpenAi(input);
}
