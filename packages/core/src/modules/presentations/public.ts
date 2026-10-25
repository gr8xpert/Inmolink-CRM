/**
 * Selections — the public page side (S12-04): what `apps/public` renders at `/s/<token>` and the client's actions on
 * it. No `ctx`: the visitor is anonymous and the token (a 32-byte secret) is the only key — it is hashed with
 * `HMAC_KEY` (rotation candidates included) and looked up as `app_public`, which sees live selections only.
 *
 * Live data, never per-request joins over raw tables (CLAUDE.md rule 9): the documents are the read models
 * (`search.publicDocs`, `app_public`: PUBLIC ones only — an item no longer public shows as unavailable), so an owner's
 * price or status change shows on the next view (the read model is rebuilt within seconds of the change, and pages
 * are not cached). White-labelled as on a website of the selection's agency (`websiteApi.presentPublicDocs`, S13-F11:
 * the same read as listing PDFs): another agency's listing carries the agency's own reference prefix and presenter,
 * its text the deterministic pass and the model pass's cached removals (S12-03). The agent's own title and note for an item
 * are plain text (rendered escaped) and, on another agency's listing, white-labelled too.
 *
 * Statements per page: the selection with its items (1), then `presentPublicDocs`'s: the agency's public profile (1),
 * the documents (1), whether the other agencies' ones are still shared with the agency and both still listed (1, when
 * there are any), the presentation (1: overrides and owner identities) — plus one redis-cache MGET (cached removals).
 */
import type { WebsiteDetail, WebsitePresenter } from '@inmolink/contracts';
import { AppError, type SelectionPageAction } from '@inmolink/contracts';
import { withIntake, withPublicRead } from '@inmolink/db';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import type { RateLimitCheck, RateLimiter } from '@inmolink/platform/rate-limit';
import { compileOwner, NO_OWNER, plainText } from '../../white-label';
import { whiteLabelListingTextWith } from '../../white-label-listing';
import * as websiteApi from '../website-api';
import type * as websites from '../websites';
import { SELECTION_TOKEN, selectionTokenHash, selectionTokenHashCandidates } from './config';
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
    // S13-F11: the one "present public docs" read, shared with listing PDFs. Re-checked at every view (security
    // review): another agency's listing shows only while its owner still shares it with the selection's agency (shared
    // with ALL or this agency preferred, not hidden from the network) and both agencies are listed (S12 review: an
    // unverified or suspended agency presents no network listing) — an owner narrowing or withdrawing it takes it off
    // every selection at once, whatever the selection's expiry.
    const { view, rows, details } = await websiteApi.presentPublicDocs(tx, {
      agencyId: sel.agencyId,
      ids: sel.items.map((i) => i.targetId),
      locale,
      fallbackLocale: sel.locale,
      fallbackName: sel.title,
      titles: titlesOf(sel.items),
    });
    return presentSelection({ selection: sel, locale, view, rows, details });
  });
}

/** A document row as the page needs it (`search.publicDocs`). */
export type SelectionDocRow = websiteApi.PresentableDocRow;

/** The agent's titles for the selection's items: they take precedence over the agency's own listing override. */
const titlesOf = (items: readonly { targetId: string; titleOverride: string | null }[]) =>
  new Map(items.flatMap((i) => (i.titleOverride ? [[i.targetId, i.titleOverride] as const] : [])));

/**
 * The page from what was read (pure): each item's document as the agency presents it (`websiteApi.presentDocs` on
 * `view`, the agent's title for it taking precedence over the agency's own listing override; `details` when
 * `presentPublicDocs` already presented them), its note white-labelled like the owner's text on another agency's
 * listing; items without a public document are unavailable.
 */
