/**
 * Listing use cases (S3-02, PATTERNS §7, PLAN §3 #4 #7 #18 #34 #57). Only the owner agency writes a listing;
 * agents change their own, admins any of the agency's. Every change is optimistic on `version`, writes price
 * and status history, and emits `properties.listing.*` in the same transaction. Other agencies read shared
 * listings through RLS (S3-01) and get the network view: no private fields.
 */
import { randomInt } from 'node:crypto';
import {
  type CeeRating,
  type Commission,
  type CreateListingBody,
  LISTING_CONFIRM_PROMPT_DAYS,
  LISTING_NETWORK_HIDE_DAYS,
  type ListingDto,
  type ListingFilter,
  type ListingFreshnessDto,
  type ListingPage,
  type ListingSort,
  type ListingStatus,
  type ListListingsQuery,
  type LockableListingField,
  type TransactionType,
  type UpdateListingBody,
  type Visibility,
} from '@inmolink/contracts';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { emit, type OutboxMessage } from '@inmolink/platform/outbox';
import { z } from 'zod';
import type { Ctx } from '../../context';
import { impersonatorOf } from '../../impersonation';
import { decodeCursor, encodeCursor } from '../../pagination';
import * as agencies from '../agencies';
import * as identity from '../identity';
import * as taxonomy from '../taxonomy';
import { propertiesEvents } from './events';
import { assertCan, type PropertiesAction } from './policy';
import * as repo from './repo';

/** Soft-deleted listings can be restored this long (PLAN §3 #34); a purge job removes them after. */
export const LISTING_RESTORE_DAYS = 30;

/**
 * The status lifecycle. SOLD is for sales and RENTED for rentals; a sold or rented listing can come back on
 * the market (a rental ends, a sale falls through).
 */
const STATUS_FLOW: Record<ListingStatus, readonly ListingStatus[]> = {
  DRAFT: ['ACTIVE', 'WITHDRAWN'],
  ACTIVE: ['UNDER_OFFER', 'SOLD', 'RENTED', 'WITHDRAWN', 'DRAFT'],
  UNDER_OFFER: ['ACTIVE', 'SOLD', 'RENTED', 'WITHDRAWN'],
  SOLD: ['ACTIVE', 'WITHDRAWN'],
  RENTED: ['ACTIVE', 'WITHDRAWN'],
  WITHDRAWN: ['ACTIVE', 'DRAFT'],
};

/** A CEE rating that allows advertising: A–G or EXEMPT (PENDING is "in progress", PLAN §13). */
export const hasCeeRating = (r: CeeRating | null) => r !== null && r !== 'PENDING';

/** A status change the lifecycle allows for this kind of listing (SOLD is for sales, RENTED for rentals). */
export function statusChangeAllowed(from: ListingStatus, to: ListingStatus, transactionType: TransactionType): boolean {
  return (
    STATUS_FLOW[from].includes(to) &&
    (to !== 'SOLD' || transactionType === 'SALE') &&
    (to !== 'RENTED' || transactionType !== 'SALE')
  );
}

/** References: 8 characters without look-alikes (0/O, 1/I), unique per agency. */
const REF_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const newRef = () => Array.from({ length: 8 }, () => REF_ALPHABET[randomInt(REF_ALPHABET.length)]).join('');

/** APPROX listings show a point rounded to 0.01° (about 1 km); the exact pin stays in `property_privates`. */
function shownPoint(
  exact: { lat: number; lng: number } | null,
  precision: 'EXACT' | 'APPROX',
): { lat: string; lng: string } | { lat: null; lng: null } {
  if (!exact) return { lat: null, lng: null };
  const digits = precision === 'EXACT' ? 6 : 2;
  return { lat: exact.lat.toFixed(digits), lng: exact.lng.toFixed(digits) };
}

const num = (v: string | null) => (v === null ? null : Number(v));
const area = (v: number | null | undefined) => (v === undefined ? undefined : v === null ? null : String(v));

function commissionColumns(c: Commission) {
  return c.type === 'PCT'
    ? { commissionBp: c.basisPoints, commissionFixedCents: null, commissionIncludesVat: c.includesVat }
    : {
        commissionBp: null,
        commissionFixedCents: c.amount.amountCents,
        commissionIncludesVat: c.includesVat,
      };
}

