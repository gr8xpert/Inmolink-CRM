/**
 * Selections (S12-04, PLAN §7 M13) — the dashboard side: an agent picks listings and units (from search results, in
 * order, or one of their bookmark folders) for a client, gets a link to a branded live page (`public.ts`) and shares
 * it by WhatsApp or e-mail; views, likes and enquiries come back to the selection and to the client's CRM timeline.
 *
 * A link is a random 32-byte token shown once (`share`); the table keeps only its keyed hash, so a new link
 * (`rotateSelectionLink`) is the way to see one again — and stops the old one. Expiry: 30 days by default, 365 at most;
 * `expiresInDays: null` stops the page now.
 */
import { randomBytes } from 'node:crypto';
import {
  AppError,
  type CreateSelectionBody,
  type ListSelectionInteractionsQuery,
  type ListSelectionsQuery,
  type PdfDocumentDto,
  SELECTION_LIMITS,
  type SelectionCreatedDto,
  type SelectionDto,
  type SelectionInteractionPage,
  type SelectionItemInput,
  type SelectionPage,
  type SelectionShareDto,
  type SelectionStatus,
  type UpdateSelectionBody,
} from '@inmolink/contracts';
import { CONTENT_LOCALES } from '@inmolink/i18n';
import { clock } from '@inmolink/platform/clock';
import { newId } from '@inmolink/platform/ids';
import type { Ctx } from '../../context';
import { decodeCursor, toPage } from '../../pagination';
import * as crm from '../crm';
import * as documents from '../documents';
import * as properties from '../properties';
import * as search from '../search';
import { publicBaseUrl, selectionPath, selectionTokenHash } from './config';
import { assertCan } from './policy';
import * as repo from './repo';

const DAY_MS = 86_400_000;

function memberId(ctx: Ctx): string {
  if (ctx.actor.kind !== 'user') throw new AppError('FORBIDDEN');
  return ctx.actor.userId;
}

export function statusOf(row: Pick<repo.SelectionView, 'revokedAt' | 'expiresAt'>, now = clock.now()): SelectionStatus {
  if (row.revokedAt) return 'REVOKED';
  return row.expiresAt && row.expiresAt.getTime() <= now.getTime() ? 'EXPIRED' : 'LIVE';
}

