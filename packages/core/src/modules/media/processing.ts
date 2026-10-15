/**
 * Image processing for the media worker (S3-04): pure bytes in, bytes out — no DB, no storage. Runs only in
 * the `media` pool; sharp (libvips) and the HEIC decoder are loaded on first use, so apps that import the
 * media module for its use cases never load them.
 *
 * - `normalizeOriginal`: an uploaded original → the master: EXIF orientation applied, longest side ≤
 *   `MASTER_MAX_PX`, converted to sRGB, every metadata block (EXIF, GPS, XMP, ICC) dropped, WebP.
 * - `renderVariants`: the master → the requested variants and the master's pHash. Variants are made from the
 *   master's decoded pixels only, with fixed encoder settings, so the same master and pipeline version always
 *   give byte-identical files (the first run and any on-demand regeneration agree).
 *
 * Memory: the job holds one of `IMAGE_SLOTS` (`withImageSlot`) from downloading the original until the files
 * are rendered, whatever the pool's job concurrency; a HEIC decode (whole RGBA image in WASM, twice) holds them
 * all. Inputs are capped in pixels and libvips' operation cache is off — the worker stays under its 512 MB
 * RSS budget (`tests/perf/media-processing.int.test.ts`).
 */
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { Sharp, SharpOptions } from 'sharp';
import { MASTER_MAX_PX, VARIANTS, type VariantName } from './variants';

/** Images processed at once per worker process. */
export const IMAGE_SLOTS = 2;
/**
 * Largest input decoded: 50 MP (a 48 MP phone photo passes). An EXIF rotation decodes the whole image (~150 MB
 * of RGB at 50 MP), so this times `IMAGE_SLOTS` must stay well inside the RSS budget.
 */
export const MAX_INPUT_PIXELS = 50_000_000;
/** HEIC goes through a WASM decoder that holds the whole RGBA image twice (25 MP ≈ 200 MB): a lower cap. */
export const MAX_HEIC_PIXELS = 25_000_000;

const MASTER_WEBP = { quality: 90, effort: 2 } as const;
const VARIANT_WEBP = { quality: 80, effort: 2 } as const;
const OG_JPEG = { quality: 82, mozjpeg: false, chromaSubsampling: '4:2:0' } as const;
const WHITE = { r: 255, g: 255, b: 255 };

/** A decode failure of the input itself (corrupt, unsupported, too large): retrying cannot help. */
export class ImageInputError extends Error {
  override readonly name = 'ImageInputError';
}

type SharpFactory = typeof import('sharp')['default'];
let sharpLib: Promise<SharpFactory> | undefined;

function loadSharp(): Promise<SharpFactory> {
  sharpLib ??= import('sharp').then((m) => {
    m.default.cache(false);
    // Threads per image: the slots share the cores instead of each taking all of them.
    m.default.concurrency(Math.max(1, Math.floor(availableParallelism() / IMAGE_SLOTS)));
    return m.default;
  });
  return sharpLib;
}

let free = IMAGE_SLOTS;
const waiting: { weight: number; go: () => void }[] = [];

function wake(): void {
  // FIFO: the first waiter goes when it fits (a HEIC waiting for both slots is not overtaken).
  while (waiting[0] && waiting[0].weight <= free) {
    const next = waiting.shift() as (typeof waiting)[number];
    free -= next.weight;
    next.go();
  }
}

/**
 * Runs `fn` holding image slots: one, or all of them for a HEIC (`heavy`). Wrap everything that holds image
 * bytes — download, decode, render — so the pool's job concurrency never multiplies the memory.
 */
export async function withImageSlot<T>(heavy: boolean, fn: () => Promise<T>): Promise<T> {
  const weight = heavy ? IMAGE_SLOTS : 1;
  if (waiting.length === 0 && free >= weight) free -= weight;
  else await new Promise<void>((go) => waiting.push({ weight, go }));
  try {
    return await fn();
  } finally {
    free += weight;
    wake();
  }
}

