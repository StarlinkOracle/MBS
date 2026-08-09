import sharp from 'sharp';
import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  buildPhotoDerivatives,
  isHeicMime,
  normalizeImageToJpeg,
} from '../src/media-processing.js';

async function createJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 25, g: 50, b: 200 },
    },
  })
    .jpeg({ quality: 92 })
    .toBuffer();
}

describe('media processing', () => {
  it('detects HEIC/HEIF by mime and extension', () => {
    expect(isHeicMime('photo.heic', 'application/octet-stream')).toBe(true);
    expect(isHeicMime('photo.jpg', 'image/heic')).toBe(true);
    expect(isHeicMime('photo.jpg', 'image/jpeg')).toBe(false);
  });

  it('normalizes HEIC input to JPEG using converter', async () => {
    const convertedJpeg = await createJpeg(1200, 900);
    const converter = vi.fn(async () => convertedJpeg);

    const output = await normalizeImageToJpeg(
      Buffer.from('heic-bytes-placeholder'),
      'capture.heic',
      'image/heic',
      { heicConverter: converter as any },
    );

    expect(converter).toHaveBeenCalledTimes(1);
    const metadata = await sharp(output).metadata();
    expect(metadata.format).toBe('jpeg');
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(900);
  });

  it('builds display and thumb derivatives as jpeg', async () => {
    const original = await createJpeg(3000, 1800);

    const result = await buildPhotoDerivatives(original, 'photo.jpg', 'image/jpeg');

    const originalMeta = await sharp(result.originalJpeg).metadata();
    const displayMeta = await sharp(result.displayJpeg).metadata();
    const thumbMeta = await sharp(result.thumbJpeg).metadata();

    expect(originalMeta.format).toBe('jpeg');
    expect(displayMeta.format).toBe('jpeg');
    expect(thumbMeta.format).toBe('jpeg');
    expect(displayMeta.width ?? 0).toBeLessThanOrEqual(2048);
    expect(displayMeta.height ?? 0).toBeLessThanOrEqual(2048);
    expect(thumbMeta.width ?? 0).toBeLessThanOrEqual(512);
    expect(thumbMeta.height ?? 0).toBeLessThanOrEqual(512);
    expect(result.width).toBe(3000);
    expect(result.height).toBe(1800);
  });
});
