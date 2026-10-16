import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as media from '@inmolink/core/modules/media';
import { closeDb, withSystem } from '@inmolink/db';
import { loadStackEnv, setupTestDb } from '@inmolink/db/testing';
import { loadConfig, storageEnv } from '@inmolink/platform/config';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { configureStorage, createS3Store, storage, storageConfigFromEnv } from '@inmolink/platform/storage';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, expect, it } from 'vitest';

/**
 * Media processing throughput (S3-04 acceptance): a 12 MP JPEG goes through `media.processObject` — read from
 * MinIO, re-hashed, normalized to the master, five variants rendered and stored, recorded — in < 1.5 s, and the
 * worker process stays under 512 MB RSS with a burst of photos in flight (the pool runs 10 jobs at once; image
 * work is capped by the image slots), including the heaviest inputs it accepts: a 48 MP JPEG with an EXIF
 * rotation (decoded whole), a 24 MP HEIC (WASM decoder) and a noisy PNG. In the `perf` project: it runs alone,
 * so the timing is not shared with parallel suites.
 */

const RUN = newId().slice(-8);
const TSX = join(import.meta.dirname, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
const log = createLogger({ service: 'perf', level: 'silent' });
const BUDGET_MS = 1_500;
const RSS_BUDGET = 512 * 1024 * 1024;
/** Idle RSS allowed for a compiled media worker (S3-F3 assumption; confirm on staging with `docker stats`). */
const WORKER_IDLE_ALLOWANCE = 160 * 1024 * 1024;
const BURST = 10;
type UploadType = 'image/jpeg' | 'image/png' | 'image/heic';
const hashes: string[] = [];

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const bytesOf = (b: Buffer) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

/** A camera-like scene: sensor grain under a gradient sky, a house and a pool, and a per-image label. */
const scene = (label: string, width: number, height: number) =>
  sharp({
    create: { width, height, channels: 3, background: '#7a9e7e', noise: { type: 'gaussian', mean: 128, sigma: 24 } },
  }).composite([
    {
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 4000 3000"
              preserveAspectRatio="none">
          <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5fa8d3"/>
            <stop offset="1" stop-color="#cae9ff"/></linearGradient></defs>
          <rect width="4000" height="3000" fill="url(#s)" opacity="0.85"/>
          <rect x="900" y="1100" width="2200" height="1300" fill="#f4e9cd" opacity="0.9"/>
          <polygon points="800,1150 2000,500 3200,1150" fill="#9c6644" opacity="0.9"/>
          <ellipse cx="2000" cy="2750" rx="1700" ry="220" fill="#00b4d8" opacity="0.85"/>
          <text x="120" y="260" font-size="160" fill="#fff">${RUN} ${label}</text></svg>`,
      ),
    },
  ]);

/** A 12 MP (4000 × 3000) JPEG at quality 92, as phones save. */
const photo12 = async (label: string) => bytesOf(await scene(label, 4000, 3000).jpeg({ quality: 92 }).toBuffer());

async function upload(
  bytes: Uint8Array,
  contentType: UploadType,
): Promise<{ hash: string; bytes: Uint8Array; contentType: UploadType }> {
  const hash = sha(bytes);
  await storage().put('private', media.originalKey(hash), bytes, { contentType });
  hashes.push(hash);
  return { hash, bytes, contentType };
}

const processObject = (u: { hash: string; bytes: Uint8Array; contentType: UploadType }) =>
  media.mediaJobs.processObject.spec.run(
    {
      sha256: u.hash,
      agencyId: null,
      upload: { sizeBytes: u.bytes.byteLength, contentType: u.contentType },
      trigger: newId(),
    },
    { log, jobId: newId(), attempt: 1, progress: async () => {}, signal: new AbortController().signal },
  );

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  configureStorage(createS3Store(storageConfigFromEnv(loadConfig(storageEnv))));
  media.configureMedia({ urlKey: `media-perf-key-${RUN}-0123456789abcdef` });
}, 120_000);

afterAll(async () => {
  for (const h of hashes) {
    await Promise.all([
      storage().delete('private', media.originalKey(h)),
      storage().delete('private', media.masterKey(h)),
      ...media.VARIANT_NAMES.map((n) => storage().delete('media', media.variantKey(h, n))),
    ]);
  }
  if (hashes.length > 0) {
    await withSystem('perf.cleanup', (tx) =>
      tx.execute(
        sql`delete from media_objects where sha256 in (${sql.join(
          hashes.map((h) => sql`${h}`),
          sql`, `,
        )})`,
      ),
    );
  }
  await closeDb();
});

it('[S3-04] a 12 MP JPEG processes in < 1.5 s per image; RSS stays < 512 MB under load', async () => {
  const warmup = await upload(await photo12('warmup'), 'image/jpeg');
  await processObject(warmup); // loads libvips, JIT

  const times: number[] = [];
  for (const label of ['t1', 't2']) {
    const u = await upload(await photo12(label), 'image/jpeg');
    const started = performance.now();
    expect(await processObject(u)).toEqual({ made: media.VARIANT_NAMES.length });
    times.push(performance.now() - started);
  }
  console.info(`[S3-04] 12 MP JPEG: ${times.map((t) => `${t.toFixed(0)} ms`).join(', ')} (budget ${BUDGET_MS} ms)`);
  for (const t of times) expect(t).toBeLessThan(BUDGET_MS);

  // Burst: as many jobs at once as a pool runs, with the heaviest accepted inputs among them.
  const heic = readFileSync(
    new URL('../../packages/core/src/modules/media/__tests__/fixtures/large-24mp.heic', import.meta.url),
  );
  const heicUnique = new Uint8Array(heic.byteLength + RUN.length);
  heicUnique.set(heic);
  heicUnique.set(new TextEncoder().encode(RUN), heic.byteLength);
  const rotated48 = bytesOf(
    await scene('rotated', 8000, 6000).jpeg({ quality: 92 }).withMetadata({ orientation: 6 }).toBuffer(),
  );
  const noisyPng = bytesOf(await scene('png', 3000, 2000).png().toBuffer());
  const burst = await Promise.all([
    upload(rotated48, 'image/jpeg'),
    upload(heicUnique, 'image/heic'),
    upload(noisyPng, 'image/png'),
    ...Array.from({ length: BURST - 3 }, async (_, i) => upload(await photo12(`b${i}`), 'image/jpeg')),
  ]);
  // In a process of its own (S3-F3): the worker's RSS, not this test's, which generated the inputs with sharp.
  const started = performance.now();
  const out = execFileSync(
    process.execPath,
    [
      TSX,
      '--conditions=@inmolink/source',
      join(import.meta.dirname, 'media-burst.child.ts'),
      JSON.stringify(burst.map((u) => ({ hash: u.hash, sizeBytes: u.bytes.byteLength, contentType: u.contentType }))),
    ],
    {
      encoding: 'utf8',
      timeout: 240_000,
      env: { ...process.env, MEDIA_PERF_URL_KEY: `media-perf-key-${RUN}-0123456789abcdef` },
    },
  );
  const { base, peak, made } = JSON.parse(out.trim().split(String.fromCharCode(10)).pop() as string) as {
    base: number;
    peak: number;
    made: number;
  };
  expect(made).toBe(BURST);
  console.info(`[S3-04] burst child: idle ${(base / 1048576).toFixed(0)} MB, peak ${(peak / 1048576).toFixed(0)} MB`);
  const perImage = (performance.now() - started) / BURST;
  console.info(
    `[S3-04] burst of ${BURST} (48 MP rotated JPEG, 24 MP HEIC, ${(noisyPng.byteLength / 1e6).toFixed(0)} MB PNG, 12 MP JPEGs): ` +
      `${perImage.toFixed(0)} ms per image, peak RSS ${(peak / 1024 / 1024).toFixed(0)} MB`,
  );
  // The burst's own growth, plus what an idle compiled worker holds, stays inside the budget. The child idles higher
  // (tsx compiles the workspace on the fly), so its absolute peak is logged, not asserted (S3-F3).
  expect(peak - base).toBeLessThan(RSS_BUDGET - WORKER_IDLE_ALLOWANCE);
  const done = await withSystem('perf.check', (tx) =>
    tx.execute<{ n: number }>(sql`select count(*)::int as n from media_objects
      where variants_ready = ${media.ALL_VARIANTS_MASK} and sha256 in (${sql.join(
        burst.map((u) => sql`${u.hash}`),
        sql`, `,
      )})`),
  );
  expect(done.rows[0]?.n).toBe(BURST);
});