const INPUT: SharpOptions = { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS };

const bytesOf = (b: Buffer) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

async function toMaster(img: Sharp): Promise<{ master: Uint8Array; width: number; height: number }> {
  const { data, info } = await img
    .resize({ width: MASTER_MAX_PX, height: MASTER_MAX_PX, fit: 'inside', withoutEnlargement: true })
    .webp(MASTER_WEBP)
    .toBuffer({ resolveWithObject: true });
  return { master: bytesOf(data), width: info.width, height: info.height };
}

/** The HEIC decoder thread (CommonJS, `eval`): decodes the first image unless it is past the pixel cap. */
const HEIC_THREAD = `
const { parentPort, workerData } = require('node:worker_threads');
const decode = require(workerData.decoder);
(async () => {
  const images = await decode.all({ buffer: workerData.bytes });
  try {
    const first = images[0];
    if (!first) return parentPort.postMessage({ error: 'HEIC has no image' });
    if (first.width * first.height > workerData.maxPixels) return parentPort.postMessage({ error: 'HEIC too large' });
    const { data, width, height } = await first.decode();
    parentPort.postMessage({ width, height, data }, [data.buffer]);
  } finally {
    images.dispose();
  }
})().catch((err) => parentPort.postMessage({ error: 'HEIC not readable (' + err.message + ')' }));
`;
const HEIC_TIMEOUT_MS = 60_000;

/**
 * HEIC (HEVC) through libheif compiled to WASM: sharp's prebuilt libvips reads HEIF only with AV1 (patents).
 * libheif applies the container's rotation and mirroring itself. Each decode runs in a short-lived worker
 * thread: WASM memory never shrinks once grown, so the thread is ended after every file and its memory goes
 * with it; a decoder failure or blow-up stays in the thread.
 */
async function decodeHeic(sharp: SharpFactory, bytes: Uint8Array): Promise<Sharp> {
  const thread = new Worker(HEIC_THREAD, {
    eval: true,
    workerData: { decoder: createRequire(import.meta.url).resolve('heic-decode'), bytes, maxPixels: MAX_HEIC_PIXELS },
    resourceLimits: { maxOldGenerationSizeMb: 128 },
  });
  try {
    const out = await new Promise<{ width: number; height: number; data: Uint8ClampedArray }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new ImageInputError('HEIC decode timed out')), HEIC_TIMEOUT_MS);
      thread.once('message', (m: { error?: string; width: number; height: number; data: Uint8ClampedArray }) => {
        clearTimeout(timer);
        if (m.error) reject(new ImageInputError(m.error));
        else resolve(m);
      });
      thread.once('error', (err) => {
        clearTimeout(timer);
        reject(new ImageInputError(`HEIC not readable (${err.message})`));
      });
      thread.once('exit', (code) => {
        clearTimeout(timer);
        reject(new ImageInputError(`HEIC decoder exited (${code})`));
      });
    });
    const { data, width, height } = out;
    return sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { raw: { width, height, channels: 4 } });
  } finally {
    await thread.terminate();
  }
}

/** An uploaded original (detected type) → its normalized master. Throws `ImageInputError` for a bad input. */
export async function normalizeOriginal(
  bytes: Uint8Array,
  contentType: string,
): Promise<{ master: Uint8Array; width: number; height: number }> {
  const sharp = await loadSharp();
  try {
    // `rotate()` applies the EXIF orientation; output carries no metadata unless asked (`withMetadata`).
    return await toMaster(sharp(bytes, INPUT).rotate());
  } catch (err) {
    if (contentType !== 'image/heic') throw new ImageInputError(`image not readable (${(err as Error).message})`);
  }
  try {
    return await toMaster(await decodeHeic(sharp, bytes));
  } catch (err) {
    if (err instanceof ImageInputError) throw err;
    throw new ImageInputError(`HEIC not readable (${(err as Error).message})`);
  }
}

