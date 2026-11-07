/**
 * The labelled dedupe fixture set (R2-03a): listings and labelled pairs, with generated photos (sharp, seeded) hashed
 * exactly like the media pipeline does (SHA-256 of the bytes, `media.perceptualHash`). Nothing is committed: the
 * images are drawn at test time (a few hundred 256 × 192 JPEGs, a couple of seconds).
 *
 * True duplicates (one property listed by two agencies):
 * - `exact` — the second agency uses most of the same files, price ±3 %, m² ±2 %, its pin within 30 m;
 * - `reencoded` — every photo re-encoded and resized (no shared SHA-256), price +4 %, m² −3 %, pin 100–200 m off;
 * - `cropped` — photos cropped 8 % or brightened plus two of its own, price −4.5 %, m² +6 %, half without a pin.
 *
 * Hard negatives:
 * - `same-building` — another flat in the building: pin within 10 m, the building's two photos shared, its own photos,
 *   m² 15–50 % and price 10–60 % apart, beds equal or one apart;
 * - `development-units` — units of one development listed by resellers: the developer's 5 renders on all 8 units (wide),
 *   3 photos of each unit; the same model (beds equal, m² and price within 4 %);
 * - `small-development` — a 3-unit development: 4 renders shared (not wide), 4 own photos, m² 12–25 % and price 10–25 %
 *   apart;
 * - `neighbour-villas` — villas 60–250 m apart with the same facts within ±10 %, different photos;
 * - `same-agency-gallery` — one agency listing two units with an identical gallery (same facts, price +2 %);
 * - `sale-vs-rent` — the same photos, one for sale and one for rent.
 */
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { perceptualHash } from '../../media';
import type { SignatureSource } from '../signature';

export type PairKind =
  | 'exact'
  | 'reencoded'
  | 'cropped'
  | 'same-building'
  | 'development-units'
  | 'small-development'
  | 'neighbour-villas'
  | 'same-agency-gallery'
  | 'sale-vs-rent';

export interface LabelledPair {
  a: string;
  b: string;
  duplicate: boolean;
  kind: PairKind;
}

export interface FixtureSet {
  listings: SignatureSource[];
  pairs: LabelledPair[];
}

/** mulberry32: a small seeded PRNG (the set is the same on every run). */
function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const W = 256;
const H = 192;

/** A synthetic "photo": a two-colour gradient, rectangles and discs of random colours, light noise. */
async function drawPhoto(seed: number): Promise<Buffer> {
  const r = rng(seed);
  const px = Buffer.alloc(W * H * 3);
  const c = () => [r() * 255, r() * 255, r() * 255];
  const [top, bottom] = [c(), c()];
  for (let y = 0; y < H; y++) {
    const f = y / H;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      for (let k = 0; k < 3; k++) px[i + k] = (top[k] as number) * (1 - f) + (bottom[k] as number) * f;
    }
  }
  for (let s = 0; s < 14; s++) {
    const col = c();
    const disc = s % 3 === 0;
    const x0 = Math.floor(r() * W);
    const y0 = Math.floor(r() * H);
    const w = 20 + Math.floor(r() * 90);
    const h = 20 + Math.floor(r() * 70);
    for (let y = Math.max(0, y0 - h); y < Math.min(H, y0 + h); y++) {
      for (let x = Math.max(0, x0 - w); x < Math.min(W, x0 + w); x++) {
        if (disc && ((x - x0) / w) ** 2 + ((y - y0) / h) ** 2 > 1) continue;
        const i = (y * W + x) * 3;
        for (let k = 0; k < 3; k++) px[i + k] = col[k] as number;
      }
    }
  }
  for (let i = 0; i < px.length; i++) px[i] = Math.max(0, Math.min(255, (px[i] as number) + (r() - 0.5) * 16));
  return sharp(px, { raw: { width: W, height: H, channels: 3 } })
    .jpeg({ quality: 85 })
    .toBuffer();
}

const reencode = (b: Buffer) => sharp(b).resize(224).jpeg({ quality: 60 }).toBuffer();
const crop = (b: Buffer) =>
  sharp(b)
    .extract({ left: 10, top: 8, width: W - 20, height: H - 16 })
    .resize(W, H)
    .jpeg({ quality: 75 })
    .toBuffer();
const brighten = (b: Buffer) => sharp(b).modulate({ brightness: 1.08 }).jpeg({ quality: 80 }).toBuffer();

async function hashed(bytes: Buffer): Promise<{ sha256: string; phash: bigint }> {
  return { sha256: createHash('sha256').update(bytes).digest('hex'), phash: await perceptualHash(bytes) };
}

