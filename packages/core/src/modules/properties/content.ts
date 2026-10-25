/**
 * Listing content use cases (S3-05, PATTERNS §7): the text per content locale and the features, as the listing
 * editor writes them. Same rules as a listing edit (`listing.update`, own listings for agents); every change bumps
 * the listing `version` (optimistic, one counter for the whole editor) and emits `properties.listing.updated` with
 * `changed: ['translations']` or `['features']` in the same transaction.
 */
import type {
  ListingContentDto,
  ListingTranslationDto,
  PutListingTranslationBody,
  SetListingFeaturesBody,
  TranslationOrigin,
} from '@inmolink/contracts';
import { CONTENT_LOCALES } from '@inmolink/i18n';
import { AppError } from '@inmolink/platform/errors';
import { emit } from '@inmolink/platform/outbox';
import type { Ctx } from '../../context';
import { compileOwner, NO_OWNER, ownerRefsOf, whiteLabelText } from '../../white-label';
import { readAiRemovals } from '../../white-label-store';
import * as agencies from '../agencies';
import { propertiesEvents } from './events';
import { assertCan } from './policy';
import * as repo from './repo';
import { ownForChange } from './service';

/** Lowercase, accent-free, dashes, ≤ 120 characters: the slug a title gives (`property_translations_slug_ck`). */
export function slugOf(title: string): string {
  const slug = title
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
    .replace(/-+$/, '');
  return slug || 'listing';
}

function assertContentLocale(locale: string): void {
  if (!(CONTENT_LOCALES as readonly string[]).includes(locale)) {
    throw new AppError('VALIDATION_FAILED', { field: 'locale', reason: 'unsupported' });
  }
}

const toTranslationDto = (row: repo.TranslationView): ListingTranslationDto => ({
  ...row,
  updatedAt: row.updatedAt.toISOString(),
});

/** The caller's own, live listing for a content change, version-checked. */
async function ownLiveForChange(ctx: Ctx, id: string, version: number): Promise<repo.ListingRow> {
  const current = await ownForChange(ctx, id, 'listing.update');
  if (current.deletedAt) throw new AppError('LISTING_NOT_FOUND');
  assertCan(ctx, 'listing.update', current);
  if (version !== current.version) throw new AppError('VERSION_CONFLICT');
  return current;
}

async function bumpAndEmit(ctx: Ctx, current: repo.ListingRow, changed: string): Promise<number> {
  const version = await repo.bumpVersion(ctx.tx, current.id, current.version);
  if (version === null) throw new AppError('VERSION_CONFLICT');
  await emit(
    ctx.tx,
    propertiesEvents.updated({ listingId: current.id, agencyId: current.agencyId, version, changed: [changed] }),
  );
  return version;
}

/**
 * `GET /v1/listings/:id/content`: the listing's translations and feature ids. The owner agency sees its own
 * (deleted ones too, for restore); other agencies those of a shared listing, through RLS (S3-01).
 */
export async function getListingContent(ctx: Ctx, id: string): Promise<ListingContentDto> {
  assertCan(ctx, 'listing.read');
  const row = await repo.getListing(ctx.tx, id);
  if (!row || (row.deletedAt && row.agencyId !== ctx.tenant.agencyId)) throw new AppError('LISTING_NOT_FOUND');
  // one after the other: a transaction is one connection (pg queues parallel queries, and pg 9 refuses them)
  const translations = await repo.listTranslations(ctx.tx, id);
  const featureIds = await repo.listFeatureIds(ctx.tx, id);
  // S12-06 review: a client at the screen never reads the owner's own text of a network listing — the white-label pass
  // (deterministic: the owner's names, contacts, website and reference, any e-mail, URL or phone number) first.
  const shown =
    ctx.clientMode && row.agencyId !== ctx.tenant.agencyId ? await whiteLabelled(ctx, row, translations) : translations;
  return { listingId: id, version: row.version, translations: shown.map(toTranslationDto), featureIds };
}

