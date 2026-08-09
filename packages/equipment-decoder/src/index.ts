const TONNAGE_BY_TOKEN: Record<string, number> = {
  '24': 2.0,
  '30': 2.5,
  '36': 3.0,
  '42': 3.5,
  '48': 4.0,
  '60': 5.0,
};

const FURNACE_BTU_BY_TOKEN: Record<string, number> = {
  '040': 40_000,
  '050': 50_000,
  '060': 60_000,
  '080': 80_000,
  '100': 100_000,
  '120': 120_000,
};

type ManufacturerFamily = 'GOODMAN_AMANA' | 'GENERIC';

export type DecoderEvidence = {
  normalizedModel: string;
  manufacturer: string | null;
  rules: string[];
  tonnageTokens: string[];
  btuTokens: string[];
  selectedTonnageToken?: string;
  selectedBtuToken?: string;
  ambiguous: boolean;
};

export type CapacityDecodeResult = {
  tonnage?: number;
  btu?: number;
  confidence: number;
  evidence: DecoderEvidence;
};

export type DecodeOptions = {
  manufacturer?: string | null;
};

export function normalizeModel(value: string): string {
  return String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function normalizeManufacturer(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

function detectManufacturerFamily(
  manufacturer: string | null,
): ManufacturerFamily {
  if (!manufacturer) {
    return 'GENERIC';
  }

  if (manufacturer.includes('GOODMAN') || manufacturer.includes('AMANA')) {
    return 'GOODMAN_AMANA';
  }

  return 'GENERIC';
}

function collectDigitRuns(model: string): string[] {
  const runs = model.match(/\d+/g);
  return runs ? runs.filter((run) => run.length > 0) : [];
}

function collectGenericTonnageTokens(model: string): string[] {
  const matches = new Set<string>();
  for (const run of collectDigitRuns(model)) {
    for (let index = 0; index < run.length; index += 1) {
      const two = run.slice(index, index + 2);
      if (two in TONNAGE_BY_TOKEN) {
        matches.add(two);
      }
      const three = run.slice(index, index + 3);
      if (three.startsWith('0') && three.slice(1) in TONNAGE_BY_TOKEN) {
        matches.add(three.slice(1));
      }
    }
  }

  return [...matches.values()];
}

function collectGenericBtuTokens(model: string): string[] {
  const matches = new Set<string>();
  for (const run of collectDigitRuns(model)) {
    for (let index = 0; index < run.length; index += 1) {
      const three = run.slice(index, index + 3);
      if (three in FURNACE_BTU_BY_TOKEN) {
        matches.add(three);
      }
      if (three.length === 2) {
        const padded = `0${three}`;
        if (padded in FURNACE_BTU_BY_TOKEN) {
          matches.add(padded);
        }
      }
    }
  }

  return [...matches.values()];
}

function decodeGoodmanAmanaTonnage(model: string): string | null {
  // Goodman/Amana cooling models commonly carry 2-digit capacity code in the main numeric segment.
  const numericSegment = model.match(/[A-Z]+(\d{4,})/);
  const segment = numericSegment?.[1] ?? model;
  let bestToken: string | null = null;
  let bestIndex = -1;

  for (const token of Object.keys(TONNAGE_BY_TOKEN)) {
    const directIndex = segment.lastIndexOf(token);
    if (directIndex > bestIndex) {
      bestIndex = directIndex;
      bestToken = token;
    }

    const paddedIndex = segment.lastIndexOf(`0${token}`);
    if (paddedIndex > bestIndex) {
      bestIndex = paddedIndex;
      bestToken = token;
    }
  }

  return bestToken;
}

function decodeGoodmanAmanaBtu(model: string): string | null {
  // Goodman/Amana furnace models often include 040/050/060/080/100/120 heat input markers.
  const tokenMatch = model.match(/(040|050|060|080|100|120)/);
  return tokenMatch?.[1] ?? null;
}

function pickToken(tokens: string[]): string | undefined {
  if (tokens.length === 0) {
    return undefined;
  }
  if (tokens.length === 1) {
    return tokens[0];
  }

  const sorted = [...tokens].sort((a, b) => Number(a) - Number(b));
  return sorted[0];
}

function computeConfidence(args: {
  hasBrandPattern: boolean;
  tonnageTokenCount: number;
  btuTokenCount: number;
  selectedTonnage?: string;
  selectedBtu?: string;
}): number {
  let score = 0;

  if (args.selectedTonnage || args.selectedBtu) {
    score += 0.35;
  }
  if (args.selectedTonnage) {
    score += 0.2;
  }
  if (args.selectedBtu) {
    score += 0.2;
  }
  if (args.hasBrandPattern) {
    score += 0.2;
  }

  const ambiguous = args.tonnageTokenCount > 1 || args.btuTokenCount > 1;
  if (ambiguous) {
    score -= args.hasBrandPattern ? 0.05 : 0.2;
  }

  return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}

export function decodeCapacityFromModel(
  model: string,
  options: DecodeOptions = {},
): CapacityDecodeResult {
  const normalizedModel = normalizeModel(model);
  const manufacturer = normalizeManufacturer(options.manufacturer);
  const manufacturerFamily = detectManufacturerFamily(manufacturer);

  const evidence: DecoderEvidence = {
    normalizedModel,
    manufacturer,
    rules: ['generic-digit-run-decode'],
    tonnageTokens: [],
    btuTokens: [],
    ambiguous: false,
  };

  if (!normalizedModel) {
    evidence.rules.push('empty-model');
    return {
      confidence: 0,
      evidence,
    };
  }

  const genericTonnageTokens = collectGenericTonnageTokens(normalizedModel);
  const genericBtuTokens = collectGenericBtuTokens(normalizedModel);

  let selectedTonnageToken = pickToken(genericTonnageTokens);
  let selectedBtuToken = pickToken(genericBtuTokens);
  let hasBrandPattern = false;

  if (manufacturerFamily === 'GOODMAN_AMANA') {
    evidence.rules.push('goodman-amana-priority-patterns');

    const brandTonnage = decodeGoodmanAmanaTonnage(normalizedModel);
    if (brandTonnage) {
      selectedTonnageToken = brandTonnage;
      hasBrandPattern = true;
    }

    const brandBtu = decodeGoodmanAmanaBtu(normalizedModel);
    if (brandBtu) {
      selectedBtuToken = brandBtu;
      hasBrandPattern = true;
    }
  }

  evidence.tonnageTokens = [...new Set(genericTonnageTokens)];
  evidence.btuTokens = [...new Set(genericBtuTokens)];
  evidence.selectedTonnageToken = selectedTonnageToken;
  evidence.selectedBtuToken = selectedBtuToken;
  evidence.ambiguous = evidence.tonnageTokens.length > 1 || evidence.btuTokens.length > 1;

  const tonnage =
    selectedTonnageToken && selectedTonnageToken in TONNAGE_BY_TOKEN
      ? TONNAGE_BY_TOKEN[selectedTonnageToken]
      : undefined;
  const btu =
    selectedBtuToken && selectedBtuToken in FURNACE_BTU_BY_TOKEN
      ? FURNACE_BTU_BY_TOKEN[selectedBtuToken]
      : undefined;

  const confidence = computeConfidence({
    hasBrandPattern,
    tonnageTokenCount: evidence.tonnageTokens.length,
    btuTokenCount: evidence.btuTokens.length,
    selectedTonnage: selectedTonnageToken,
    selectedBtu: selectedBtuToken,
  });

  return {
    ...(tonnage === undefined ? {} : { tonnage }),
    ...(btu === undefined ? {} : { btu }),
    confidence,
    evidence,
  };
}
