/**
 * Upload allowlist by magic bytes (security rules: never trust the client's content type or file
 * extension). Only types a caller lists are accepted.
 */
export interface DetectedFile {
  contentType: 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/webp' | 'image/heic';
  extension: 'pdf' | 'png' | 'jpg' | 'webp' | 'heic';
}

/** ISO-BMFF major brands of HEIF/HEIC stills and sequences (iPhone photos); AVIF is not one of them. */
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

/** Bytes a caller must read to identify any type `detectFileType` knows. */
export const SNIFF_BYTES = 16;

const startsWith = (bytes: Uint8Array, sig: readonly number[], offset = 0) =>
  bytes.length >= offset + sig.length && sig.every((b, i) => bytes[offset + i] === b);

/** The file's real type from its first bytes, or null when it is none of the known types. */
export function detectFileType(bytes: Uint8Array): DetectedFile | null {
  // "%PDF-"
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { contentType: 'application/pdf', extension: 'pdf' };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { contentType: 'image/png', extension: 'png' };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { contentType: 'image/jpeg', extension: 'jpg' };
  // "RIFF" .... "WEBP"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { contentType: 'image/webp', extension: 'webp' };
  }
  // "....ftyp<brand>": an ISO-BMFF file whose major brand is HEIF
  if (startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4) && bytes.length >= 12) {
    const brand = String.fromCharCode(...bytes.slice(8, 12));
    if (HEIF_BRANDS.has(brand)) return { contentType: 'image/heic', extension: 'heic' };
  }
  return null;
}
