/**
 * A listing's duplicate-detection signature (R2-03a, PLAN §10): its facts as the read models have them, its first
 * images' hashes and the blocking keys candidate generation probes. Pure: no I/O.
 *
 * Blocking keys (64-bit, one GIN index; never all pairs):
 * - **exact image** — the first 64 bits of the image's SHA-256 (the same value as in `image_keys`, so a key's
 *   frequency is the image's frequency);
 * - **pHash LSH band** — `ph:<band>:<16 bits>:<city>`: the 64-bit pHash split into `PHASH_BANDS` bands of 16 bits.
 *   Two photos within 3 bits share a band for certain (pigeonhole), most re-encodes and light crops share one too; the
 *   city scopes a band (65,536 values a band would be common platform-wide);
 * - **geo** — `geo:<row>:<col>:<transaction>:<type>:<beds>` of a ~`GEO_CELL_M` grid cell. Stored for the listing's
 *   own cell; probed for the 3 × 3 neighbourhood (same beds) and its own cell with beds ± 1, so a pin up to a cell
 *   away is found.
 *
 * pHash bands are keyed for the first `PHASH_BAND_IMAGES` images only; every image is compared when scoring.
 */
import { createHash } from 'node:crypto';

/** A new value rebuilds the stored keys (run the backfill). */
export const SIGNATURE_VERSION = 1;
/** Images per listing compared and keyed (display order: the first ones are the property's own photos). */
export const MAX_IMAGES = 12;
export const PHASH_BANDS = 4;
/** Images whose pHash bands are keys (the first ones: the index stays ~40 % smaller; all `MAX_IMAGES` are compared). */
export const PHASH_BAND_IMAGES = 6;
const BAND_BITS = 16;
/** Geo grid cell edge, metres. */
export const GEO_CELL_M = 150;
const M_PER_DEG_LAT = 111_320;

/** What a signature is built from: the read model's index document fields and the media pipeline's image hashes. */
export interface SignatureSource {
  listingId: string;
  ownerAgencyId: string;
  version: number;
  transactionType: string;
  propertyTypeId: string;
  /** Country, region, city, area ids (the read model's lineage). */
  locationIds: readonly string[];
  beds: number | null;
  baths: number | null;
  areaM2: number | null;
  /** Null: price on request. */
  priceCents: number | null;
  geo: { lat: number; lng: number } | null;
  images: readonly { sha256: string; phash: bigint | null }[];
}

export interface Signature {
  listingId: string;
  ownerAgencyId: string;
  sourceVersion: number;
  signatureVersion: number;
  transactionType: string;
  propertyTypeId: string;
  cityId: string | null;
  beds: number | null;
  baths: number | null;
  areaM2: number | null;
  priceCents: number | null;
  lat: number | null;
  lng: number | null;
  imageKeys: bigint[];
  /** Parallel to `imageKeys`; 0n when the pipeline computed none. */
  phashes: bigint[];
  blockKeys: bigint[];
}

/** A string's 64-bit key: the first 8 bytes of its SHA-256, as a signed bigint (Postgres `bigint`). */
export function keyOf(s: string): bigint {
  return BigInt.asIntN(64, BigInt(`0x${createHash('sha256').update(s).digest('hex').slice(0, 16)}`));
}

/** An image's key: the first 64 bits of its SHA-256 (hex), signed. */
export const imageKeyOf = (sha256: string): bigint => BigInt.asIntN(64, BigInt(`0x${sha256.slice(0, 16)}`));

/** The city-level place: the third id of the lineage (country, region, city, area), else the most specific one. */
export const cityOf = (locationIds: readonly string[]): string | null => locationIds[2] ?? locationIds.at(-1) ?? null;

export function phashBandKeys(phash: bigint, city: string | null): bigint[] {
  const u = BigInt.asUintN(64, phash);
  const out: bigint[] = [];
  for (let band = 0; band < PHASH_BANDS; band++) {
    const v = (u >> BigInt(band * BAND_BITS)) & 0xffffn;
    out.push(keyOf(`ph:${band}:${v.toString(16)}:${city ?? '-'}`));
  }
  return out;
}