export interface FixtureOptions {
  /** Where the set sits (a test run moves it so runs never share cells or keys). */
  origin?: { lat: number; lng: number };
  /** Ids are made by the caller (UUIDv7 in integration tests). */
  newId: () => string;
  agencies: readonly string[];
  /** Property types: [apartment, villa]. */
  types: readonly [string, string];
  locationIds: readonly string[];
  seed?: number;
}

/** Metres → degrees at the origin. */
const offset = (o: { lat: number; lng: number }, northM: number, eastM: number) => ({
  lat: o.lat + northM / 111_320,
  lng: o.lng + eastM / (111_320 * Math.cos((o.lat * Math.PI) / 180)),
});

export async function buildFixtureSet(opts: FixtureOptions): Promise<FixtureSet> {
  const r = rng(opts.seed ?? 20261107);
  const origin = opts.origin ?? { lat: 36.51, lng: -4.88 };
  let photoSeed = (opts.seed ?? 20261107) * 7;
  const photo = async () => hashed(await drawPhoto(photoSeed++));
  const photos = (n: number) => Promise.all(Array.from({ length: n }, () => drawPhoto(photoSeed++)));
  const listings: SignatureSource[] = [];
  const pairs: LabelledPair[] = [];
  const agency = (i: number) => opts.agencies[i % opts.agencies.length] as string;
  let place = 0;
  /** A new spot ~400 m from every other one (a grid): unrelated properties never neighbour by accident. */
  const spot = () => {
    const i = place++;
    return offset(origin, Math.floor(i / 20) * 400, (i % 20) * 400);
  };
  const pick = (lo: number, hi: number) => lo + r() * (hi - lo);
  const add = (l: Omit<SignatureSource, 'listingId' | 'version' | 'locationIds'>): string => {
    const id = opts.newId();
    listings.push({ ...l, listingId: id, version: 1, locationIds: opts.locationIds });
    return id;
  };
  const [apartment, villa] = opts.types;
  const base = (type: string) => ({
    transactionType: 'SALE',
    propertyTypeId: type,
    beds: 2 + Math.floor(r() * 3),
    baths: 1 + Math.floor(r() * 2),
    areaM2: Math.round(pick(70, 260)),
    priceCents: Math.round(pick(250_000, 1_500_000)) * 100,
  });

  // --- true duplicates
  for (let n = 0; n < 36; n++) {
    const kind: PairKind = n < 12 ? 'exact' : n < 24 ? 'reencoded' : 'cropped';
    const facts = base(n % 2 ? villa : apartment);
    const geo = spot();
    const raw = await photos(8);
    const own = await Promise.all(raw.map(hashed));
    const a = add({ ...facts, ownerAgencyId: agency(n), geo, images: own });
    let b: string;
    if (kind === 'exact') {
      b = add({
        ...facts,
        ownerAgencyId: agency(n + 1),
        priceCents: Math.round(facts.priceCents * pick(0.97, 1.03)),
        areaM2: Math.round(facts.areaM2 * pick(0.98, 1.02)),
        baths: n % 3 === 0 ? null : facts.baths,
        geo: offset(geo, pick(-20, 20), pick(-20, 20)),
        images: [...own.slice(0, 6), await photo()],
      });
    } else if (kind === 'reencoded') {
      b = add({
        ...facts,
        ownerAgencyId: agency(n + 1),
        priceCents: Math.round(facts.priceCents * 1.04),
        areaM2: Math.round(facts.areaM2 * 0.97),
        geo: offset(geo, pick(70, 140), pick(70, 140)),
        images: await Promise.all(raw.slice(0, 7).map(async (p) => hashed(await reencode(p)))),
      });
    } else {
      const edited = [
        ...(await Promise.all(raw.slice(0, 5).map(async (p) => hashed(await crop(p))))),
        await hashed(await brighten(raw[5] as Buffer)),
        await photo(),
        await photo(),
      ];
      b = add({
        ...facts,
        ownerAgencyId: agency(n + 1),
        priceCents: Math.round(facts.priceCents * 0.955),
        areaM2: Math.round(facts.areaM2 * 1.06),
        geo: n % 2 ? null : offset(geo, pick(-40, 40), pick(-40, 40)),
        images: edited,
      });
    }
    pairs.push({ a, b, duplicate: true, kind });
  }

  // --- hard negatives
  for (let n = 0; n < 12; n++) {
    const geo = spot();
    const building = await Promise.all((await photos(2)).map(hashed));
    const f1 = base(apartment);
    const a = add({
      ...f1,
      ownerAgencyId: agency(n),
      geo,
      images: [...building, ...(await Promise.all((await photos(6)).map(hashed)))],
    });
    const b = add({
      ...f1,
      ownerAgencyId: agency(n + 1),
      beds: (f1.beds ?? 2) + (n % 2),
      areaM2: Math.round(f1.areaM2 * pick(1.15, 1.5)),
      priceCents: Math.round(f1.priceCents * pick(1.1, 1.6)),
      geo: offset(geo, pick(-8, 8), pick(-8, 8)),
      images: [...building, ...(await Promise.all((await photos(6)).map(hashed)))],
    });
    pairs.push({ a, b, duplicate: false, kind: 'same-building' });
  }

  for (let d = 0; d < 3; d++) {
    const geo = spot();
    const renders = await Promise.all((await photos(5)).map(hashed));
    const model = base(apartment);
    const units: string[] = [];
    for (let u = 0; u < 8; u++) {
      units.push(
        add({
          ...model,
          ownerAgencyId: agency(d + u),
          areaM2: Math.round(model.areaM2 * pick(0.96, 1.04)),
          priceCents: Math.round(model.priceCents * pick(0.96, 1.04)),
          geo: offset(geo, pick(-20, 20), pick(-20, 20)),
          images: [...renders, ...(await Promise.all((await photos(3)).map(hashed)))],
        }),
      );
    }
    for (let u = 1; u < 8; u++) {
      pairs.push({ a: units[0] as string, b: units[u] as string, duplicate: false, kind: 'development-units' });
    }
  }

  for (let d = 0; d < 4; d++) {
    const geo = spot();
    const renders = await Promise.all((await photos(4)).map(hashed));
    const model = base(apartment);
    const units: string[] = [];
    for (let u = 0; u < 3; u++) {
      const grow = 1 + u * pick(0.12, 0.25);
      units.push(
        add({
          ...model,
          ownerAgencyId: agency(d + u),
          beds: (model.beds ?? 2) + (u === 2 ? 1 : 0),
          areaM2: Math.round(model.areaM2 * grow),
          priceCents: Math.round(model.priceCents * grow * pick(0.97, 1.0)),
          geo: offset(geo, pick(-15, 15), pick(-15, 15)),
          images: [...renders, ...(await Promise.all((await photos(4)).map(hashed)))],
        }),
      );
    }
    pairs.push({ a: units[0] as string, b: units[1] as string, duplicate: false, kind: 'small-development' });
    pairs.push({ a: units[0] as string, b: units[2] as string, duplicate: false, kind: 'small-development' });
  }

  for (let n = 0; n < 10; n++) {
    const geo = spot();
    const f = base(villa);
    const a = add({ ...f, ownerAgencyId: agency(n), geo, images: await Promise.all((await photos(8)).map(hashed)) });
    const b = add({
      ...f,
      ownerAgencyId: agency(n + 1),
      areaM2: Math.round(f.areaM2 * pick(0.9, 1.1)),
      priceCents: Math.round(f.priceCents * pick(0.92, 1.08)),
      geo: offset(geo, pick(60, 180), pick(-180, 180)),
      images: await Promise.all((await photos(8)).map(hashed)),
    });
    pairs.push({ a, b, duplicate: false, kind: 'neighbour-villas' });
  }

  for (let n = 0; n < 6; n++) {
    const geo = spot();
    const f = base(apartment);
    const gallery = await Promise.all((await photos(6)).map(hashed));
    const a = add({ ...f, ownerAgencyId: agency(n), geo, images: gallery });
    const b = add({
      ...f,
      ownerAgencyId: agency(n),
      priceCents: Math.round(f.priceCents * 1.02),
      geo: offset(geo, 3, 3),
      images: gallery,
    });
    pairs.push({ a, b, duplicate: false, kind: 'same-agency-gallery' });
  }

  for (let n = 0; n < 4; n++) {
    const geo = spot();
    const f = base(villa);
    const gallery = await Promise.all((await photos(6)).map(hashed));
    const a = add({ ...f, ownerAgencyId: agency(n), geo, images: gallery });
    const b = add({
      ...f,
      transactionType: 'RENT',
      priceCents: 350_000,
      ownerAgencyId: agency(n + 1),
      geo,
      images: gallery,
    });
    pairs.push({ a, b, duplicate: false, kind: 'sale-vs-rent' });
  }

  return { listings, pairs };
}
