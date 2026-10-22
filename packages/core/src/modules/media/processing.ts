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
 * are rendered, whatever the pool's job concurrency; a HEIC decode (its WASM heap: ~160 MB at 24 MP) and an
 * original past `HEAVY_INPUT_PIXELS` (`isHeavyInput`, read from its header) hold them all. Inputs are capped in
 * pixels and libvips' operation cache is off — the worker stays under its 512 MB RSS budget
 * (`tests/perf/media-processing.int.test.ts`).
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
/** HEIC goes through a WASM decoder whose heap holds the image about three times over (24 MP ≈ 160 MB): a lower cap. */
export const MAX_HEIC_PIXELS = 25_000_000;
/**
 * Originals past this decode alone, holding every image slot like a HEIC (S6-F5): a 48 MP photo is ~150 MB of
 * RGB when its EXIF rotation decodes it whole, and two of those at once (or one beside a 12 MP render) took the
 * media worker past its 512 MB budget in CI. A 12 MP phone photo stays at one slot.
 */
export const HEAVY_INPUT_PIXELS = 24_000_000;

const MASTER_WEBP = { quality: 90, effort: 2 } as const;
const VARIANT_WEBP = { quality: 80, effort: 2 } as const;
const OG_JPEG = { quality: 82, mozjpeg: false, chromaSubsampling: '4:2:0' } as const;
const WHITE = { r: 255, g: 255, b: 255 };

/** A decode failure of the input itself (corrupt, unsupported, too large): retrying cannot help. */
export class ImageInputError extends Error {
  override readonly name = 'ImageInputError';
}

type SharpFactory = typeof import('sharp')['default'];
/** libvips threads per image: the slots share the cores instead of each taking all of them. */
const sharpThreads = () => Math.max(1, Math.floor(availableParallelism() / IMAGE_SLOTS));
let sharpLib: Promise<SharpFactory> | undefined;