function toDto(
  row: repo.SelectionView,
  items: repo.ItemWithStats[],
  stats: { views: number; lastViewedAt: Date | null },
): SelectionDto {
  return {
    id: row.id,
    title: row.title,
    message: row.message,
    locale: row.locale,
    contactId: row.contactId,
    status: statusOf(row),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    tokenHint: row.tokenHint,
    items: items.map((i) => ({
      targetId: i.targetId,
      position: i.position,
      titleOverride: i.titleOverride,
      note: i.note,
      likes: i.likes,
      enquiries: i.enquiries,
    })),
    stats: { views: stats.views, lastViewedAt: stats.lastViewedAt?.toISOString() ?? null },
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A new random token and what is stored of it. */
function newToken(): { token: string; hash: string; hint: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: selectionTokenHash(token), hint: token.slice(-4) };
}

/** WhatsApp's share link (`wa.me`): the client's number when known, else the picker. */
const WHATSAPP_SHARE = 'https://wa.me/';

/**
 * The share links of a page (pure): the page URL on the public pages host (`PUBLIC_PAGES_URL`), a WhatsApp deep link
 * with the title and URL as the text, and a `mailto:` with them as subject and body. Without a configured host only
 * the path is known.
 */
export function shareLinks(input: {
  token: string;
  title: string;
  message: string | null;
  base: string | null;
  phone?: string | null;
  email?: string | null;
}): SelectionShareDto {
  const path = selectionPath(input.token);
  if (!input.base) return { token: input.token, path, url: null, whatsappUrl: null, emailUrl: null };
  const url = `${input.base}${path}`;
  const text = [input.title, input.message, url].filter(Boolean).join('\n\n');
  const digits = (input.phone ?? '').replace(/\D/g, '');
  const to = digits.length >= 8 ? digits : '';
  const mailTo = input.email && /^[^\s@,;?&]+@[^\s@,;?&]+$/.test(input.email) ? encodeURIComponent(input.email) : '';
  return {
    token: input.token,
    path,
    url,
    whatsappUrl: `${WHATSAPP_SHARE}${to}?text=${encodeURIComponent(text)}`,
    emailUrl: `mailto:${mailTo}?subject=${encodeURIComponent(input.title)}&body=${encodeURIComponent(text)}`,
  };
}

/** The items as stored: those the agent can see (own or shared with them), in the given order, first one per target. */
async function visibleItems(ctx: Ctx, items: readonly SelectionItemInput[]): Promise<repo.ItemInsert[]> {
  const unique = [...new Map(items.map((i) => [i.targetId, i])).values()].slice(0, SELECTION_LIMITS.items);
  // RLS keeps the read models to the agency's own and the network's it may see.
  const seen = new Set(
    await search.visibleTargets(
      ctx.tx,
      unique.map((i) => i.targetId),
    ),
  );
  const kept = unique.filter((i) => seen.has(i.targetId));
  if (kept.length === 0) throw new AppError('SELECTION_ITEMS_INVALID');
  return kept.map((i, position) => ({
    id: newId(),
    agencyId: ctx.tenant.agencyId,
    selectionId: '',
    targetId: i.targetId,
    position,
    titleOverride: i.titleOverride ?? null,
    note: i.note ?? null,
  }));
}

/** The client's language: any content language (the page shows each document in it, else the agency's own). */
function assertLocale(_ctx: Ctx, locale: string): void {
  if (!(CONTENT_LOCALES as readonly string[]).includes(locale)) {
    throw new AppError('VALIDATION_FAILED', { field: 'locale', reason: 'not a content locale' });
  }
}

const expiryIn = (days: number) => new Date(clock.now().getTime() + days * DAY_MS);

async function contactShare(ctx: Ctx, contactId: string | null) {
  if (!contactId) return { phone: null, email: null };
  const contact = await crm.getContact(ctx, contactId);
  return { phone: contact.phones[0] ?? null, email: contact.emails[0] ?? null };
}

/** `POST /v1/selections`: a selection and its link (shown once). */
export async function createSelection(ctx: Ctx, body: CreateSelectionBody): Promise<SelectionCreatedDto> {
  assertCan(ctx, 'presentations.write');
  const createdBy = memberId(ctx);
  assertLocale(ctx, body.locale);
  // A contact of another agency (or none) is CONTACT_NOT_FOUND.
  const contactId = body.contactId ?? null;
  const contact = await contactShare(ctx, contactId);
  const input: SelectionItemInput[] = body.fromFolderId
    ? (await properties.bookmarkFolderListingIds(ctx, body.fromFolderId)).map((targetId) => ({ targetId }))
    : (body.items ?? []);
  const items = await visibleItems(ctx, input);
  const id = newId();
  const t = newToken();
  await repo.insertSelection(ctx.tx, {
    id,
    agencyId: ctx.tenant.agencyId,
    createdBy,
    contactId,
    title: body.title,
    message: body.message ?? null,
    locale: body.locale,
    tokenHash: t.hash,
    tokenHint: t.hint,
    expiresAt: expiryIn(body.expiresInDays ?? SELECTION_LIMITS.expiryDaysDefault),
  });
  await repo.insertItems(
    ctx.tx,
    items.map((i) => ({ ...i, selectionId: id })),
  );
  const selection = await getSelection(ctx, id);
  return {
    selection,
    share: shareLinks({
      token: t.token,
      title: body.title,
      message: body.message ?? null,
      base: publicBaseUrl(),
      ...contact,
    }),
  };
}

/** `GET /v1/selections/:id`: the selection, its items with likes and enquiries, its views. */
export async function getSelection(ctx: Ctx, id: string): Promise<SelectionDto> {
  assertCan(ctx, 'presentations.read');
  const row = await repo.getSelection(ctx.tx, ctx.tenant.agencyId, id);
  if (!row) throw new AppError('SELECTION_NOT_FOUND');
  const items = await repo.itemsWithStats(ctx.tx, id);
  const stats = (await repo.viewStats(ctx.tx, [id])).get(id) ?? { views: 0, lastViewedAt: null };
  return toDto(row, items, stats);
}

/**
 * S12-05 `POST /v1/selections/:id/pdf`: the selection as a branded PDF portfolio — its items in order, in the client's
 * language, under its title — rendered by the pdf pool like any portfolio (`documents.requestPortfolio`: the public
 * read models, white-labelled for the agency). The agent's notes and title overrides stay on the live page.
 */
export async function selectionPdf(ctx: Ctx, id: string): Promise<PdfDocumentDto> {
  assertCan(ctx, 'presentations.read');
  const row = await repo.getSelection(ctx.tx, ctx.tenant.agencyId, id);
  if (!row) throw new AppError('SELECTION_NOT_FOUND');
  const items = await repo.itemsWithStats(ctx.tx, id);
  if (items.length === 0) throw new AppError('SELECTION_ITEMS_INVALID');
  return documents.requestPortfolio(ctx, {
    listingIds: items.map((i) => i.targetId),
    locale: row.locale,
    title: row.title.trim().slice(0, 120) || undefined,
  });
}

/** `GET /v1/selections`: newest first, keyset (≤ 100 per page; two statements). */
export async function listSelections(ctx: Ctx, query: ListSelectionsQuery): Promise<SelectionPage> {
  assertCan(ctx, 'presentations.read');
  const cursor = decodeCursor(query.cursor);
  const rows = await repo.listSelections(
    ctx.tx,
    ctx.tenant.agencyId,
    query.contactId ? { contactId: query.contactId } : {},
    cursor,
    query.limit,
  );
  const stats = await repo.viewStats(
    ctx.tx,
    rows.slice(0, query.limit).map((r) => r.id),
  );
  return toPage(
    rows,
    query.limit,
    (r) => ({ at: r.createdAt, id: r.id, atUs: r.atUs }),
    (r) => {
      const s = stats.get(r.id) ?? { views: 0, lastViewedAt: null, itemCount: 0 };
      const { items: _items, ...dto } = toDto(r, [], s);
      return { ...dto, itemCount: s.itemCount };
    },
  );
}

/** `PATCH /v1/selections/:id`: title, message, language, expiry, items (a new order) — optimistic. */
export async function updateSelection(ctx: Ctx, id: string, body: UpdateSelectionBody): Promise<SelectionDto> {
  assertCan(ctx, 'presentations.write');
  const row = await repo.getSelection(ctx.tx, ctx.tenant.agencyId, id);
  if (!row) throw new AppError('SELECTION_NOT_FOUND');
  if (body.locale) assertLocale(ctx, body.locale);
  const patch: Parameters<typeof repo.updateSelection>[2] = {};
  if (body.title !== undefined) patch.title = body.title;
  if (body.message !== undefined) patch.message = body.message;
  if (body.locale !== undefined) patch.locale = body.locale;
  if (body.expiresInDays === null) patch.revokedAt = clock.now();
  else if (body.expiresInDays !== undefined) patch.expiresAt = expiryIn(body.expiresInDays);
  const updated = await repo.updateSelection(
    ctx.tx,
    { agencyId: ctx.tenant.agencyId, id, version: body.version },
    patch,
  );
  if (!updated) throw new AppError('VERSION_CONFLICT');
  if (body.items) {
    const items = await visibleItems(ctx, body.items);
    await repo.replaceItems(
      ctx.tx,
      id,
      items.map((i) => ({ ...i, selectionId: id })),
    );
  }
  return getSelection(ctx, id);
}

/**
 * `POST /v1/selections/:id/link`: a new link (shown once); the old one stops at once. A revoked or expired
 * selection comes back to life for `SELECTION_LIMITS.expiryDaysDefault` days (or its own later expiry).
 */
export async function rotateSelectionLink(ctx: Ctx, id: string, version: number): Promise<SelectionCreatedDto> {
  assertCan(ctx, 'presentations.write');
  const row = await repo.getSelection(ctx.tx, ctx.tenant.agencyId, id);
  if (!row) throw new AppError('SELECTION_NOT_FOUND');
  const t = newToken();
  const live = statusOf(row) === 'LIVE';
  const updated = await repo.updateSelection(
    ctx.tx,
    { agencyId: ctx.tenant.agencyId, id, version },
    {
      tokenHash: t.hash,
      tokenHint: t.hint,
      revokedAt: null,
      ...(live ? {} : { expiresAt: expiryIn(SELECTION_LIMITS.expiryDaysDefault) }),
    },
  );
  if (!updated) throw new AppError('VERSION_CONFLICT');
  const contact = await contactShare(ctx, updated.contactId);
  return {
    selection: await getSelection(ctx, id),
    share: shareLinks({
      token: t.token,
      title: updated.title,
      message: updated.message,
      base: publicBaseUrl(),
      ...contact,
    }),
  };
}

/** `GET /v1/selections/:id/interactions`: what the client did, newest first, keyset. */
export async function listSelectionInteractions(
  ctx: Ctx,
  id: string,
  query: ListSelectionInteractionsQuery,
): Promise<SelectionInteractionPage> {
  assertCan(ctx, 'presentations.read');
  const row = await repo.getSelection(ctx.tx, ctx.tenant.agencyId, id);
  if (!row) throw new AppError('SELECTION_NOT_FOUND');
  const rows = await repo.listInteractions(ctx.tx, id, decodeCursor(query.cursor), query.limit);
  return toPage(
    rows,
    query.limit,
    (r) => ({ at: r.createdAt, id: r.id, atUs: r.atUs }),
    (r) => ({
      id: r.id,
      kind: r.kind as 'VIEW' | 'LIKE' | 'UNLIKE' | 'ENQUIRE',
      targetId: r.targetId,
      message: r.message,
      createdAt: r.createdAt.toISOString(),
    }),
  );
}
