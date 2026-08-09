export type GeocodeInput = {
  addressLine1?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
};

export type GeocodeResult = {
  provider: 'MAPBOX' | 'GOOGLE' | 'NONE';
  addressNormalized: string;
  city: string | null;
  state: string | null;
  zip: string | null;
  lat: number | null;
  lng: number | null;
  geohash: string | null;
  geocodedAt: Date | null;
};

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function normalizeAddress(input: GeocodeInput): string {
  const segments = [
    toStringOrNull(input.addressLine1),
    toStringOrNull(input.city),
    toStringOrNull(input.state),
    toStringOrNull(input.postalCode),
    toStringOrNull(input.country) ?? 'US',
  ].filter((segment): segment is string => Boolean(segment));

  return segments.join(', ');
}

function encodeGeohash(lat: number, lng: number, precision = 8): string {
  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;
  let bits = 0;
  let bitCount = 0;
  let evenBit = true;
  let geohash = '';

  while (geohash.length < precision) {
    if (evenBit) {
      const midpoint = (lngMin + lngMax) / 2;
      if (lng >= midpoint) {
        bits = (bits << 1) + 1;
        lngMin = midpoint;
      } else {
        bits = bits << 1;
        lngMax = midpoint;
      }
    } else {
      const midpoint = (latMin + latMax) / 2;
      if (lat >= midpoint) {
        bits = (bits << 1) + 1;
        latMin = midpoint;
      } else {
        bits = bits << 1;
        latMax = midpoint;
      }
    }

    evenBit = !evenBit;
    bitCount += 1;
    if (bitCount === 5) {
      geohash += BASE32[bits];
      bits = 0;
      bitCount = 0;
    }
  }

  return geohash;
}

function fallbackResult(input: GeocodeInput): GeocodeResult {
  return {
    provider: 'NONE',
    addressNormalized: normalizeAddress(input) || 'Address unavailable',
    city: toStringOrNull(input.city),
    state: toStringOrNull(input.state),
    zip: toStringOrNull(input.postalCode),
    lat: null,
    lng: null,
    geohash: null,
    geocodedAt: null,
  };
}

function parseMapboxContext(
  context: unknown,
  prefix: string,
): string | null {
  if (!Array.isArray(context)) {
    return null;
  }
  const entry = context.find((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return false;
    }
    const id = (item as Record<string, unknown>).id;
    return typeof id === 'string' && id.startsWith(prefix);
  }) as Record<string, unknown> | undefined;
  return toStringOrNull(entry?.text);
}

async function geocodeWithMapbox(
  input: GeocodeInput,
  token: string,
): Promise<GeocodeResult> {
  const query = normalizeAddress(input);
  if (!query) {
    return fallbackResult(input);
  }

  const endpoint = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(
    query,
  )}.json?access_token=${encodeURIComponent(token)}&limit=1`;
  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(`Mapbox geocode failed (${response.status})`);
  }

  const body = (await response.json()) as {
    features?: Array<Record<string, unknown>>;
  };
  const feature = Array.isArray(body.features) ? body.features[0] : undefined;
  if (!feature) {
    return fallbackResult(input);
  }

  const center = Array.isArray(feature.center)
    ? (feature.center as unknown[])
    : [];
  const lng = toNumberOrNull(center[0]);
  const lat = toNumberOrNull(center[1]);

  const context = feature.context;
  const city = parseMapboxContext(context, 'place.') ?? toStringOrNull(input.city);
  const state = parseMapboxContext(context, 'region.') ?? toStringOrNull(input.state);
  const zip = parseMapboxContext(context, 'postcode.') ?? toStringOrNull(input.postalCode);
  const normalized =
    (toStringOrNull(feature.place_name) ?? normalizeAddress(input)) ||
    'Address unavailable';

  return {
    provider: 'MAPBOX',
    addressNormalized: normalized,
    city,
    state,
    zip,
    lat,
    lng,
    geohash: lat !== null && lng !== null ? encodeGeohash(lat, lng, 8) : null,
    geocodedAt: lat !== null && lng !== null ? new Date() : null,
  };
}

async function geocodeWithGoogle(
  input: GeocodeInput,
  key: string,
): Promise<GeocodeResult> {
  const query = normalizeAddress(input);
  if (!query) {
    return fallbackResult(input);
  }

  const endpoint = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
    query,
  )}&key=${encodeURIComponent(key)}`;
  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(`Google geocode failed (${response.status})`);
  }

  const body = (await response.json()) as {
    results?: Array<Record<string, unknown>>;
  };
  const result = Array.isArray(body.results) ? body.results[0] : undefined;
  if (!result) {
    return fallbackResult(input);
  }

  const geometry =
    result.geometry && typeof result.geometry === 'object'
      ? (result.geometry as Record<string, unknown>)
      : {};
  const location =
    geometry.location && typeof geometry.location === 'object'
      ? (geometry.location as Record<string, unknown>)
      : {};
  const lat = toNumberOrNull(location.lat);
  const lng = toNumberOrNull(location.lng);

  const components = Array.isArray(result.address_components)
    ? (result.address_components as Array<Record<string, unknown>>)
    : [];

  const readComponent = (wanted: string): string | null => {
    const found = components.find((entry) => {
      const types = Array.isArray(entry.types) ? entry.types : [];
      return types.includes(wanted);
    });
    return toStringOrNull(found?.long_name);
  };

  const city =
    readComponent('locality') ??
    readComponent('postal_town') ??
    toStringOrNull(input.city);
  const state =
    readComponent('administrative_area_level_1') ??
    toStringOrNull(input.state);
  const zip = readComponent('postal_code') ?? toStringOrNull(input.postalCode);

  return {
    provider: 'GOOGLE',
    addressNormalized:
      (toStringOrNull(result.formatted_address) ??
        normalizeAddress(input)) ||
      'Address unavailable',
    city,
    state,
    zip,
    lat,
    lng,
    geohash: lat !== null && lng !== null ? encodeGeohash(lat, lng, 8) : null,
    geocodedAt: lat !== null && lng !== null ? new Date() : null,
  };
}

export async function geocodeAddress(input: GeocodeInput): Promise<GeocodeResult> {
  const mapboxToken = toStringOrNull(process.env.MAPBOX_TOKEN);
  if (mapboxToken) {
    try {
      return await geocodeWithMapbox(input, mapboxToken);
    } catch {
      return fallbackResult(input);
    }
  }

  const googleKey = toStringOrNull(process.env.GOOGLE_MAPS_KEY);
  if (googleKey) {
    try {
      return await geocodeWithGoogle(input, googleKey);
    } catch {
      return fallbackResult(input);
    }
  }

  return fallbackResult(input);
}