/** S12-06 review: a network listing's texts as a client may see them (Client Mode). */
async function whiteLabelled(
  ctx: Ctx,
  row: repo.ListingRow,
  translations: repo.TranslationView[],
): Promise<repo.TranslationView[]> {
  const owner = (await agencies.ownerIdentities(ctx.tx, [row.agencyId])).get(row.agencyId) ?? NO_OWNER;
  const matcher = compileOwner(owner);
  const refs = ownerRefsOf({ ref: row.ref });
  // S12-03: then the model pass's cached removals of these texts (deterministic-only without them).
  const removals = (await readAiRemovals([{ agencyId: row.agencyId, targetId: row.id }])).get(row.id);
  const clean = (text: string | null) => (text === null ? null : whiteLabelText(text, matcher, refs, removals));
  return translations.map((t) => ({
    ...t,
    title: clean(t.title) ?? '',
    description: clean(t.description),
    metaTitle: clean(t.metaTitle),
    metaDescription: clean(t.metaDescription),
  }));
}

/**
 * `PUT /v1/listings/:id/translations/:locale`: a person's text. A new one is HUMAN; editing an AI draft makes it
 * REVIEWED; `locked` (default: kept) stops machine translation from overwriting it. Unchanged text writes nothing.
 */
export async function saveListingTranslation(
  ctx: Ctx,
  id: string,
  locale: string,
  input: PutListingTranslationBody,
): Promise<ListingContentDto> {
  assertContentLocale(locale);
  const current = await ownLiveForChange(ctx, id, input.version);
  const existing = (await repo.listTranslations(ctx.tx, id)).find((t) => t.locale === locale) ?? null;
  const origin: TranslationOrigin = !existing ? 'HUMAN' : existing.origin === 'AI_DRAFT' ? 'REVIEWED' : existing.origin;
  const next = {
    title: input.title,
    description: input.description === undefined ? (existing?.description ?? null) : input.description || null,
    slug: input.slug ?? slugOf(input.title),
    metaTitle: input.metaTitle === undefined ? (existing?.metaTitle ?? null) : input.metaTitle || null,
    metaDescription:
      input.metaDescription === undefined ? (existing?.metaDescription ?? null) : input.metaDescription || null,
    origin,
    locked: input.locked ?? existing?.locked ?? false,
  };
  const unchanged =
    existing !== null && (Object.keys(next) as (keyof typeof next)[]).every((k) => existing[k] === next[k]);
  if (!unchanged) {
    await repo.upsertTranslation(ctx.tx, { propertyId: id, agencyId: current.agencyId, locale, ...next });
    current.version = await bumpAndEmit(ctx, current, 'translations');
  }
  return contentAfterChange(ctx, current);
}

/** `DELETE /v1/listings/:id/translations/:locale`: drops one locale's text; a missing one is a no-op. */
export async function deleteListingTranslation(
  ctx: Ctx,
  id: string,
  locale: string,
  version: number,
): Promise<ListingContentDto> {
  assertContentLocale(locale);
  const current = await ownLiveForChange(ctx, id, version);
  if (await repo.deleteTranslation(ctx.tx, id, locale)) {
    current.version = await bumpAndEmit(ctx, current, 'translations');
  }
  return contentAfterChange(ctx, current);
}

/** `PUT /v1/listings/:id/features`: the whole feature set. An unknown feature is VALIDATION_FAILED on `featureIds`. */
export async function setListingFeatures(
  ctx: Ctx,
  id: string,
  input: SetListingFeaturesBody,
): Promise<ListingContentDto> {
  const current = await ownLiveForChange(ctx, id, input.version);
  const before = await repo.listFeatureIds(ctx.tx, id);
  const wanted = [...input.featureIds].sort();
  if (wanted.length !== before.length || wanted.some((f, i) => f !== before[i])) {
    try {
      await repo.replaceFeatures(ctx.tx, { propertyId: id, agencyId: current.agencyId }, wanted);
    } catch (err) {
      const cause = (err as { cause?: { code?: string; constraint?: string } }).cause;
      if (cause?.code === '23503' && cause.constraint === 'property_features_feature_id_features_id_fk') {
        throw new AppError('VALIDATION_FAILED', { field: 'featureIds', reason: 'unknown' });
      }
      throw err;
    }
    current.version = await bumpAndEmit(ctx, current, 'features');
  }
  return contentAfterChange(ctx, current);
}

async function contentAfterChange(ctx: Ctx, listing: repo.ListingRow): Promise<ListingContentDto> {
  // one after the other: a transaction is one connection (pg queues parallel queries, and pg 9 refuses them)
  const translations = await repo.listTranslations(ctx.tx, listing.id);
  const featureIds = await repo.listFeatureIds(ctx.tx, listing.id);
  return {
    listingId: listing.id,
    version: listing.version,
    translations: translations.map(toTranslationDto),
    featureIds,
  };
}