export function presentSelection(input: {
  selection: Omit<repo.PublicSelectionRow, 'agencyId'> & { agencyId: string };
  locale: string;
  view: websites.SiteView;
  rows: readonly SelectionDocRow[];
  details?: ReadonlyMap<string, WebsiteDetail>;
}): SelectionPageModel {
  const { selection: sel, view, rows } = input;
  const details = input.details ?? websiteApi.presentDocs(view, rows, titlesOf(sel.items)).details;
  const byTarget = new Map(rows.map((r) => [r.targetId, r]));
  const items = sel.items.map((i): SelectionPageItem => {
    const r = byTarget.get(i.targetId);
    const detail = r ? (details.get(i.targetId) ?? null) : null;
    if (!r || !detail)
      return { targetId: i.targetId, position: i.position, note: i.note ? plainText(i.note) : null, detail: null };
    return {
      targetId: i.targetId,
      position: i.position,
      note: i.note ? noteOf(view, r, i.note) : null,
      detail,
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

/**
 * The agent's note on an item: plain text; on another agency's listing, white-labelled like the owner's text (S13-F11:
 * the one white-label pass, with the owner facts the view already read — no statement).
 */
function noteOf(
  view: websites.SiteView,
  item: { ownerAgencyId: string; developmentOwnRef: string | null; doc: unknown },
  note: string,
): string {
  const doc = item.doc as { id: string; ref: string };
  const listing = {
    id: doc.id,
    agencyId: item.ownerAgencyId,
    ref: doc.ref,
    developmentOwnRef: item.developmentOwnRef,
  };
  const owner = {
    matcher: view.matchers?.get(item.ownerAgencyId) ?? compileOwner(view.owners?.get(item.ownerAgencyId) ?? NO_OWNER),
    removals: view.aiRemovals?.get(doc.id),
  };
  const [clean] = whiteLabelListingTextWith(owner, listing, view.site.agencyId, [note] as const, { own: plainText });
  return clean;
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
  await writeInteraction(sel, interaction, targetId);
}

/**
 * A view of a page just rendered (`selectionPage`'s model: the token was looked up for it) — no second lookup. Counted
 * once per selection per client address per `VIEW_WINDOW_SECONDS` (the limiter's window; a browser dropping its cookie
 * cannot flood the timeline). False: not counted (seen in the window).
 */
export async function recordSelectionPageView(
  limiter: RateLimiter,
  page: Pick<SelectionPageModel, 'id' | 'agencyId'>,
  facts: { ip: string },
): Promise<boolean> {
  const [first] = await limiter.consumeMany(
    [
      {
        rule: { name: 'selection.view', scope: 'ip', limit: 1, windowSeconds: VIEW_WINDOW_SECONDS, fixedWindow: true },
        identity: `${page.id}|${facts.ip}`,
      },
    ],
    { slot: facts.ip },
  );
  if (first && !first.allowed) return false;
  await writeInteraction(page, { kind: 'VIEW' }, null);
  return true;
}

/** A view is counted once per selection and client address in this window. */
export const VIEW_WINDOW_SECONDS = 6 * 3_600;

async function writeInteraction(
  sel: { id: string; agencyId: string },
  interaction: SelectionInteraction,
  targetId: string | null,
): Promise<void> {
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

/** Page views per client IP (all selections); actions per page per IP; enquiries per page (every client together). */
export const SELECTION_PAGE_LIMITS = { perMinute: 60, actionsPerHour: 30, enquiriesPerHour: 20 } as const;

/**
 * The page's request limits: views per IP and, with `write`, the actions (likes, enquiries) per selection × IP, and
 * with `enquiry` the selection's enquiries per hour whoever sends them — one Redis round trip; the limiter fails open
 * when Redis is down. Keyed by the token's keyed hash, never the token.
 */
export async function checkSelectionLimits(
  limiter: RateLimiter,
  facts: { ip: string; write?: { token: string; enquiry?: boolean } },
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const checks: RateLimitCheck[] = [
    {
      rule: { name: 'selection.page', scope: 'ip', limit: SELECTION_PAGE_LIMITS.perMinute, windowSeconds: 60 },
      identity: facts.ip,
    },
  ];
  if (facts.write) {
    const page = selectionTokenHash(facts.write.token).slice(0, 22);
    checks.push({
      rule: {
        name: 'selection.actions',
        scope: 'ip',
        limit: SELECTION_PAGE_LIMITS.actionsPerHour,
        windowSeconds: 3_600,
      },
      identity: `${page}|${facts.ip}`,
    });
  }
  const results = await limiter.consumeMany(checks, { slot: facts.ip });
  const denied = results.filter((r) => !r.allowed);
  if (denied.length === 0 && facts.write?.enquiry) {
    // The selection's enquiry budget is shared by every client address: its own call, keyed (and slotted) by the page
    // alone — in the call above the IP's slot would be part of its key and make it a per-address cap.
    const page = selectionTokenHash(facts.write.token).slice(0, 22);
    const [enquiries] = await limiter.consumeMany(
      [
        {
          rule: {
            name: 'selection.enquiries',
            scope: 'key',
            limit: SELECTION_PAGE_LIMITS.enquiriesPerHour,
            windowSeconds: 3_600,
          },
          identity: page,
        },
      ],
      { slot: page },
    );
    if (enquiries && !enquiries.allowed) denied.push(enquiries);
  }
  return { allowed: denied.length === 0, retryAfterSeconds: Math.max(0, ...denied.map((r) => r.retryAfterSeconds)) };
}