function commissionOf(row: repo.ListingRow): Commission | null {
  if (row.commissionBp !== null) {
    return { type: 'PCT', basisPoints: row.commissionBp, includesVat: row.commissionIncludesVat };
  }
  if (row.commissionFixedCents !== null) {
    return {
      type: 'FIXED',
      amount: { amountCents: row.commissionFixedCents, currency: row.currency },
      includesVat: row.commissionIncludesVat,
    };
  }
  return null;
}

const DAY_MS = 86_400_000;
export const daysAfter = (at: Date, days: number) => new Date(at.getTime() + days * DAY_MS);

/** The columns a confirmation writes (S3-08): confirmed now, no prompt pending, back on the network. */
export function reconfirmed(): Pick<repo.ListingInsert, 'lastConfirmedAt' | 'confirmPromptedAt' | 'networkHiddenAt'> {
  return { lastConfirmedAt: clock.now(), confirmPromptedAt: null, networkHiddenAt: null };
}

function freshnessOf(row: repo.ListingRow): ListingFreshnessDto {
  return {
    lastConfirmedAt: row.lastConfirmedAt.toISOString(),
    confirmDueAt: daysAfter(row.lastConfirmedAt, LISTING_CONFIRM_PROMPT_DAYS).toISOString(),
    hideAt: daysAfter(row.lastConfirmedAt, LISTING_NETWORK_HIDE_DAYS).toISOString(),
    networkHiddenAt: row.networkHiddenAt?.toISOString() ?? null,
  };
}

/**
 * The DTO for `ctx`: the owner agency gets the private block (exact pin, cadastral reference, notes, external
 * ref, locks), other agencies the network view, and Client Mode neither private fields nor commission.
 */
export function toDto(ctx: Ctx, row: repo.ListingRow, privates: repo.PrivatesRow | null): ListingDto {
  const own = row.agencyId === ctx.tenant.agencyId;
  const showPrivate = own && !ctx.clientMode;
  // White label (PLAN §3 #56): a client never learns which agency or agent owns a network listing.
  const hideOwner = ctx.clientMode && !own;
  const lat = num(row.lat);
  const lng = num(row.lng);
  const exactLat = privates ? num(privates.exactLat) : null;
  const exactLng = privates ? num(privates.exactLng) : null;
  return {
    id: row.id,
    agencyId: hideOwner ? null : row.agencyId,
    ownerUserId: hideOwner ? null : row.ownerUserId,
    ref: hideOwner ? null : row.ref,
    source: row.source,
    status: row.status,
    visibility: row.visibility,
    shareScope: row.shareScope,
    transactionType: row.transactionType,
    price: row.priceCents === null ? null : { amountCents: row.priceCents, currency: row.currency },
    pricePeriod: row.pricePeriod,
    priceOnRequest: row.priceOnRequest,
    commission: ctx.clientMode ? null : { total: commissionOf(row), splitBp: row.splitBp },
    builtM2: num(row.builtM2),
    plotM2: num(row.plotM2),
    terraceM2: num(row.terraceM2),
    bedrooms: row.bedrooms,
    bathrooms: row.bathrooms,
    yearBuilt: row.yearBuilt,
    energyRating: row.energyRating,
    energyEmissionsRating: row.energyEmissionsRating,
    coordinates: lat === null || lng === null ? null : { lat, lng },
    locationPrecision: row.locationPrecision,
    propertyTypeId: row.propertyTypeId,
    locationId: row.locationId,
    private: showPrivate
      ? {
          cadastralRef: privates?.cadastralRef ?? null,
          internalNotes: privates?.internalNotes ?? null,
          keysInfo: privates?.keysInfo ?? null,
          coordinates: exactLat === null || exactLng === null ? null : { lat: exactLat, lng: exactLng },
          externalRef: privates?.externalRef ?? null,
          lockedFields: row.lockedFields as LockableListingField[],
        }
      : null,
    // Owner only: the score has a freshness part, which would tell other agencies the listing went unconfirmed.
    qualityScore: showPrivate ? (privates?.qualityScore ?? null) : null,
    freshness: showPrivate ? freshnessOf(row) : null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

export function actorId(ctx: Ctx): string {
  if (ctx.actor.kind !== 'user') throw new AppError('FORBIDDEN');
  return ctx.actor.userId;
}

/** Foreign keys the caller can get wrong, by constraint: the field to report. */
const FK_FIELDS: Record<string, string> = {
  properties_location_id_locations_id_fk: 'locationId',
  properties_property_type_id_property_types_id_fk: 'propertyTypeId',
  properties_owner_member_fk: 'ownerUserId',
};

/** A missing location, type or member surfaces as VALIDATION_FAILED on that field, not as a 500. */
async function withFkFields<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const cause = (err as { cause?: { code?: string; constraint?: string } }).cause;
    const field = cause?.code === '23503' && cause.constraint ? FK_FIELDS[cause.constraint] : undefined;
    if (field) throw new AppError('VALIDATION_FAILED', { field, reason: 'unknown' });
    throw err;
  }
}

