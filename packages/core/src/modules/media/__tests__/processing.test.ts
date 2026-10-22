import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import sharp, { type Sharp } from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  freeImageSlots,
  HEAVY_INPUT_PIXELS,
  HEIC_MAX_RSS_GROWTH,
  hammingDistance,
  heicMaster,
  IMAGE_SLOTS,
  ImageInputError,
  isHeavyInput,
  normalizeOriginal,
  phashOf,
  renderVariants,
  withImageSlot,
} from '../processing';
import { ALL_VARIANTS_MASK, MEDIA_PIPELINE_VERSION, VARIANT_NAMES, variantsIn, variantsMask } from '../variants';

/** The parts of libheif-js the HEIC reference decode uses (its whole-image RGBA path, as before S8-F7). */
interface LibheifForTest {
  HeifDecoder: new () => {
    decode(bytes: Uint8Array): {
      get_width(): number;
      get_height(): number;
      display(
        target: { data: Uint8ClampedArray; width: number; height: number },
        done: (d: { data: Uint8ClampedArray }) => void,
      ): void;
      free(): void;
    }[];
    decoder: { delete(): void };
  };
}

/** A copy of a HEIC whose every `ispe` box (declared image size) says `width` × `height`. */
function withIspe(file: Uint8Array, width: number, height: number): Uint8Array {
  const out = file.slice();
  const view = new DataView(out.buffer);
  let patched = 0;
  for (let i = 4; i + 16 <= out.length; i++) {
    // size 20: 4 size + 4 type + 4 version/flags + 4 width + 4 height
    if (view.getUint32(i - 4) === 20 && String.fromCharCode(...out.subarray(i, i + 4)) === 'ispe') {
      view.setUint32(i + 8, width);
      view.setUint32(i + 12, height);
      patched++;
    }
  }
  if (patched === 0) throw new Error('no ispe box');
  return out;
}

