/**
 * Selections — the public page side (S12-04): what `apps/public` renders at `/s/<token>` and the client's actions on
 * it. No `ctx`: the visitor is anonymous and the token (a 32-byte secret) is the only key — it is hashed with
 * `HMAC_KEY` (rotation candidates included) and looked up as `app_public`, which sees live selections only.
 *
 * Live data, never per-request joins over raw tables (CLAUDE.md rule 9): the documents are the read models
 * (`search.publicDocs`, `app_public`: PUBLIC ones only — an item no longer public shows as unavailable), so an owner's
 * price or status change shows on the next view (the read model is rebuilt within seconds of the change, and pages
 * are not cached). White-labelled as on a website of the selection's agency (`websites.serializeDetail` through
 * `websiteApi.viewWith`): another agency's listing carries the agency's own reference prefix and presenter, its text
 * the deterministic pass and the model pass's cached removals (S12-03). The agent's own title and note for an item
 * are plain text (rendered escaped) and, on another agency's listing, white-labelled too.
 *
 * Statements per page: the selection with its items (1), the documents (1), the presentation (1: overrides and owner
 * identities), the agency's public profile (1) — plus one redis-cache MGET (cached removals).
 */
import type { WebsiteDetail, WebsitePresenter } from '@inmolink/contracts';
import { AppError, type SelectionPageAction } from '@inmolink/contracts';
import { withIntake, withPublicRead } from '@inmolink/db';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import type { RateLimitCheck, RateLimiter } from '@inmolink/platform/rate-limit';
import { compileOwner, NO_OWNER, ownerRefsOf, plainText, whiteLabelText } from '../../white-label';
import * as agencies from '../agencies';
import * as search from '../search';
import * as websiteApi from '../website-api';
import * as websites from '../websites';
import { SELECTION_TOKEN, selectionTokenHashCandidates } from './config';
import { presentationsEvents } from './events';
import * as repo from './repo';

export interface SelectionPageItem {
  targetId: string;
  position: number;
  /** The agent's note on the item: plain text (escape it), white-labelled on another agency's listing. */
  note: string | null;
  /** The document as the agency presents it; null when it can no longer be shown (sold off the market, unshared). */
  detail: WebsiteDetail | null;
}

export interface SelectionPageModel {
  id: string;
  agencyId: string;
  title: string;
  message: string | null;
  /** The page's language (the client's, unless the visitor picked another). */
  locale: string;
  expiresAt: Date | null;
  presenter: WebsitePresenter;
  items: SelectionPageItem[];
}

/** The live selection a token names (`app_public`); `SELECTION_NOT_FOUND` for a malformed, unknown, expired or revoked one. */
async function liveSelection(token: string): Promise<repo.PublicSelectionRow> {
  if (!SELECTION_TOKEN.test(token)) throw new AppError('SELECTION_NOT_FOUND');
  const row = await withPublicRead((tx) => repo.liveSelectionByTokenHash(tx, selectionTokenHashCandidates(token)));
  if (!row) throw new AppError('SELECTION_NOT_FOUND');
  return row;
}

/** The page a token names, in `lang` (default: the client's language), white-labelled and live. */
export async function selectionPage(token: string, lang?: string): Promise<SelectionPageModel> {
  if (!SELECTION_TOKEN.test(token)) throw new AppError('SELECTION_NOT_FOUND');
  return withPublicRead(async (tx) => {
    const sel = await repo.liveSelectionByTokenHash(tx, selectionTokenHashCandidates(token));
    if (!sel) throw new AppError('SELECTION_NOT_FOUND');
    const locale = lang && /^[a-z]{2}(-[A-Z]{2})?$/.test(lang) ? lang : sel.locale;
    const agency = (await agencies.publicAgencies(tx, [sel.agencyId])).get(sel.agencyId) ?? null;
    const presenter = websites.sitePresenter({ name: agency?.name ?? sel.title, contact: null }, agency);
    const rows = await search.publicDocs(
      tx,
      sel.items.map((i) => i.targetId),
      'detail',
      locale,
      sel.locale,
    );
    const scope = { agencyId: sel.agencyId, referencePrefix: null, presenter };
    const { view } = await websiteApi.viewWith(tx, { scope }, locale, rows);
    return presentSelection({ selection: sel, locale, view, rows });
  });
}

/** A document row as the page needs it (`search.publicDocs`). */
export type SelectionDocRow = Pick<
  search.PublicDocRow,
  'targetId' | 'ownerAgencyId' | 'publicCode' | 'developmentCode' | 'developmentOwnRef' | 'doc'
>;

/**
 * The page from what was read (pure): each item's document as the agency presents it (`websites.serializeDetail` on
 * `view`, the agent's title for it taking precedence over the agency's own listing override), its note white-labelled
 * like the owner's text on another agency's listing; items without a public document are unavailable.
 */
