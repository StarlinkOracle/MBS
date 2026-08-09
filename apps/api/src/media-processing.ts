import type { Sharp } from 'sharp';
import heicConvert from 'heic-convert';
import sharp from 'sharp';

type HeicConverter = typeof heicConvert;
type SharpFactory = (input: Buffer) => Sharp;

export function isHeicMime(originalName: string, mimeType: string): boolean {
  const lowerType = String(mimeType ?? '').toLowerCase();
  const lowerName = String(originalName ?? '').toLowerCase();
  return (
    lowerType.includes('heic') ||
    lowerType.includes('heif') ||
    lowerName.endsWith('.heic') ||
    lowerName.endsWith('.heif')
  );
}

export async function normalizeImageToJpeg(
  buffer: Buffer,
  originalName: string,
  mimeType: string,
  options: {
    heicConverter?: HeicConverter;
    sharpFactory?: SharpFactory;
  } = {},
): Promise<Buffer> {
  let source = buffer;
  const convertHeic = options.heicConverter ?? heicConvert;
  const sharpFactory = options.sharpFactory ?? ((input: Buffer) => sharp(input));

  if (isHeicMime(originalName, mimeType)) {
    const converted = await convertHeic({
      buffer,
      format: 'JPEG',
      quality: 0.92,
    });
    source = Buffer.from(converted);
  }

  return sharpFactory(source)
    .rotate()
    .jpeg({ quality: 90 })
    .toBuffer();
}

export async function buildPhotoDerivatives(
  buffer: Buffer,
  originalName: string,
  mimeType: string,
  options: {
    heicConverter?: HeicConverter;
    sharpFactory?: SharpFactory;
  } = {},
): Promise<{
  originalJpeg: Buffer;
  displayJpeg: Buffer;
  thumbJpeg: Buffer;
  width: number | null;
  height: number | null;
}> {
  const sharpFactory = options.sharpFactory ?? ((input: Buffer) => sharp(input));
  const normalized = await normalizeImageToJpeg(
    buffer,
    originalName,
    mimeType,
    options,
  );
  const originalMeta = await sharpFactory(normalized).metadata();

  const displayJpeg = await sharpFactory(normalized)
    .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 86 })
    .toBuffer();

  const thumbJpeg = await sharpFactory(normalized)
    .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();

  return {
    originalJpeg: normalized,
    displayJpeg,
    thumbJpeg,
    width: typeof originalMeta.width === 'number' ? originalMeta.width : null,
    height: typeof originalMeta.height === 'number' ? originalMeta.height : null,
  };
}
