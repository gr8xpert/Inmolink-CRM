import { MEDIA_BATCH_MAX, MEDIA_MAX_BYTES, MEDIA_UPLOAD_TYPES } from '@inmolink/contracts/values';

/**
 * Media manager upload planning (S3-06), free of React and the DOM so it is unit tested: which content type a
 * chosen file has, which files are skipped before any request (already on the listing, chosen twice), how the
 * rest are batched for `check` / `register`, and how a PUT is retried.
 */

export type UploadType = (typeof MEDIA_UPLOAD_TYPES)[number];

const BY_EXTENSION: Record<string, UploadType> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heic',
};

/**
 * The upload type the browser declares (the stored bytes decide at register). Browsers often leave HEIC's type
 * empty, so the extension is the fallback. Null: not an accepted image.
 */
export function uploadTypeOf(file: { name: string; type: string }): UploadType | null {
  const type = file.type.toLowerCase();
  if ((MEDIA_UPLOAD_TYPES as readonly string[]).includes(type)) return type as UploadType;
  if (type === 'image/jpg') return 'image/jpeg';
  if (type === 'image/heif') return 'image/heic';
  if (type !== '' && type !== 'application/octet-stream') return null;
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  return BY_EXTENSION[ext] ?? null;
}

/** Why a file is refused before hashing: not an accepted image, or over the size cap. */
export function refusalOf(file: { name: string; type: string; size: number }): 'type' | 'size' | null {
  if (uploadTypeOf(file) === null) return 'type';
  if (file.size <= 0 || file.size > MEDIA_MAX_BYTES) return 'size';
  return null;
}

/**
 * Splits hashed files into the ones to send and the ones skipped without a request: the listing has the file
 * already (`attached`), or the same bytes were chosen twice in this drop (the first one counts). Input order
 * is kept.
 */
export function partition<T extends { sha256: string }>(
  files: T[],
  attached: ReadonlySet<string>,
): { send: T[]; skipped: T[]; duplicates: T[] } {
  const seen = new Set<string>();
  const out = { send: [] as T[], skipped: [] as T[], duplicates: [] as T[] };
  for (const f of files) {
    if (attached.has(f.sha256)) out.skipped.push(f);
    else if (seen.has(f.sha256)) out.duplicates.push(f);
    else {
      seen.add(f.sha256);
      out.send.push(f);
    }
  }
  return out;
}

/** Consecutive batches of at most `size` (the API takes `MEDIA_BATCH_MAX` files per check or register). */
export function batches<T>(items: T[], size = MEDIA_BATCH_MAX): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** How many times one PUT is tried before the file is marked failed. */
export const PUT_ATTEMPTS = 3;
/** PUTs in flight at once per drop. */
export const PUT_CONCURRENCY = 4;

/** A PUT answer: 2xx is stored; 412 means the object exists already (create-only URL) — both are done. */
export function putOutcome(status: number): 'done' | 'retry' | 'fail' {
  if ((status >= 200 && status < 300) || status === 412) return 'done';
  // 0: network error or CORS failure; 408/429/5xx: try again.
  if (status === 0 || status === 408 || status === 429 || status >= 500) return 'retry';
  return 'fail';
}

/** Backoff before attempt `attempt` (1-based, the first retry is attempt 2): 0.5 s, 1 s, 2 s … capped at 8 s. */
export function retryDelayMs(attempt: number): number {
  return Math.min(8_000, 500 * 2 ** Math.max(0, attempt - 2));
}

/** Runs `fn` over `items` with at most `limit` in flight; results in input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return out;
}

/** The order after dragging the item at `from` onto position `to`. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const out = [...items];
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out;
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved as T);
  return out;
}

/** Browsers set `content-length` themselves (a forbidden header); every other signed header is sent as given. */
export function putHeaders(signed: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(signed).filter(([k]) => k.toLowerCase() !== 'content-length'));
}