/** A scene: a gradient with shapes, so the perceptual hash has structure to see. */
const scene = (width: number, height: number, shapes: string) =>
  sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 800 600">
        <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#1d3557"/><stop offset="1" stop-color="#f1faee"/></linearGradient></defs>
        <rect width="800" height="600" fill="url(#g)"/>${shapes}</svg>`,
    ),
  );
const HOUSE =
  '<rect x="200" y="250" width="400" height="300" fill="#e63946"/><circle cx="650" cy="120" r="70" fill="#ffb703"/>';
const POOL =
  '<ellipse cx="400" cy="450" rx="350" ry="90" fill="#219ebc"/><rect x="50" y="50" width="120" height="380" fill="#2a9d8f"/>';

const phashOfImage = async (img: Sharp) => {
  const { data, info } = await img
    .flatten()
    .greyscale()
    .resize(32, 32, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return phashOf(data, info.channels);
};

describe('media processing (S3-04)', () => {
  it('[S3-04] pHash: a resized re-encode of a photo stays close, another photo is far', async () => {
    const original = await scene(1600, 1200, HOUSE).jpeg({ quality: 92 }).toBuffer();
    const resized = await sharp(original).resize(640).webp({ quality: 60 }).toBuffer();
    const other = await scene(1600, 1200, POOL).jpeg({ quality: 92 }).toBuffer();
    const [h1, h2, h3] = await Promise.all([original, resized, other].map((b) => phashOfImage(sharp(b))));
    expect(hammingDistance(h1 as bigint, h2 as bigint)).toBeLessThanOrEqual(4);
    expect(hammingDistance(h1 as bigint, h3 as bigint)).toBeGreaterThanOrEqual(16);
    // Signed 64-bit, like Postgres bigint.
    expect((h1 as bigint) >= -(2n ** 63n) && (h1 as bigint) < 2n ** 63n).toBe(true);
  });

  it('[S3-04] variants of the same master are byte-identical run after run, and fit their sizes', async () => {
    const photo = await scene(3000, 2000, HOUSE).jpeg({ quality: 90 }).toBuffer();
    const { master, width, height } = await normalizeOriginal(photo, 'image/jpeg');
    expect([width, height]).toEqual([2560, 1707]);
    const first = await renderVariants(master, VARIANT_NAMES);
    const again = await renderVariants(master, ['og', 'thumb']);
    expect(Buffer.from(again.files.get('og') ?? [])).toEqual(Buffer.from(first.files.get('og') ?? []));
    expect(Buffer.from(again.files.get('thumb') ?? [])).toEqual(Buffer.from(first.files.get('thumb') ?? []));
    expect(again.phash).toBe(first.phash);

    const meta = async (name: (typeof VARIANT_NAMES)[number]) => sharp(first.files.get(name)).metadata();
    expect(await meta('thumb')).toMatchObject({ format: 'webp', width: 320, height: 213 });
    expect(await meta('large')).toMatchObject({ format: 'webp', width: 2048 });
    expect(await meta('og')).toMatchObject({ format: 'jpeg', width: 1200, height: 630 });
    expect(variantsIn(ALL_VARIANTS_MASK)).toEqual(VARIANT_NAMES);
    expect(variantsMask(['thumb', 'og'])).toBe(17);
  });

  it('[S3-04] never enlarges a small image; an unreadable file is a permanent input error', async () => {
    const small = await scene(400, 300, HOUSE).png().toBuffer();
    const { master, width } = await normalizeOriginal(small, 'image/png');
    expect(width).toBe(400);
    const rendered = await renderVariants(master, ['large']);
    expect((await sharp(rendered.files.get('large')).metadata()).width).toBe(400);

    const junk = new Uint8Array(4_096).fill(0x41);
    junk.set([0xff, 0xd8, 0xff, 0xe0]);
    await expect(normalizeOriginal(junk, 'image/jpeg')).rejects.toBeInstanceOf(ImageInputError);
    await expect(normalizeOriginal(junk, 'image/heic')).rejects.toBeInstanceOf(ImageInputError);
  });

  it('[S3-04] inputs past the pixel caps are refused before they are decoded', async () => {
    const heic = new Uint8Array(readFileSync(new URL('./fixtures/oversized-30mp.heic', import.meta.url)));
    await expect(normalizeOriginal(heic, 'image/heic')).rejects.toThrow(/HEIC too large/);
    const huge = await sharp({ create: { width: 10_000, height: 6_000, channels: 3, background: '#88aacc' } })
      .png({ compressionLevel: 9 })
      .toBuffer();
    await expect(normalizeOriginal(huge, 'image/png')).rejects.toBeInstanceOf(ImageInputError);
  });

  it('[S8-F7] a 24 MP HEIC leaves its decoder thread as the master: RGB without alpha, longest side 2560', async () => {
    const heic = new Uint8Array(readFileSync(new URL('./fixtures/large-24mp.heic', import.meta.url)));
    const { master, width, height } = await normalizeOriginal(heic, 'image/heic');
    const meta = await sharp(master).metadata();
    expect({ format: meta.format, width: meta.width, height: meta.height }).toEqual({ format: 'webp', width, height });
    expect(Math.max(width, height)).toBe(2_560);
    expect({ channels: meta.channels, hasAlpha: meta.hasAlpha }).toEqual({ channels: 3, hasAlpha: false });
  });

  it('[S8-F7] the HEIC master has the decoder pixels: padded rows packed right (reference: whole RGBA decode)', async () => {
    // 5000 px wide RGB: libheif pads each 15,000-byte row to 15,008, so a packing slip would shear the image.
    const heic = readFileSync(new URL('./fixtures/large-24mp.heic', import.meta.url));
    const { master, width, height } = await normalizeOriginal(new Uint8Array(heic), 'image/heic');
    const libheif = createRequire(import.meta.url)('libheif-js/wasm-bundle') as LibheifForTest;
    const decoder = new libheif.HeifDecoder();
    const [image] = decoder.decode(heic);
    if (!image) throw new Error('fixture has no image');
    const w = image.get_width();
    const h = image.get_height();
    const rgba = await new Promise<{ data: Uint8ClampedArray }>((done) =>
      image.display({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }, done),
    );
    image.free();
    decoder.decoder.delete();
    const raw = { raw: { width: w, height: h, channels: 4 as const } };
    const reference = await sharp(Buffer.from(rgba.data.buffer), raw)
      .removeAlpha()
      .resize({ width, height, fit: 'fill' })
      .raw()
      .toBuffer();
    const got = await sharp(master).raw().toBuffer();
    expect(got.length).toBe(reference.length);
    let diff = 0;
    for (let i = 0; i < got.length; i++) diff += Math.abs((got[i] ?? 0) - (reference[i] ?? 0));
    // WebP at quality 90 only: a sheared or shifted row would be tens of levels off on average.
    expect(diff / got.length).toBeLessThan(2);
  });

  it('[S8-F7] a truncated HEIC, one that declares less than it holds and one past the cap behind a small ispe are refused', async () => {
    const large = new Uint8Array(readFileSync(new URL('./fixtures/large-24mp.heic', import.meta.url)));
    const oversized = new Uint8Array(readFileSync(new URL('./fixtures/oversized-30mp.heic', import.meta.url)));
    await expect(heicMaster(large.slice(0, Math.floor(large.byteLength / 2)))).rejects.toBeInstanceOf(ImageInputError);
    // The declared size (ispe) says 100 × 100; the coded stream is 5000 × 4800.
    await expect(heicMaster(withIspe(large, 100, 100))).rejects.toBeInstanceOf(ImageInputError);
    // Declared 12 MP, coded 30 MP: past MAX_HEIC_PIXELS whatever the header says.
    await expect(heicMaster(withIspe(oversized, 4_000, 3_000))).rejects.toBeInstanceOf(ImageInputError);
  });

  it('[S8-F7] a HEIC decode past its memory cap is ended', async () => {
    const heic = new Uint8Array(readFileSync(new URL('./fixtures/large-24mp.heic', import.meta.url)));
    await expect(heicMaster(heic, 1)).rejects.toThrow(/memory cap/);
    expect(HEIC_MAX_RSS_GROWTH).toBeLessThan(512 * 1024 * 1024);
  });

  it('[S3-04] the encoder stack is pinned: an upgrade must come with a MEDIA_PIPELINE_VERSION bump', () => {
    // Variants are byte-identical only for the same libvips, libwebp and mozjpeg. A new sharp may change the
    // bytes under unchanged keys: bump the pipeline version (new keys, regenerated on demand), then this pin.
    expect(MEDIA_PIPELINE_VERSION).toBe(1);
    expect({ sharp: sharp.versions.sharp, vips: sharp.versions.vips, webp: sharp.versions.webp }).toEqual({
      sharp: '0.35.5',
      vips: '8.18.7',
      webp: '1.6.0',
    });
  });
});

describe('image slots (S6-F5)', () => {
  const flat = (width: number, height: number) =>
    sharp({ create: { width, height, channels: 3, background: '#88aacc' } })
      .jpeg({ quality: 50 })
      .toBuffer();

  it('[S6-F5] a 48 MP original is heavy by its header, a 12 MP one is not, a HEIC always is', async () => {
    expect(8_000 * 6_000).toBeGreaterThan(HEAVY_INPUT_PIXELS);
    expect(4_000 * 3_000).toBeLessThanOrEqual(HEAVY_INPUT_PIXELS);
    expect(await isHeavyInput(await flat(8_000, 6_000), 'image/jpeg')).toBe(true);
    expect(await isHeavyInput(await flat(4_000, 3_000), 'image/jpeg')).toBe(false);
    const heic = new Uint8Array(readFileSync(new URL('./fixtures/large-24mp.heic', import.meta.url)));
    expect(await isHeavyInput(heic, 'image/heic')).toBe(true);
    // An unreadable header is not heavy: normalizeOriginal refuses the file.
    expect(await isHeavyInput(new Uint8Array(64).fill(0x41), 'image/jpeg')).toBe(false);
  });

  it('[S6-F5] a heavy input decodes alone: takeAll waits for every slot, and two upgrading jobs never deadlock', async () => {
    expect(IMAGE_SLOTS).toBe(2);
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const heavyJob = (name: string) =>
      withImageSlot(false, async (takeAll) => {
        await held;
        await takeAll();
        order.push(`${name}:alone=${freeImageSlots() === 0}`);
        await new Promise((r) => setTimeout(r, 10));
        order.push(`${name}:done`);
      });
    const a = heavyJob('a');
    const b = heavyJob('b');
    expect(freeImageSlots()).toBe(0);
    release();
    await Promise.all([a, b]);
    // One after the other, each holding every slot while it decodes.
    expect(order).toEqual(['a:alone=true', 'a:done', 'b:alone=true', 'b:done']);
    expect(freeImageSlots()).toBe(IMAGE_SLOTS);
  });
});