function assertPricePeriod(transactionType: TransactionType, pricePeriod: string | null): void {
  if (transactionType === 'SALE' && pricePeriod !== null) {
    throw new AppError('VALIDATION_FAILED', { field: 'pricePeriod', reason: 'sale' });
  }
}

/** SHARED needs a verified agency (S1-01); PUBLIC also a CEE rating. */
export function assertVisibilityAllowed(ctx: Ctx, visibility: Visibility, energyRating: CeeRating | null): void {
  if (visibility === 'SHARED') agencies.assertVerified(ctx, 'listing.share');
  if (visibility === 'PUBLIC') {
    agencies.assertVerified(ctx, 'listing.publish');
    if (!hasCeeRating(energyRating)) throw new AppError('ENERGY_RATING_REQUIRED');
  }
}

/**
 * Naming the listing's owner is an admin's call (`listing.assign`), also when naming oneself on a colleague's
 * listing; the owner must be an active member of the agency.
 */
async function assertAssignable(ctx: Ctx, ownerUserId: string, listing?: repo.ListingRow): Promise<void> {
  assertCan(ctx, 'listing.assign', listing);
  const { role } = await identity.getMemberAccess(ctx.tx, { agencyId: ctx.tenant.agencyId, userId: ownerUserId });
  if (!role) throw new AppError('VALIDATION_FAILED', { field: 'ownerUserId', reason: 'not_a_member' });
}

/** A fixed commission is in the listing's currency (the DTO reports it in that currency). */
function assertCommissionCurrency(commission: Commission, currency: string): void {
  if (commission.type === 'FIXED' && commission.amount.currency !== currency) {
    throw new AppError('VALIDATION_FAILED', { field: 'commission', reason: 'currency' });
  }
}

/** The location's country, region and city, stored with it so the list filters a whole subtree (S3-F6). One statement. */
async function locationLevels(
  ctx: Ctx,
  locationId: string,
): Promise<{ countryId: string | null; regionId: string | null; cityId: string | null }> {
  const line = await taxonomy.locationLineage(ctx.tx, locationId);
  return {
    countryId: line?.byDepth.get(1) ?? null,
    regionId: line?.byDepth.get(2) ?? null,
    cityId: line?.byDepth.get(3) ?? null,
  };
}

/**
 * `POST /v1/listings` and imports (`source`/`externalRef`): a DRAFT, PRIVATE listing owned by the caller (or,
 * for an admin, by the member named). Commission and split default to the agency's settings (5 % / 50 %).
 */
