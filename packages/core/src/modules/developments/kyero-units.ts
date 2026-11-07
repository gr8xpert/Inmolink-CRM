/**
 * A developer's Kyero v3 file read as a development's units (R2-07a, PLAN §7 M3 "bulk upload"). The file is not
 * stored and nothing is written: the owner's dashboard shows how many units are ready (or the problems by property)
 * and sends the units to `createUnits`, the same path as the CSV import — one write path, one unit limit, one audit.
 *
 * Each `<property>` is one unit: `id` (or `ref`) → reference, `type` → property type (the taxonomy's names and
 * aliases), `price` → price, `beds` / `baths`, `surface_area/built` → internal m², `surface_area/plot` → plot m².
 * Rentals (`price_freq` month / week) are refused: units are for sale. Kyero carries no unit status, so every unit
 * starts AVAILABLE (the availability toggles change it). A price in another currency than the development's is a
 * problem, never converted.
 *
 * Untrusted input: the size is capped before reading (`KYERO_UNITS_MAX_BYTES`), the start must look like XML (a
 * renamed binary is refused), and the XXE-safe streaming parser (`platform/xml`: no DOCTYPE, bounded records) reads
 * one `<property>` at a time and stops after one more than a bulk may hold. The authorization is its own short
 * transaction, the parse runs outside any, and the type names resolve in a second short one (two statements at most).
 */
import {
  type CreateUnitsBody,
  KYERO_UNITS_MAX_BYTES,
  type KyeroUnitProblemReason,
  type KyeroUnitsPreview,
  MAX_UNITS_PER_BULK,
} from '@inmolink/contracts';
import { priceToCents } from '@inmolink/contracts/developments-csv';
import { AppError } from '@inmolink/platform/errors';
import { childOf, childText, isXmlStreamError, streamXmlRecords, type XmlElement } from '@inmolink/platform/xml';
import type { CtxRunner } from '../../context';
import * as taxonomy from '../taxonomy';
import { assertCan } from './policy';
import * as repo from './repo';

type Unit = CreateUnitsBody['units'][number];
type Problem = KyeroUnitsPreview['problems'][number];

/** Problems listed in the answer; the rest are counted. */
const SHOWN_PROBLEMS = 100;
const REF_MAX = 40;
const AREA_MAX = 1_000_000;
const PRICE_MAX = 100_000_000_000;

const invalid = (reason: string) => new AppError('KYERO_FILE_INVALID', { reason });

/** The bytes start like an XML document (after an optional byte-order mark and whitespace). */
export function looksLikeXml(bytes: Uint8Array): boolean {
  const le = bytes[0] === 0xff && bytes[1] === 0xfe;
  const be = bytes[0] === 0xfe && bytes[1] === 0xff;
  let head: string;
  if (le || be) {
    head = new TextDecoder(le ? 'utf-16le' : 'utf-16be').decode(bytes.subarray(2, 130));
  } else {
    if (bytes.subarray(0, 512).includes(0)) return false;
    const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    head = Buffer.from(bytes.subarray(start, start + 128)).toString('latin1');
  }
  return /^[ \t\r\n]*<[?!A-Za-z_]/.test(head);
}

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

/** A whole number in range, null when absent, undefined when not one. */
function whole(raw: string | undefined, max: number): number | null | undefined {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 0 && n <= max ? n : undefined;
}

/** A positive area (decimal point or comma), null when absent or 0, undefined when not a number in range. */
function area(raw: string | undefined): number | null | undefined {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw.trim().replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > AREA_MAX) return undefined;
  return n === 0 ? null : n;
}

interface Read {
  position: number;
  ref: string;
  typeText: string;
  unit: Omit<Unit, 'propertyTypeId'>;
}

