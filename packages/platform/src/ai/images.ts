import { createHash } from 'node:crypto';
import { AppError } from '../errors';
import type { AiImage } from './types';

/**
 * Image inputs (S12-01 review; vision for Listing Studio S12-02 and the sanitizer S12-03). Checked before anything is
 * sent: at most `MAX_IMAGES`, https URLs only (the provider fetches them — our media CDN), base64 only for JPEG, PNG,
 * GIF and WebP whose magic bytes match the declared type, ≤ 5 MB decoded (the provider's per-image limit).
 */
export const MAX_IMAGES = 20;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_URL_LENGTH = 2_048;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function magicMatches(mediaType: string, bytes: Buffer): boolean {
  switch (mediaType) {
    case 'image/jpeg':
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/png':
      return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/gif':
      return bytes.subarray(0, 4).toString('latin1') === 'GIF8';
    case 'image/webp':
      return bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP';
    default:
      return false;
  }
}

const invalid = (reason: string, index: number) =>
  new AppError('VALIDATION_FAILED', { reason: `AI_IMAGE_${reason}`, index });

/** Validates the images; returns each one's fingerprint for the input hash (the URL, or the bytes' SHA-256). */
export function checkImages(images: readonly AiImage[] | undefined): string[] {
  if (!images || images.length === 0) return [];
  if (images.length > MAX_IMAGES)
    throw new AppError('VALIDATION_FAILED', { reason: 'AI_IMAGE_COUNT', max: MAX_IMAGES });
  return images.map((image, i) => {
    if (image.type === 'url') {
      let url: URL;
      try {
        url = new URL(image.url);
      } catch {
        throw invalid('URL', i);
      }
      if (url.protocol !== 'https:' || image.url.length > MAX_URL_LENGTH || url.username || url.password) {
        throw invalid('URL', i);
      }
      return `url:${image.url}`;
    }
    if (image.type !== 'base64' || !BASE64_RE.test(image.data)) throw invalid('DATA', i);
    // Decoded size without decoding twice: 3 bytes per 4 chars, minus padding.
    const size = (image.data.length / 4) * 3 - (image.data.endsWith('==') ? 2 : image.data.endsWith('=') ? 1 : 0);
    if (size > MAX_IMAGE_BYTES) throw invalid('TOO_LARGE', i);
    const bytes = Buffer.from(image.data, 'base64');
    if (!magicMatches(image.mediaType, bytes)) throw invalid('TYPE', i);
    return `b64:${image.mediaType}:${createHash('sha256').update(bytes).digest('hex')}`;
  });
}

/** Rough input tokens of the images for the budget estimate (≈ a 1.15 MP image each — the provider's maximum size). */
export const IMAGE_TOKENS_ESTIMATE = 1_600;