const LAT_STEP = GEO_CELL_M / M_PER_DEG_LAT;
const rowOf = (lat: number) => Math.floor(lat / LAT_STEP);
/** The row's longitude step: cells stay ~square away from the equator (cos of the row's centre latitude). */
const lngStepOf = (row: number) => LAT_STEP / Math.max(Math.cos(((row + 0.5) * LAT_STEP * Math.PI) / 180), 0.01);

const geoKey = (row: number, col: number, s: GeoFacts, beds: number | null) =>
  keyOf(`geo:${row}:${col}:${s.transactionType}:${s.propertyTypeId}:${beds ?? 'x'}`);

interface GeoFacts {
  transactionType: string;
  propertyTypeId: string;
}

/** The listing's own geo key (stored); none without a position. */
export function ownGeoKey(geo: { lat: number; lng: number }, facts: GeoFacts, beds: number | null): bigint {
  const row = rowOf(geo.lat);
  return geoKey(row, Math.floor(geo.lng / lngStepOf(row)), facts, beds);
}

/** The geo keys a listing probes: the 3 × 3 cells around it with its beds, and its own cell with beds ± 1 (11). */
export function probeGeoKeys(geo: { lat: number; lng: number }, facts: GeoFacts, beds: number | null): bigint[] {
  const row = rowOf(geo.lat);
  const out: bigint[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    const r = row + dr;
    const col = Math.floor(geo.lng / lngStepOf(r));
    for (let dc = -1; dc <= 1; dc++) out.push(geoKey(r, col + dc, facts, beds));
  }
  if (beds !== null) {
    const col = Math.floor(geo.lng / lngStepOf(row));
    for (const b of [beds - 1, beds + 1]) if (b >= 0) out.push(geoKey(row, col, facts, b));
  }
  return out;
}

const uniq = (keys: readonly bigint[]) => [...new Set(keys)];

/** The band keys of the first `PHASH_BAND_IMAGES` images with a pHash (0n: none — a flat image's is not keyed). */
const bandKeys = (phashes: readonly bigint[], city: string | null) =>
  phashes
    .slice(0, PHASH_BAND_IMAGES)
    .filter((p) => p !== 0n)
    .flatMap((p) => phashBandKeys(p, city));

export function signatureOf(src: SignatureSource): Signature {
  const images = src.images.slice(0, MAX_IMAGES);
  const city = cityOf(src.locationIds);
  const imageKeys = images.map((i) => imageKeyOf(i.sha256));
  const phashes = images.map((i) => i.phash ?? 0n);
  const blockKeys = uniq([
    ...imageKeys,
    ...bandKeys(phashes, city),
    ...(src.geo ? [ownGeoKey(src.geo, src, src.beds)] : []),
  ]);
  return {
    listingId: src.listingId,
    ownerAgencyId: src.ownerAgencyId,
    sourceVersion: src.version,
    signatureVersion: SIGNATURE_VERSION,
    transactionType: src.transactionType,
    propertyTypeId: src.propertyTypeId,
    cityId: city,
    beds: src.beds,
    baths: src.baths,
    areaM2: src.areaM2,
    priceCents: src.priceCents,
    lat: src.geo?.lat ?? null,
    lng: src.geo?.lng ?? null,
    imageKeys,
    phashes,
    blockKeys,
  };
}

/** The keys a signature probes: its image and pHash-band keys and the geo neighbourhood. */
export function probeKeysOf(s: Signature): bigint[] {
  const geo = s.lat !== null && s.lng !== null ? { lat: s.lat, lng: s.lng } : null;
  return uniq([...s.imageKeys, ...bandKeys(s.phashes, s.cityId), ...(geo ? probeGeoKeys(geo, s, s.beds) : [])]);
}