function loadSharp(): Promise<SharpFactory> {
  sharpLib ??= import('sharp').then((m) => {
    m.default.cache(false);
    m.default.concurrency(sharpThreads());
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
 * bytes — download, decode, render — so the pool's job concurrency never multiplies the memory. `fn` may call
 * `takeAll` once it knows its input is heavy (`isHeavyInput`): it gives its slot back and waits in line for all
 * of them (never holds one while waiting for more, so two upgrading jobs cannot deadlock).
 */
export async function withImageSlot<T>(heavy: boolean, fn: (takeAll: () => Promise<void>) => Promise<T>): Promise<T> {
  let weight = heavy ? IMAGE_SLOTS : 1;
  await acquireSlots(weight);
  const takeAll = async () => {
    if (weight === IMAGE_SLOTS) return;
    free += weight;
    weight = 0;
    wake();
    await acquireSlots(IMAGE_SLOTS);
    weight = IMAGE_SLOTS;
  };
  try {
    return await fn(takeAll);
  } finally {
    free += weight;
    wake();
  }
}

async function acquireSlots(weight: number): Promise<void> {
  if (waiting.length === 0 && free >= weight) free -= weight;
  else await new Promise<void>((go) => waiting.push({ weight, go }));
}

/** Image slots free now (tests). */
export const freeImageSlots = (): number => free;

/**
 * Whether an original must decode alone: a HEIC, or more than `HEAVY_INPUT_PIXELS` by its header (sharp reads
 * the dimensions only, no pixels). An unreadable header is not heavy: `normalizeOriginal` refuses the file.
 */
export async function isHeavyInput(bytes: Uint8Array, contentType: string): Promise<boolean> {
  if (contentType === 'image/heic') return true;
  const sharp = await loadSharp();
  try {
    const { width = 0, height = 0 } = await sharp(bytes, { failOn: 'none' }).metadata();
    return width * height > HEAVY_INPUT_PIXELS;
  } catch {
    return false;
  }
}

const INPUT: SharpOptions = { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS };

const bytesOf = (b: Buffer) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

/** The master's size and encoding: originals here, HEIC in its decoder thread (`heicMaster`). */
const MASTER_RESIZE = { width: MASTER_MAX_PX, height: MASTER_MAX_PX, fit: 'inside', withoutEnlargement: true } as const;

async function toMaster(img: Sharp): Promise<{ master: Uint8Array; width: number; height: number }> {
  const { data, info } = await img.resize(MASTER_RESIZE).webp(MASTER_WEBP).toBuffer({ resolveWithObject: true });
  return { master: bytesOf(data), width: info.width, height: info.height };
}

/**
 * The HEIC thread (CommonJS, `eval`): decodes the first image unless it is past the pixel cap and makes the master
 * from the decoded pixels where they lie, in the decoder's WASM memory (S8-F7). Only the master leaves the thread:
 * handing the pixels out took a copy of the whole image (a 24 MP RGBA decode is 96 MB beside 191 MB of WASM heap,
 * which alone took the media worker to ~455 MB RSS). RGB unless the image has alpha: 25 % less WASM heap.
 *
 * Untrusted sizes: the context's image size limit (libheif security limits, set through the raw C export — the
 * binding's own setter cannot take its context object) refuses a declared (`ispe`) or decoded image past the cap,
 * and the decoded plane must match the declared size exactly. A coded stream that lies bigger than its `ispe` is
 * only seen after libde265 has allocated it: `heicMaster`'s RSS watchdog ends the thread while it decodes.
 */
const HEIC_THREAD = `
const { parentPort, workerData } = require('node:worker_threads');
const libheif = require(workerData.libheif);
const sharp = require(workerData.sharp);
// libvips' settings are per process and loading sharp resets them: the main thread's again.
sharp.cache(false);
sharp.concurrency(workerData.threads);
const fail = (error) => parentPort.postMessage({ error });
const failed = (r) => !r || (r.code !== undefined && r.code !== libheif.heif_error_code.heif_error_Ok);
(async () => {
  await libheif.ready;
  const ctx = libheif.heif_context_alloc();
  if (!ctx || typeof ctx.$$?.ptr !== 'number') return fail('HEIC decoder unavailable');
  let handle;
  try {
    libheif._heif_context_set_maximum_image_size_limit(ctx.$$.ptr, Math.floor(Math.sqrt(workerData.maxPixels)));
    if (failed(libheif.heif_context_read_from_memory(ctx, workerData.bytes))) return fail('HEIC not readable (container)');
    const ids = libheif.heif_js_context_get_list_of_top_level_image_IDs(ctx);
    if (failed(ids) || !ids.length) return fail('HEIC has no image');
    handle = libheif.heif_js_context_get_image_handle(ctx, ids[0]);
    if (failed(handle)) return fail('HEIC not readable (image)');
    const width = libheif.heif_image_handle_get_width(handle);
    const height = libheif.heif_image_handle_get_height(handle);
    if (!(width > 0 && height > 0) || width * height > workerData.maxPixels) return fail('HEIC too large');
    const channels = libheif.heif_image_handle_has_alpha_channel(handle) ? 4 : 3;
    const chroma = channels === 4 ? libheif.heif_chroma.heif_chroma_interleaved_RGBA : libheif.heif_chroma.heif_chroma_interleaved_RGB;
    const image = await libheif.heif_js_decode_image2(handle, libheif.heif_colorspace.heif_colorspace_RGB, chroma);
    if (failed(image) || !image.channels) return fail('HEIC not readable (' + (image?.message || 'decode failed') + ')');
    try {
      parentPort.postMessage({ decoded: true });
      const plane = image.channels.find((c) => c.id === libheif.heif_channel.heif_channel_interleaved);
      const row = width * channels;
      if (!plane || plane.width !== width || plane.height !== height || !(plane.stride >= row) ||
          plane.data.byteLength < plane.stride * (height - 1) + row) return fail('HEIC not readable (pixels do not match its size)');
      // A view of the WASM memory, no copy; padded rows are packed in place (each moves down, never over the next).
      const px = Buffer.from(plane.data.buffer, plane.data.byteOffset, plane.data.byteLength);
      if (plane.stride !== row) for (let y = 1; y < height; y++) px.copyWithin(y * row, y * plane.stride, y * plane.stride + row);
      const { data, info } = await sharp(px.subarray(0, row * height), {
        raw: { width, height, channels },
        failOn: 'error',
        limitInputPixels: workerData.maxPixels,
      })
        .timeout({ seconds: workerData.encodeSeconds })
        .resize(workerData.resize)
        .webp(workerData.webp)
        .toBuffer({ resolveWithObject: true });
      parentPort.postMessage({ master: data, width: info.width, height: info.height });
    } finally {
      libheif.heif_image_release(image.image);
    }
  } finally {
    if (handle && !failed(handle)) libheif.heif_image_handle_release(handle);
    libheif.heif_context_free(ctx);
  }
})().catch((err) => fail('HEIC not readable (' + err.message + ')'));
`;
const HEIC_TIMEOUT_MS = 60_000;
/** The master's encode in the thread stops itself (sharp's timeout) well before the thread is ended under it. */
const HEIC_ENCODE_SECONDS = 20;
/**
 * Process RSS growth allowed while a HEIC decodes before its thread is ended (S8-F7): a 25 MP decode grows it by
 * ~250 MB (WASM heap, thread, libraries); a stream that lies past its declared size keeps growing.
 */
export const HEIC_MAX_RSS_GROWTH = 320 * 1024 * 1024;
const WATCHDOG_MS = 10;

/**
 * HEIC (HEVC) through libheif compiled to WASM: sharp's prebuilt libvips reads HEIF only with AV1 (patents).
 * libheif applies the container's rotation and mirroring itself. Each file runs in a short-lived worker thread
 * that returns its master: WASM memory never shrinks once grown, so the thread is ended after every file and its
 * memory goes with it; a decoder failure or blow-up stays in the thread. While it decodes, the process RSS is
 * watched: past `maxRssGrowth` the thread is ended (WASM work only — the encode, which reads the WASM memory from
 * libvips threads, is never cut off by the watchdog; it stops itself on its own timeout).
 */
export async function heicMaster(
  bytes: Uint8Array,
  maxRssGrowth = HEIC_MAX_RSS_GROWTH,
): Promise<{ master: Uint8Array; width: number; height: number }> {
  const require = createRequire(import.meta.url);
  const startRss = process.memoryUsage.rss();
  const thread = new Worker(HEIC_THREAD, {
    eval: true,
    workerData: {
      libheif: require.resolve('libheif-js/wasm-bundle'),
      sharp: require.resolve('sharp'),
      threads: sharpThreads(),
      bytes,
      maxPixels: MAX_HEIC_PIXELS,
      resize: MASTER_RESIZE,
      webp: MASTER_WEBP,
      encodeSeconds: HEIC_ENCODE_SECONDS,
    },
    resourceLimits: { maxOldGenerationSizeMb: 128 },
  });
  let watchdog: NodeJS.Timeout | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new ImageInputError('HEIC decode timed out')), HEIC_TIMEOUT_MS);
      watchdog = setInterval(() => {
        if (process.memoryUsage.rss() - startRss > maxRssGrowth) {
          reject(new ImageInputError('HEIC decode past its memory cap'));
        }
      }, WATCHDOG_MS);
      thread.on(
        'message',
        (m: { error?: string; decoded?: true; master: Uint8Array; width: number; height: number }) => {
          if (m.decoded) {
            // Decoded within the cap: the encode is bounded by the pixel cap and stops on its own timeout.
            clearInterval(watchdog);
            clearTimeout(timer);
            timer = setTimeout(
              () => reject(new ImageInputError('HEIC encode timed out')),
              HEIC_ENCODE_SECONDS * 1_000 + 10_000,
            );
            return;
          }
          if (m.error) reject(new ImageInputError(m.error));
          else resolve({ master: m.master, width: m.width, height: m.height });
        },
      );
      thread.once('error', (err) => reject(new ImageInputError(`HEIC not readable (${err.message})`)));
      thread.once('exit', (code) => reject(new ImageInputError(`HEIC decoder exited (${code})`)));
    });
  } finally {
    clearInterval(watchdog);
    clearTimeout(timer);
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
    return await heicMaster(bytes);
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
