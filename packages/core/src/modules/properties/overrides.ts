/**
 * Listing overrides (S3-10, PLAN §3 #54): an agency rewrites the title and/or description of a listing it may
 * present but does not own — a network listing, a new-build development or unit — per content locale. The text
 * is the agency's own (STRICT rows): it is used only in that agency's channels — its website serializer (S7-02)
 * and selections (S12-04) call `applyListingOverrides` with their own `ctx` — and the owner and every other
 * agency keep seeing the owner's text. A null field, or a removed override, falls back to the owner's text.
 */
import type {
  ListingOverrideDto,
  ListingOverrideList,
  ListingOverrideTarget,
  PutListingOverrideBody,
  TranslationOrigin,
} from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import { CONTENT_LOCALES } from '@inmolink/i18n';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import type { SQL } from 'drizzle-orm';
import type { Ctx } from '../../context';
import * as developments from '../developments';
import { propertiesEvents } from './events';
import { assertCan } from './policy';
import * as repo from './repo';

/** Owner text or the caller's override of it, field by field. */
export type ListingText = { title: string | null; description: string | null };

function assertContentLocale(locale: string): void {
  if (!(CONTENT_LOCALES as readonly string[]).includes(locale)) {
    throw new AppError('VALIDATION_FAILED', { field: 'locale', reason: 'unsupported' });
  }
}

/** The agency's own text: never in Client Mode, which only reads what the buyer sees. */
function presenter(ctx: Ctx): string {
  assertCan(ctx, 'listing.override');
  return ctx.tenant.agencyId;
}

const toDto = (row: repo.OverrideView): ListingOverrideDto => ({ ...row, updatedAt: row.updatedAt.toISOString() });

/**
 * A target the caller may present: visible to it (RLS: shared listings, developments shared with it) and owned
 * by another agency. Its own listings and developments are edited, not overridden.
 */
async function assertPresentable(ctx: Ctx, kind: ListingOverrideTarget, id: string): Promise<void> {
  let owner: string;
  if (kind === 'LISTING') {
    const row = await repo.getListing(ctx.tx, id);
    if (!row || row.deletedAt) throw new AppError('LISTING_NOT_FOUND');
    owner = row.agencyId;
  } else {
    owner = await developments.presentableOwner(ctx, kind, id);
  }
  if (owner === ctx.tenant.agencyId) throw new AppError('LISTING_OVERRIDE_OWN_TARGET');
}

/** `GET /v1/listing-overrides/:targetKind/:targetId`: the caller's overrides of one target, every locale. */
export async function listListingOverrides(
  ctx: Ctx,
  targetKind: ListingOverrideTarget,
  targetId: string,
): Promise<ListingOverrideList> {
  const agencyId = presenter(ctx);
  const rows = await repo.listOverrides(ctx.tx, { agencyId, targetKind, targetId });
  return { items: rows.map(toDto) };
}

/**
 * `PUT /v1/listing-overrides/:targetKind/:targetId/:locale`: the agency's text for one locale (an empty field
 * keeps the owner's). A person's text is HUMAN; editing an AI draft makes it REVIEWED.
 */
export async function saveListingOverride(
  ctx: Ctx,
  targetKind: ListingOverrideTarget,
  targetId: string,
  locale: string,
  input: PutListingOverrideBody,
): Promise<ListingOverrideDto> {
  const agencyId = presenter(ctx);
  assertContentLocale(locale);
  await assertPresentable(ctx, targetKind, targetId);
  const existing = (await repo.listOverrides(ctx.tx, { agencyId, targetKind, targetId })).find(
    (o) => o.locale === locale,
  );
  const origin: TranslationOrigin = !existing ? 'HUMAN' : existing.origin === 'AI_DRAFT' ? 'REVIEWED' : existing.origin;
  const title = input.title || null;
  const description = input.description || null;
  if (existing && existing.title === title && existing.description === description) return toDto(existing);
  const saved = await repo.upsertOverride(ctx.tx, {
    id: newId(),
    agencyId,
    targetKind,
    targetId,
    locale,
    title,
    description,
    origin,
  });
  await emit(ctx.tx, propertiesEvents.overrideChanged({ agencyId, targetKind, targetId, locale }));
  return toDto(saved);
}