export async function createListing(
  ctx: Ctx,
  input: CreateListingBody,
  origin: { source?: string; externalRef?: string | null; legacyId?: string | null } = {},
): Promise<ListingDto> {
  assertCan(ctx, 'listing.create');
  const userId = actorId(ctx);
  const ownerUserId = input.ownerUserId ?? userId;
  if (input.ownerUserId !== undefined) await assertAssignable(ctx, ownerUserId);
  assertPricePeriod(input.transactionType, input.pricePeriod ?? null);

  let commission = input.commission;
  let splitBp = input.splitBp;
  if (commission === undefined || splitBp === undefined) {
    const defaults = await agencies.getAgencyDefaultCommission(ctx);
    commission ??= defaults.commission;
    splitBp ??= defaults.splitBp;
  }
  assertCommissionCurrency(commission, input.currency ?? 'EUR');
  const precision = input.locationPrecision ?? 'APPROX';
  const exact = input.coordinates ?? null;
  const agencyId = ctx.tenant.agencyId;
  const id = newId();
  const levels = await locationLevels(ctx, input.locationId);

  const row = await withFkFields(() =>
    repo.insertListing(ctx.tx, {
      id,
      agencyId,
      ...levels,
      ownerUserId,
      ref: newRef(),
      source: origin.source ?? 'MANUAL',
      legacyId: origin.legacyId ?? null,
      transactionType: input.transactionType,
      priceCents: input.priceCents ?? null,
      currency: input.currency ?? 'EUR',
      pricePeriod: input.pricePeriod ?? null,
      priceOnRequest: input.priceOnRequest ?? false,
      ...commissionColumns(commission),
      splitBp,
      builtM2: area(input.builtM2) ?? null,
      plotM2: area(input.plotM2) ?? null,
      terraceM2: area(input.terraceM2) ?? null,
      bedrooms: input.bedrooms ?? null,
      bathrooms: input.bathrooms ?? null,
      yearBuilt: input.yearBuilt ?? null,
      energyRating: input.energyRating ?? null,
      energyEmissionsRating: input.energyEmissionsRating ?? null,
      ...shownPoint(exact, precision),
      locationPrecision: precision,
      propertyTypeId: input.propertyTypeId,
      locationId: input.locationId,
      lockedFields: input.lockedFields ?? [],
    }),
  );
  const privates = await repo.insertPrivates(ctx.tx, {
    propertyId: id,
    agencyId,
    cadastralRef: input.cadastralRef ?? null,
    internalNotes: input.internalNotes ?? null,
    keysInfo: input.keysInfo ?? null,
    // the feed's id for the listing, with that feed: owner only (S4-F1)
    externalSource: origin.externalRef ? (origin.source ?? 'MANUAL') : null,
    externalRef: origin.externalRef ?? null,
    exactLat: exact ? String(exact.lat) : null,
    exactLng: exact ? String(exact.lng) : null,
  });
  await repo.insertStatusHistory(ctx.tx, {
    id: newId(),
    propertyId: id,
    agencyId,
    fromStatus: null,
    toStatus: row.status,
    changedByUserId: userId,
  });
  if (row.priceCents !== null) {
    await repo.insertPriceHistory(ctx.tx, {
      id: newId(),
      propertyId: id,
      agencyId,
      previousPriceCents: null,
      priceCents: row.priceCents,
      currency: row.currency,
      changedByUserId: userId,
    });
  }
  await emit(ctx.tx, propertiesEvents.created({ listingId: id, agencyId, version: row.version }));
  return toDto(ctx, row, privates);
}

/**
 * The caller's own listing for a change. Another agency's listing the caller can see (shared) is FORBIDDEN —
 * only the owner agency writes — and anything else, deleted ones included, is LISTING_NOT_FOUND.
 */
export async function ownForChange(ctx: Ctx, id: string, action: PropertiesAction): Promise<repo.ListingRow> {
  // The role check first (Client Mode, partners, impersonation): a refused caller locks nothing, learns nothing.
  assertCan(ctx, action);
  const row = await repo.getOwnForUpdate(ctx.tx, ctx.tenant.agencyId, id);
  if (row) return row;
  if (await repo.getListing(ctx.tx, id)) throw new AppError('FORBIDDEN');
  throw new AppError('LISTING_NOT_FOUND');
}

/** `GET /v1/listings/:id`: the owner view for the agency's own listing, the network view for a shared one. */
export async function getListing(ctx: Ctx, id: string): Promise<ListingDto> {
  assertCan(ctx, 'listing.read');
  const row = await repo.getListing(ctx.tx, id);
  const own = row?.agencyId === ctx.tenant.agencyId;
  if (!row || (row.deletedAt && !own)) throw new AppError('LISTING_NOT_FOUND');
  return toDto(ctx, row, own ? await repo.getPrivates(ctx.tx, id) : null);
}