export function presentSelection(input: {
  selection: Omit<repo.PublicSelectionRow, 'agencyId'> & { agencyId: string };
  locale: string;
  view: websites.SiteView;
  rows: readonly SelectionDocRow[];
}): SelectionPageModel {
  const { selection: sel, view, rows } = input;
  const targets = new Map(view.overrides?.targets ?? []);
  for (const i of sel.items) {
    if (i.titleOverride) {
      targets.set(i.targetId, { title: i.titleOverride, description: targets.get(i.targetId)?.description ?? null });
    }
  }
  const shown: websites.SiteView = {
    ...view,
    overrides: { targets, developments: view.overrides?.developments ?? new Map() },
  };
  const byTarget = new Map(rows.map((r) => [r.targetId, r]));
  const items = sel.items.map((i): SelectionPageItem => {
    const r = byTarget.get(i.targetId);
    if (!r)
      return { targetId: i.targetId, position: i.position, note: i.note ? plainText(i.note) : null, detail: null };
    const owned = {
      ownerAgencyId: r.ownerAgencyId,
      publicCode: r.publicCode,
      developmentCode: r.developmentCode,
      developmentOwnRef: r.developmentOwnRef,
      doc: r.doc as Parameters<typeof websites.serializeDetail>[1]['doc'],
    };
    return {
      targetId: i.targetId,
      position: i.position,
      note: i.note ? noteOf(shown, owned, i.note) : null,
      detail: websites.serializeDetail(shown, owned),
    };
  });
  return {
    id: sel.id,
    agencyId: sel.agencyId,
    title: plainText(sel.title),
    message: sel.message ? plainText(sel.message) : null,
    locale: input.locale,
    expiresAt: sel.expiresAt ? new Date(sel.expiresAt) : null,
    presenter: view.presenter,
    items,
  };
}

/** The agent's note on an item: plain text; on another agency's listing, white-labelled like the owner's text. */
function noteOf(
  view: websites.SiteView,
  item: { ownerAgencyId: string; developmentOwnRef: string | null; doc: { id: string; ref: string } },
  note: string,
): string {
  if (item.ownerAgencyId === view.site.agencyId) return plainText(note);
  const matcher =
    view.matchers?.get(item.ownerAgencyId) ?? compileOwner(view.owners?.get(item.ownerAgencyId) ?? NO_OWNER);
  const refs = ownerRefsOf({ ref: item.doc.ref, developmentOwnRef: item.developmentOwnRef });
  return whiteLabelText(note, matcher, refs, view.aiRemovals?.get(item.doc.id));
}

export type SelectionInteraction =
  | { kind: 'VIEW' }
  | { kind: 'LIKE' | 'UNLIKE'; targetId: string }
  | { kind: 'ENQUIRE'; targetId?: string; message: string };

/** A form post of the page as an interaction. */
export function interactionOf(action: SelectionPageAction): SelectionInteraction {
  if (action.action === 'enquire') {
    return { kind: 'ENQUIRE', message: action.message, ...(action.item ? { targetId: action.item } : {}) };
  }
  return { kind: action.action === 'like' ? 'LIKE' : 'UNLIKE', targetId: action.item };
}

/**
 * Records what the client did on the page (S12-04): the interaction and its event, in one intake transaction pinned
 * to the selection's agency (`app_intake`) — never another agency's. An item must be one of the selection's.
 */
export async function recordSelectionInteraction(token: string, interaction: SelectionInteraction): Promise<void> {
  const sel = await liveSelection(token);
  const targetId = 'targetId' in interaction ? (interaction.targetId ?? null) : null;
  if (targetId && !sel.items.some((i) => i.targetId === targetId)) {
    throw new AppError('VALIDATION_FAILED', { field: 'item', reason: 'not in this selection' });
  }
  const id = newId();
  await withIntake({ agencyId: sel.agencyId }, async (tx) => {
    await repo.insertInteraction(tx, {
      id,
      agencyId: sel.agencyId,
      selectionId: sel.id,
      kind: interaction.kind,
      targetId,
      message: interaction.kind === 'ENQUIRE' ? interaction.message : null,
    });
    await emit(
      tx,
      presentationsEvents.selectionInteracted({
        selectionId: sel.id,
        interactionId: id,
        kind: interaction.kind,
        targetId,
      }),
      { agencyId: sel.agencyId },
    );
  });
}

/** Page views per client IP (all selections), and actions per page per IP. */
export const SELECTION_PAGE_LIMITS = { perMinute: 60, actionsPerHour: 30 } as const;

/**
 * The page's request limits: views per IP and, with `write`, the actions (likes, enquiries) per selection × IP — one
 * Redis round trip; the limiter fails open when Redis is down.
 */
export async function checkSelectionLimits(
  limiter: RateLimiter,
  facts: { ip: string; write?: { token: string } },
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const checks: RateLimitCheck[] = [
    {
      rule: { name: 'selection.page', scope: 'ip', limit: SELECTION_PAGE_LIMITS.perMinute, windowSeconds: 60 },
      identity: facts.ip,
    },
  ];
  if (facts.write) {
    checks.push({
      rule: {
        name: 'selection.actions',
        scope: 'ip',
        limit: SELECTION_PAGE_LIMITS.actionsPerHour,
        windowSeconds: 3_600,
      },
      identity: `${facts.write.token.slice(0, 12)}|${facts.ip}`,
    });
  }
  const results = await limiter.consumeMany(checks, { slot: facts.ip });
  const denied = results.filter((r) => !r.allowed);
  return { allowed: denied.length === 0, retryAfterSeconds: Math.max(0, ...denied.map((r) => r.retryAfterSeconds)) };
}