/** One `<property>` as a unit without its type id, or its problems. Pure. */
export function kyeroPropertyToUnit(
  raw: XmlElement,
  position: number,
  currency: string,
): { ok: true; read: Read } | { ok: false; problems: Problem[] } {
  const ref = (childText(raw, 'id') ?? childText(raw, 'ref'))?.trim() ?? '';
  const problems: Problem[] = [];
  const add = (field: string, reason: KyeroUnitProblemReason) =>
    problems.push({ position, ref: ref ? ref.slice(0, REF_MAX) : null, field, reason });
  if (!ref) add('id', 'required');
  else if (ref.length > REF_MAX) add('id', 'invalid');

  const freq = (childText(raw, 'price_freq') ?? 'sale').trim().toLowerCase();
  if (freq !== 'sale') add('price_freq', 'notSale');
  const typeText = childText(raw, 'type')?.trim() ?? '';
  if (!typeText) add('type', 'required');

  const priceText = childText(raw, 'price')?.trim();
  let priceCents: number | null = null;
  if (priceText) {
    const cents = priceToCents(priceText);
    if (cents === undefined || (cents !== null && cents > PRICE_MAX)) add('price', 'invalid');
    else priceCents = cents === 0 ? null : cents;
  }
  const own = childText(raw, 'currency')?.trim().toUpperCase();
  if (own && priceCents !== null && own !== currency) add('currency', 'currency');

  const bedrooms = whole(childText(raw, 'beds'), 1000);
  if (bedrooms === undefined) add('beds', 'invalid');
  const bathrooms = whole(childText(raw, 'baths'), 1000);
  if (bathrooms === undefined) add('baths', 'invalid');
  const surface = childOf(raw, 'surface_area');
  const internalM2 = area(surface ? childText(surface, 'built') : undefined);
  if (internalM2 === undefined) add('surface_area.built', 'invalid');
  const plotM2 = area(surface ? childText(surface, 'plot') : undefined);
  if (plotM2 === undefined) add('surface_area.plot', 'invalid');

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    read: {
      position,
      ref,
      typeText,
      unit: {
        ref,
        bedrooms: bedrooms ?? null,
        bathrooms: bathrooms ?? null,
        internalM2: internalM2 ?? null,
        plotM2: plotM2 ?? null,
        priceCents,
      },
    },
  };
}

/**
 * `POST /v1/developments/:id/units/kyero` (raw XML body ≤ 5 MB): the file's properties as units for this
 * development, or why not. The owner's writers only (`development.update`, the CSV import's right).
 */
export async function readKyeroUnits(
  run: CtxRunner,
  developmentId: string,
  bytes: Uint8Array,
): Promise<KyeroUnitsPreview> {
  if (bytes.byteLength === 0) throw invalid('EMPTY');
  if (bytes.byteLength > KYERO_UNITS_MAX_BYTES)
    throw new AppError('PAYLOAD_TOO_LARGE', { maxBytes: KYERO_UNITS_MAX_BYTES });
  if (!looksLikeXml(bytes)) throw invalid('NOT_XML');
  // A short transaction for the right and the currency; the parse runs outside it (rule 6 spirit: no slow work).
  // Nothing is written, so the development is read without the row lock edits take; same answers as `ownForChange`.
  const dev = await run(async (ctx) => {
    assertCan(ctx, 'development.update');
    const row = await repo.getDevelopment(ctx.tx, developmentId);
    if (!row) throw new AppError('DEVELOPMENT_NOT_FOUND');
    if (row.agencyId !== ctx.tenant.agencyId) throw new AppError('FORBIDDEN');
    return row;
  });

  const reads: Read[] = [];
  const problems: Problem[] = [];
  const seen = new Set<string>();
  let position = 0;
  try {
    for await (const el of streamXmlRecords(once(bytes), { recordElement: 'property', maxRecordBytes: 256 * 1024 })) {
      position += 1;
      if (position > MAX_UNITS_PER_BULK) {
        problems.push({ position, ref: null, field: 'file', reason: 'tooMany' });
        break;
      }
      const r = kyeroPropertyToUnit(el, position, dev.currency);
      // A repeated id is reported even when its first copy has problems of its own (one pass shows them all).
      const id = (childText(el, 'id') ?? childText(el, 'ref'))?.trim();
      const repeated = id ? seen.has(id) : false;
      if (id) seen.add(id);
      if (repeated) problems.push({ position, ref: id?.slice(0, REF_MAX) ?? null, field: 'id', reason: 'duplicate' });
      if (!r.ok) problems.push(...r.problems);
      else if (!repeated) reads.push(r.read);
    }
  } catch (err) {
    if (isXmlStreamError(err)) throw invalid(err.code);
    throw err;
  }
  if (position === 0) throw invalid('NO_RECORDS');

  // The type names, resolved in one statement (exact names and aliases, confident fuzzy matches).
  const resolved =
    reads.length === 0
      ? []
      : await run((ctx) =>
          taxonomy.resolveMany(
            ctx.tx,
            'propertyType',
            reads.map((r) => r.typeText),
          ),
        );
  const units: Unit[] = [];
  reads.forEach((r, i) => {
    const id = resolved[i]?.id ?? null;
    if (!id) problems.push({ position: r.position, ref: r.ref, field: 'type', reason: 'unknownType' });
    else units.push({ ...r.unit, propertyTypeId: id });
  });
  problems.sort((a, b) => a.position - b.position);
  return {
    units: problems.length > 0 ? [] : units,
    problems: problems.slice(0, SHOWN_PROBLEMS),
    moreProblems: Math.max(0, problems.length - SHOWN_PROBLEMS),
  };
}