/**
 * For the media module (S3-03): the caller's own, not deleted listing, row-locked so concurrent media changes
 * of one listing (positions, cover) run one after another. Same refusals as an edit (`listing.update`).
 */
export async function lockListingForMedia(ctx: Ctx, id: string): Promise<{ id: string; agencyId: string }> {
  const row = await ownForChange(ctx, id, 'listing.update');
  if (row.deletedAt) throw new AppError('LISTING_NOT_FOUND');
  assertCan(ctx, 'listing.update', row); // agents change only their own listings' media; admins any
  return { id: row.id, agencyId: row.agencyId };
}

/** For the media module (S3-03): refuses a listing the caller cannot read, like `getListing`; its owner agency. */
export async function assertListingReadable(ctx: Ctx, id: string): Promise<{ agencyId: string }> {
  assertCan(ctx, 'listing.read');
  const row = await repo.getListing(ctx.tx, id);
  if (!row || (row.deletedAt && row.agencyId !== ctx.tenant.agencyId)) throw new AppError('LISTING_NOT_FOUND');
  return { agencyId: row.agencyId };
}

/**
 * The contract's filters as the repo takes them (`mine` → the caller; `q` → an upper-case reference prefix; a
 * location → its depth, so its whole subtree matches — one statement, S3-F6; an unknown one matches nothing).
 */
export async function listFilterOf(ctx: Ctx, f: ListingFilter): Promise<repo.ListFilter> {
  const q = f.q?.toUpperCase();
  const line = f.locationId ? await taxonomy.locationLineage(ctx.tx, f.locationId) : null;
  const location = f.locationId
    ? { id: f.locationId, depth: (line && line.depth >= 1 && line.depth <= 4 ? line.depth : 4) as 1 | 2 | 3 | 4 }
    : undefined;
  return {
    ...(location ? { location } : {}),
    ...(f.status ? { status: f.status } : {}),
    ...(f.visibility ? { visibility: f.visibility } : {}),
    ...(f.transactionType ? { transactionType: f.transactionType } : {}),
    ...(f.propertyTypeId ? { propertyTypeId: f.propertyTypeId } : {}),
    ...(f.mine ? { ownerUserId: actorId(ctx) } : f.ownerUserId ? { ownerUserId: f.ownerUserId } : {}),
    ...(f.priceMin !== undefined ? { priceMin: f.priceMin } : {}),
    ...(f.priceMax !== undefined ? { priceMax: f.priceMax } : {}),
    ...(f.bedroomsMin !== undefined ? { bedroomsMin: f.bedroomsMin } : {}),
    ...(f.tag ? { tag: f.tag } : {}),
    ...(q ? { refPrefix: q } : {}),
  };
}

const PRICE_CURSOR = 'p';