/** `DELETE /v1/listing-overrides/:targetKind/:targetId/:locale`: back to the owner's text. */
export async function deleteListingOverride(
  ctx: Ctx,
  targetKind: ListingOverrideTarget,
  targetId: string,
  locale: string,
): Promise<void> {
  const agencyId = presenter(ctx);
  if (!(await repo.deleteOverride(ctx.tx, { agencyId, targetKind, targetId, locale }))) {
    throw new AppError('LISTING_OVERRIDE_NOT_FOUND');
  }
  await emit(ctx.tx, propertiesEvents.overrideChanged({ agencyId, targetKind, targetId, locale }));
}

/**
 * The precedence every channel of an agency applies (website serializer S7-02, selections S12-04): the
 * caller's override of a field, else the owner's text it passes in. One statement for any number of targets;
 * only `ctx.tenant`'s overrides are read, so another agency's channel never sees them.
 */
export async function applyListingOverrides<T extends { id: string } & ListingText>(
  ctx: Ctx,
  targetKind: ListingOverrideTarget,
  locale: string,
  items: readonly T[],
): Promise<T[]> {
  const rows = await repo.overridesFor(
    ctx.tx,
    ctx.tenant.agencyId,
    targetKind,
    items.map((i) => i.id),
    locale,
  );
  if (rows.length === 0) return [...items];
  const byId = new Map(rows.map((r) => [r.targetId, r]));
  return items.map((item) => {
    const o = byId.get(item.id);
    return o ? { ...item, title: o.title ?? item.title, description: o.description ?? item.description } : item;
  });
}

/**
 * The text of listings as the caller's channels show them in one locale: the owner's translation under the
 * caller's override. Listings the caller cannot see (RLS), or without the owner's text in that locale, are left
 * out. Two statements.
 */
export async function listingTexts(
  ctx: Ctx,
  listingIds: readonly string[],
  locale: string,
): Promise<Map<string, ListingText>> {
  assertCan(ctx, 'listing.read');
  const owner = await repo.translationsFor(ctx.tx, listingIds, locale);
  const texts = await applyListingOverrides(
    ctx,
    'LISTING',
    locale,
    owner.map((t) => ({ id: t.propertyId, title: t.title, description: t.description })),
  );
  return new Map(texts.map(({ id, ...text }) => [id, text]));
}

/** An agency's override texts for its websites, by target (S7-02): listings, units and developments. */
export interface SiteOverrides {
  /** Overrides of listings and units, by target id. */
  targets: Map<string, ListingText>;
  /** Overrides of developments (their units' text), by development id. */
  developments: Map<string, ListingText>;
}

type OverrideRow = { targetKind: string; targetId: string; title: string | null; description: string | null };

const overridesFrom = (rows: readonly OverrideRow[]): SiteOverrides => {
  const out: SiteOverrides = { targets: new Map(), developments: new Map() };
  for (const r of rows) {
    (r.targetKind === 'DEVELOPMENT' ? out.developments : out.targets).set(r.targetId, {
      title: r.title,
      description: r.description,
    });
  }
  return out;
};

/**
 * `siteOverrides` as a part of another statement (S7-03): `sql` is a scalar subquery the caller selects (as
 * `app_public`), `read` turns its JSON value into the overrides. Lets the website API read overrides and owner
 * identities in one round trip.
 */
export function siteOverridesQuery(
  agencyId: string,
  targetIds: readonly string[],
  locale: string,
): { sql: SQL; read: (value: unknown) => SiteOverrides } {
  return {
    sql: repo.overridesOfTargetsJson(agencyId, targetIds, locale),
    read: (value) => overridesFrom((value ?? []) as OverrideRow[]),
  };
}

/**
 * The website API's overrides (S7-02, PLAN §3 #54): the site's agency's overrides of these targets (listing and unit
 * ids, and the developments of the units) in one locale — one statement. `tx` is the caller's public read
 * (`withPublicRead`, feed-api: no tenant session); `agencyId` comes from the authenticated key's site, never from
 * the visitor, so another agency's overrides never reach a site.
 */
export async function siteOverrides(
  tx: Tx,
  agencyId: string,
  targetIds: readonly string[],
  locale: string,
): Promise<SiteOverrides> {
  return overridesFrom(await repo.overridesOfTargets(tx, agencyId, targetIds, locale));
}