export interface RenderedVariants {
  files: Map<VariantName, Uint8Array>;
  /** 64-bit DCT perceptual hash of the master (signed, as Postgres `bigint` stores it). */
  phash: bigint;
  width: number;
  height: number;
}

/** The master → the `names` variants (in the order given) and its pHash. */
export async function renderVariants(master: Uint8Array, names: readonly VariantName[]): Promise<RenderedVariants> {
  const sharp = await loadSharp();
  let decoded: { data: Buffer; info: { width: number; height: number; channels: number } };
  try {
    decoded = await sharp(master, INPUT).raw().toBuffer({ resolveWithObject: true });
  } catch (err) {
    throw new ImageInputError(`master not readable (${(err as Error).message})`);
  }
  const { width, height, channels } = decoded.info;
  const raw = { raw: { width, height, channels: channels as 1 | 2 | 3 | 4 } };
  const pixels = () => sharp(decoded.data, raw);

  // Encoders are single-threaded: the sizes run side by side (each output depends only on the pixels).
  const encoded = names.map(async (name) => {
    const v = VARIANTS[name];
    const out =
      v.format === 'jpeg'
        ? pixels()
            .resize({ width: v.width, height: v.height, fit: 'cover', position: 'centre' })
            .flatten({ background: WHITE })
            .jpeg(OG_JPEG)
        : pixels()
            .resize({ width: v.maxPx, height: v.maxPx, fit: 'inside', withoutEnlargement: true })
            .webp(VARIANT_WEBP);
    return [name, bytesOf(await out.toBuffer())] as const;
  });
  const grey = pixels()
    .flatten({ background: WHITE })
    .greyscale()
    .resize(32, 32, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const [files, g] = await Promise.all([Promise.all(encoded), grey]);
  return { files: new Map(files), phash: phashOf(g.data, g.info.channels), width, height };
}

const N = 32;
const K = 8;
/** cos((2x + 1)uπ / 2N) for the K lowest frequencies. */
const COS = Array.from({ length: K }, (_, u) =>
  Float64Array.from({ length: N }, (_, x) => Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N))),
);

/**
 * DCT pHash of a 32 × 32 greyscale image (first channel of each pixel): the 8 × 8 lowest frequencies of its
 * 2-D DCT, one bit each — above the median of the 63 non-DC coefficients. Visually similar images differ in
 * few bits (`hammingDistance`); a re-encode or resize of the same photo in very few.
 */
export function phashOf(grey: Uint8Array, channels = 1): bigint {
  const px = (x: number, y: number) => grey[(y * N + x) * channels] ?? 0;
  // Separable DCT: columns first (rows[v][x] = Σy cos·p), then rows.
  const rows = COS.map((cv) => {
    const out = new Float64Array(N);
    for (let x = 0; x < N; x++) {
      let s = 0;
      for (let y = 0; y < N; y++) s += (cv[y] ?? 0) * px(x, y);
      out[x] = s;
    }
    return out;
  });
  const coeffs: number[] = [];
  for (let v = 0; v < K; v++) {
    for (let u = 0; u < K; u++) {
      let s = 0;
      const cu = COS[u] as Float64Array;
      const rv = rows[v] as Float64Array;
      for (let x = 0; x < N; x++) s += (cu[x] ?? 0) * (rv[x] ?? 0);
      coeffs.push(s);
    }
  }
  const sorted = coeffs.slice(1).sort((p, q) => p - q);
  const median = sorted[31] ?? 0;
  let hash = 0n;
  for (const c of coeffs) hash = (hash << 1n) | (c > median ? 1n : 0n);
  return BigInt.asIntN(64, hash);
}

/** Bits that differ between two pHashes (0 = same picture; ≲ 10 = very likely the same photo). */
export function hammingDistance(a: bigint, b: bigint): number {
  let x = BigInt.asUintN(64, a ^ b);
  let n = 0;
  while (x) {
    x &= x - 1n;
    n++;
  }
  return n;
}