/** A page's cursor for `sort`: the time cursor of `pagination.ts`, or `["p", price | null, id]` for price sorts. */
function decodeListCursor(sort: ListingSort, cursor: string | undefined): repo.ListCursor | undefined {
  if (cursor === undefined) return undefined;
  if (sort !== 'price_asc' && sort !== 'price_desc') {
    const c = decodeCursor(cursor);
    return c && { kind: 'time', at: c.at, id: c.id };
  }
  try {
    const [tag, price, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown[];
    const priceOk = price === null || (typeof price === 'number' && Number.isSafeInteger(price) && price >= 0);
    if (tag === PRICE_CURSOR && priceOk && typeof id === 'string' && z.uuid().safeParse(id).success) {
      return { kind: 'price', price: price as number | null, id };
    }
  } catch {
    // falls through to the error below
  }
  throw new AppError('VALIDATION_FAILED', { field: 'cursor' });
}

function encodeListCursor(sort: ListingSort, row: repo.ListingSummaryRow): string {
  if (sort === 'price_asc' || sort === 'price_desc') {
    return Buffer.from(JSON.stringify([PRICE_CURSOR, row.priceCents, row.id])).toString('base64url');
  }
  return encodeCursor({ at: sort === 'updated' ? row.updatedAt : row.createdAt, id: row.id });
}

/**
 * `GET /v1/listings`: the agency's own listings, filtered and sorted (S3-07), keyset ≤ 100, with their tags.
 * Two statements after the member context: the page and its tags.
 */
export async function listListings(
  ctx: Ctx,
  q: Omit<ListListingsQuery, 'sort'> & { sort?: ListingSort },
): Promise<ListingPage> {
  assertCan(ctx, 'listing.read');
  const sort: ListingSort = q.deleted ? 'newest' : (q.sort ?? 'newest');
  const cursor = decodeListCursor(sort, q.cursor);
  const rows = await repo.listOwn(ctx.tx, ctx.tenant.agencyId, {
    limit: q.limit,
    sort,
    filter: await listFilterOf(ctx, q),
    ...(cursor ? { cursor } : {}),
    ...(q.deleted ? { deletedSince: new Date(clock.now().getTime() - LISTING_RESTORE_DAYS * 86_400_000) } : {}),
  });
  const items = rows.slice(0, q.limit);
  const tags = ctx.clientMode
    ? new Map<string, string[]>()
    : await repo.tagsOf(
        ctx.tx,
        items.map((r) => r.id),
      );
  const last = items.at(-1);
  return {
    items: items.map((r) => ({
      id: r.id,
      ref: r.ref,
      ownerUserId: r.ownerUserId,
      status: r.status,
      visibility: r.visibility,
      shareScope: r.shareScope,
      transactionType: r.transactionType,
      price: r.priceCents === null ? null : { amountCents: r.priceCents, currency: r.currency },
      bedrooms: r.bedrooms,
      bathrooms: r.bathrooms,
      builtM2: num(r.builtM2),
      propertyTypeId: r.propertyTypeId,
      locationId: r.locationId,
      // Tags are the agency's internal labels: never shown to a client (Client Mode).
      tags: ctx.clientMode ? [] : (tags.get(r.id) ?? []),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      deletedAt: r.deletedAt?.toISOString() ?? null,
    })),
    nextCursor: rows.length > q.limit && last ? encodeListCursor(sort, last) : null,
  };
}

/**
 * Equal for change detection. `numeric` columns come back as padded strings (`"120.00"`, `"36.500000"`):
 * compared as numbers, so resending an unchanged area or position changes nothing.
 */
function same(before: unknown, after: unknown): boolean {
  if (typeof before === 'string' && typeof after === 'string' && NUMERIC.test(before) && NUMERIC.test(after)) {
    return Number(before) === Number(after);
  }
  return JSON.stringify(before) === JSON.stringify(after);
}
const NUMERIC = /^-?\d+(\.\d+)?$/;

/** Listing columns a body field changes, and the DTO field it is reported as. */
function listingPatch(input: UpdateListingBody, current: repo.ListingRow, exact: { lat: number; lng: number } | null) {
  const patch: Partial<repo.ListingInsert> = {};
  const changed = new Set<string>();
  const set = <K extends keyof repo.ListingInsert>(key: K, value: repo.ListingInsert[K] | undefined, field: string) => {
    if (value === undefined) return;
    if (same(current[key as keyof repo.ListingRow], value)) return;
    patch[key] = value;
    changed.add(field);
  };
  set('status', input.status, 'status');
  set('visibility', input.visibility, 'visibility');
  set('shareScope', input.shareScope, 'shareScope');
  set('transactionType', input.transactionType, 'transactionType');
  set('propertyTypeId', input.propertyTypeId, 'propertyType');
  set('locationId', input.locationId, 'location');
  set('priceCents', input.priceCents, 'price');
  set('currency', input.currency, 'price');
  set('pricePeriod', input.pricePeriod, 'price');
  set('priceOnRequest', input.priceOnRequest, 'price');
  if (input.commission !== undefined) {
    const cols = commissionColumns(input.commission);
    set('commissionBp', cols.commissionBp, 'commission');
    set('commissionFixedCents', cols.commissionFixedCents, 'commission');
    set('commissionIncludesVat', cols.commissionIncludesVat, 'commission');
  }
  set('splitBp', input.splitBp, 'split');
  set('builtM2', area(input.builtM2), 'specs');
  set('plotM2', area(input.plotM2), 'specs');
  set('terraceM2', area(input.terraceM2), 'specs');
  set('bedrooms', input.bedrooms, 'specs');
  set('bathrooms', input.bathrooms, 'specs');
  set('yearBuilt', input.yearBuilt, 'specs');
  set('energyRating', input.energyRating, 'energyRating');
  set('energyEmissionsRating', input.energyEmissionsRating, 'energyRating');
  set('locationPrecision', input.locationPrecision, 'coordinates');
  if (input.coordinates !== undefined || input.locationPrecision !== undefined) {
    const shown = shownPoint(exact, input.locationPrecision ?? current.locationPrecision);
    set('lat', shown.lat, 'coordinates');
    set('lng', shown.lng, 'coordinates');
  }
  set('ownerUserId', input.ownerUserId, 'owner');
  set('lockedFields', input.lockedFields, 'lockedFields');
  return { patch, changed };
}

/**
 * `PATCH /v1/listings/:id`: optimistic on `version` (stale → VERSION_CONFLICT). Status follows the lifecycle;
 * visibility and share scope need the right to publish and a verified agency; PUBLIC needs a CEE rating, now
 * and after any later change. A save that changes nothing writes and emits nothing.
 */
export async function updateListing(ctx: Ctx, id: string, input: UpdateListingBody): Promise<ListingDto> {
  const current = await ownForChange(ctx, id, 'listing.update');
  if (current.deletedAt) throw new AppError('LISTING_NOT_FOUND');
  assertCan(ctx, 'listing.update', current);
  if (input.version !== current.version) throw new AppError('VERSION_CONFLICT');
  const userId = actorId(ctx);

  const privates = await repo.getPrivates(ctx.tx, id);
  const currentExact =
    privates?.exactLat != null && privates.exactLng != null
      ? { lat: Number(privates.exactLat), lng: Number(privates.exactLng) }
      : null;
  const exact = input.coordinates === undefined ? currentExact : input.coordinates;
  const { patch, changed } = listingPatch(input, current, exact);
  // Going ACTIVE again (S3-08) confirms the listing is on the market.
  if (patch.status === 'ACTIVE') {
    Object.assign(patch, reconfirmed());
    changed.add('freshness');
  }
  const next = { ...current, ...patch } as repo.ListingRow;

  if (patch.ownerUserId !== undefined) await assertAssignable(ctx, patch.ownerUserId, current);
  // Staff acting as a member fix data; the deal (commission, split) and the status stay the agency's call.
  if (impersonatorOf(ctx) && ['commission', 'split', 'status'].some((f) => changed.has(f))) {
    throw new AppError('FORBIDDEN', { reason: 'impersonation' });
  }
  if (input.commission !== undefined) assertCommissionCurrency(input.commission, next.currency);
  if (patch.visibility !== undefined || patch.shareScope !== undefined) assertCan(ctx, 'listing.publish', current);
  if (patch.status !== undefined || patch.transactionType !== undefined) {
    const allowed = patch.status === undefined || STATUS_FLOW[current.status].includes(next.status);
    const kindOk =
      (next.status !== 'SOLD' || next.transactionType === 'SALE') &&
      (next.status !== 'RENTED' || next.transactionType !== 'SALE');
    if (!allowed || !kindOk) {
      throw new AppError('LISTING_STATUS_INVALID', { from: current.status, to: next.status });
    }
  }
  assertPricePeriod(next.transactionType, next.pricePeriod);
  // Checked on every change, not only when visibility moves: a PUBLIC listing cannot drop its rating.
  if (patch.visibility !== undefined || next.visibility !== 'PRIVATE') {
    if (patch.visibility !== undefined) assertVisibilityAllowed(ctx, next.visibility, next.energyRating);
    else if (next.visibility === 'PUBLIC' && !hasCeeRating(next.energyRating)) {
      throw new AppError('ENERGY_RATING_REQUIRED');
    }
  }

  const privatesPatch: repo.PrivatesPatch = {};
  const setPrivate = <K extends keyof repo.PrivatesPatch>(key: K, value: repo.PrivatesPatch[K] | undefined) => {
    if (value === undefined || (privates && same(privates[key as keyof repo.PrivatesRow], value))) return;
    privatesPatch[key] = value;
    changed.add('private');
  };
  setPrivate('cadastralRef', input.cadastralRef);
  setPrivate('internalNotes', input.internalNotes);
  setPrivate('keysInfo', input.keysInfo);
  if (input.coordinates !== undefined) {
    setPrivate('exactLat', input.coordinates ? String(input.coordinates.lat) : null);
    setPrivate('exactLng', input.coordinates ? String(input.coordinates.lng) : null);
  }

  if (changed.size === 0) return toDto(ctx, current, privates);
  if (patch.locationId !== undefined) Object.assign(patch, await locationLevels(ctx, patch.locationId));
  const updated = await withFkFields(() => repo.updateWithVersion(ctx.tx, id, input.version, patch));
  if (!updated) throw new AppError('VERSION_CONFLICT');
  const savedPrivates =
    Object.keys(privatesPatch).length > 0 ? await repo.updatePrivates(ctx.tx, id, privatesPatch) : privates;

  const agencyId = updated.agencyId;
  const base = { listingId: id, agencyId, version: updated.version };
  const events: OutboxMessage[] = [];
  if (updated.priceCents !== current.priceCents || updated.currency !== current.currency) {
    await repo.insertPriceHistory(ctx.tx, {
      id: newId(),
      propertyId: id,
      agencyId,
      previousPriceCents: current.priceCents,
      priceCents: updated.priceCents,
      currency: updated.currency,
      changedByUserId: userId,
    });
  }
  if (updated.status !== current.status) {
    await repo.insertStatusHistory(ctx.tx, {
      id: newId(),
      propertyId: id,
      agencyId,
      fromStatus: current.status,
      toStatus: updated.status,
      changedByUserId: userId,
    });
    events.push(propertiesEvents.statusChanged({ ...base, from: current.status, to: updated.status }));
  }
  const backOnNetwork = current.networkHiddenAt !== null && updated.networkHiddenAt === null;
  if (updated.visibility !== current.visibility || updated.shareScope !== current.shareScope || backOnNetwork) {
    events.push(
      propertiesEvents.visibilityChanged({ ...base, visibility: updated.visibility, shareScope: updated.shareScope }),
    );
  }
  events.push(propertiesEvents.updated({ ...base, changed: [...changed].sort() }));
  await emit(ctx.tx, events); // one statement for all of them
  return toDto(ctx, updated, savedPrivates);
}

/** `DELETE /v1/listings/:id`: soft delete, restorable for 30 days; it leaves the network and websites at once. */
export async function deleteListing(ctx: Ctx, id: string): Promise<void> {
  const current = await ownForChange(ctx, id, 'listing.delete');
  if (current.deletedAt) throw new AppError('LISTING_NOT_FOUND');
  assertCan(ctx, 'listing.delete', current);
  const updated = await repo.updateWithVersion(ctx.tx, id, current.version, { deletedAt: clock.now() });
  if (!updated) throw new AppError('VERSION_CONFLICT');
  await emit(ctx.tx, propertiesEvents.deleted({ listingId: id, agencyId: updated.agencyId, version: updated.version }));
}

/** `POST /v1/listings/:id/restore`: within 30 days of the delete, as it was (status, visibility). */
export async function restoreListing(ctx: Ctx, id: string): Promise<ListingDto> {
  const current = await ownForChange(ctx, id, 'listing.restore');
  assertCan(ctx, 'listing.restore', current);
  const limit = LISTING_RESTORE_DAYS * 24 * 3_600_000;
  if (!current.deletedAt || clock.now().getTime() - current.deletedAt.getTime() > limit) {
    throw new AppError('LISTING_RESTORE_UNAVAILABLE');
  }
  // Back as it was: a shared or public listing passes the gate again (the agency may have lost verification).
  if (current.visibility !== 'PRIVATE') assertVisibilityAllowed(ctx, current.visibility, current.energyRating);
  const updated = await repo.updateWithVersion(ctx.tx, id, current.version, { deletedAt: null });
  if (!updated) throw new AppError('VERSION_CONFLICT');
  await emit(
    ctx.tx,
    propertiesEvents.restored({ listingId: id, agencyId: updated.agencyId, version: updated.version }),
  );
  return toDto(ctx, updated, await repo.getPrivates(ctx.tx, id));
}
