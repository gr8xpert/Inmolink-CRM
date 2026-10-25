/**
 * The properties side of the AI Listing Studio (S12-02, PLAN §8 #1, §3 #15). The studio (`ai-features`) reads the
 * facts of the caller's listings and hands back drafts; this module owns the rows, the rules and the events:
 *
 * - `assertStudioEditable` / `studioEditableIds` (request path): which of these listings the caller may edit (`listing.update`, own listings
 *   for agents) — one statement, no facts.
 * - `studioListings` (worker, as the member who asked): the facts, feature ids and translations (origin, lock) of
 *   those listings — no price, commission, owner contacts, address or private field ever leaves here.
 * - `saveListingAiDrafts` (worker, as the member): writes the drafts as `AI_DRAFT` (slug kept when the locale has
 *   one) and skips locked locales — and, without `replaceReviewed`, texts a person wrote or reviewed — in the
 *   statement itself; bumps the listing `version` and emits `properties.listing.updated` (`changed:
 *   ['translations']`) in the same transaction when anything was written. A person's later save of the draft makes
 *   it REVIEWED (`saveListingTranslation`).
 */
import { CONTENT_LOCALES } from '@inmolink/i18n';
import { AppError } from '@inmolink/platform/errors';
import { emit } from '@inmolink/platform/outbox';
import type { Ctx } from '../../context';
import { slugOf } from './content';
import { propertiesEvents } from './events';
import { assertCan, can } from './policy';
import * as repo from './repo';
import { ownForChange } from './service';

export interface StudioTranslation {
  locale: string;
  title: string;
  description: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  origin: 'HUMAN' | 'AI_DRAFT' | 'REVIEWED';
  locked: boolean;
}

export interface StudioListing {
  id: string;
  agencyId: string;
  version: number;
  transactionType: 'SALE' | 'RENT_LONG_TERM' | 'RENT_SHORT_TERM';
  propertyTypeId: string;
  locationId: string;
  bedrooms: number | null;
  bathrooms: number | null;
  builtM2: number | null;
  plotM2: number | null;
  terraceM2: number | null;
  yearBuilt: number | null;
  energyRating: string | null;
  featureIds: string[];
  translations: StudioTranslation[];
}

export interface StudioDraft {
  locale: string;
  title: string;
  description: string;
  metaTitle: string;
  metaDescription: string;
}

const num = (v: string | null) => (v === null ? null : Number(v));

async function editableRows(ctx: Ctx, ids: readonly string[]): Promise<repo.StudioRow[]> {
  assertCan(ctx, 'listing.update');
  const rows = await repo.studioRows(ctx.tx, ctx.tenant.agencyId, [...new Set(ids)]);
  return rows.filter((r) => can(ctx, 'listing.update', r));
}

/**
 * The caller may edit this listing (request path, one listing): same refusals as an edit — `LISTING_NOT_FOUND`, or
 * `FORBIDDEN` for a listing of another agency or, for an agent, a colleague's.
 */
export async function assertStudioEditable(ctx: Ctx, id: string): Promise<void> {
  const row = await ownForChange(ctx, id, 'listing.update');
  if (row.deletedAt) throw new AppError('LISTING_NOT_FOUND');
  assertCan(ctx, 'listing.update', row);
}

/** The ids among `ids` the caller may edit (live listings of their agency; agents: their own). */
export async function studioEditableIds(ctx: Ctx, ids: readonly string[]): Promise<string[]> {
  return (await editableRows(ctx, ids)).map((r) => r.id);
}

/** The facts and texts of the editable listings among `ids` (three statements for any number). */
export async function studioListings(ctx: Ctx, ids: readonly string[]): Promise<StudioListing[]> {
  const rows = await editableRows(ctx, ids);
  if (rows.length === 0) return [];
  const live = rows.map((r) => r.id);
  // one after the other: a transaction is one connection
  const translations = await repo.studioTranslations(ctx.tx, live);
  const features = await repo.readModelFeatures(ctx.tx, live);
  const textsOf = new Map<string, StudioTranslation[]>();
  for (const t of translations) {
    const list = textsOf.get(t.propertyId) ?? [];
    list.push({
      locale: t.locale,
      title: t.title,
      description: t.description,
      metaTitle: t.metaTitle,
      metaDescription: t.metaDescription,
      origin: t.origin,
      locked: t.locked,
    });
    textsOf.set(t.propertyId, list);
  }
  const featuresOf = new Map<string, string[]>();
  for (const f of features) featuresOf.set(f.propertyId, [...(featuresOf.get(f.propertyId) ?? []), f.featureId]);
  return rows.map((r) => ({
    id: r.id,
    agencyId: r.agencyId,
    version: r.version,
    transactionType: r.transactionType,
    propertyTypeId: r.propertyTypeId,
    locationId: r.locationId,
    bedrooms: r.bedrooms,
    bathrooms: r.bathrooms,
    builtM2: num(r.builtM2),
    plotM2: num(r.plotM2),
    terraceM2: num(r.terraceM2),
    yearBuilt: r.yearBuilt,
    energyRating: r.energyRating,
    featureIds: (featuresOf.get(r.id) ?? []).sort(),
    translations: textsOf.get(r.id) ?? [],
  }));
}

/**
 * Writes the drafts of one listing at `version` (stale → `VERSION_CONFLICT`: the studio re-reads the facts). Returns
 * the locales written; the others were locked, or a person's text without `replaceReviewed`, or not enabled.
 */
export async function saveListingAiDrafts(
  ctx: Ctx,
  listingId: string,
  input: { version: number; drafts: readonly StudioDraft[]; replaceReviewed: boolean },
): Promise<{ written: string[]; version: number }> {
  const [row] = await editableRows(ctx, [listingId]);
  if (!row) throw new AppError('LISTING_NOT_FOUND');
  if (row.version !== input.version) throw new AppError('VERSION_CONFLICT');
  const existing = new Map((await repo.studioTranslations(ctx.tx, [listingId])).map((t) => [t.locale, t]));
  const written: string[] = [];
  for (const d of input.drafts) {
    if (!(CONTENT_LOCALES as readonly string[]).includes(d.locale) || !ctx.tenant.locales.includes(d.locale)) continue;
    const before = existing.get(d.locale);
    const ok = await repo.upsertAiDraft(
      ctx.tx,
      {
        propertyId: listingId,
        agencyId: row.agencyId,
        locale: d.locale,
        title: d.title,
        description: d.description,
        slug: before?.slug ?? slugOf(d.title),
        metaTitle: d.metaTitle,
        metaDescription: d.metaDescription,
      },
      input.replaceReviewed,
    );
    if (ok) written.push(d.locale);
  }
  if (written.length === 0) return { written, version: row.version };
  const version = await repo.bumpVersion(ctx.tx, listingId, row.version);
  if (version === null) throw new AppError('VERSION_CONFLICT');
  await emit(
    ctx.tx,
    propertiesEvents.updated({ listingId, agencyId: row.agencyId, version, changed: ['translations'] }),
  );
  return { written, version };
}
