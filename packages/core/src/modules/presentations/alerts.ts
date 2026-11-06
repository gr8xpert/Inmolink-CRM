/**
 * Selections for client alerts (R2-02e, PLAN §7 M9): the matching worker's AUTO_SEND delivery makes a selection of
 * the profile's new matches for the client, from the member the contact belongs to, and sends its link. Worker-only:
 * raw `tx` under `withSystem` — the caller checked the contact is an open contact of the agency, the sender an active
 * member who works clients, and the listings offerable by the agency (`search.offerableListingCards` under its RLS).
 * The page itself (`public.ts`) re-checks every item at each view and white-labels it like any selection.
 */
import { randomBytes } from 'node:crypto';
import { SELECTION_LIMITS } from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import { CONTENT_LOCALES } from '@inmolink/i18n';
import { clock } from '@inmolink/platform/clock';
import { newId } from '@inmolink/platform/ids';
import { publicBaseUrl, selectionPath, selectionTokenHash } from './config';
import * as repo from './repo';

const DAY_MS = 86_400_000;

function newToken(): { token: string; hash: string; hint: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: selectionTokenHash(token), hint: token.slice(-4) };
}

/** The page's absolute URL for a token, or null when the public pages' origin is not configured. */
export function selectionUrl(token: string): string | null {
  const base = publicBaseUrl();
  return base ? `${base}${selectionPath(token)}` : null;
}

/** Whether alert links can be made at all (`PUBLIC_PAGES_URL` configured). */
export const selectionLinksConfigured = (): boolean => publicBaseUrl() !== null;

/**
 * A new selection for the contact holding `targetIds` (in that order, ≤ `SELECTION_LIMITS.items`), in the client's
 * language, made by `createdBy`; answers its id and token (shown once: the caller sends it, never stores or logs it).
 * Three statements.
 */
export async function createAlertSelection(
  tx: Tx,
  p: {
    agencyId: string;
    createdBy: string;
    contactId: string;
    title: string;
    locale: string;
    targetIds: readonly string[];
  },
): Promise<{ id: string; token: string }> {
  if (!(CONTENT_LOCALES as readonly string[]).includes(p.locale)) throw new TypeError('alert selection: locale');
  const targets = [...new Set(p.targetIds)].slice(0, SELECTION_LIMITS.items);
  if (targets.length === 0) throw new TypeError('alert selection: no items');
  const id = newId();
  const t = newToken();
  await repo.insertSelection(tx, {
    id,
    agencyId: p.agencyId,
    createdBy: p.createdBy,
    contactId: p.contactId,
    title: p.title.trim().slice(0, SELECTION_LIMITS.titleChars),
    message: null,
    locale: p.locale,
    tokenHash: t.hash,
    tokenHint: t.hint,
    expiresAt: new Date(clock.now().getTime() + SELECTION_LIMITS.expiryDaysDefault * DAY_MS),
  });
  await repo.insertItems(
    tx,
    targets.map((targetId, position) => ({
      id: newId(),
      agencyId: p.agencyId,
      selectionId: id,
      targetId,
      position,
      titleOverride: null,
      note: null,
    })),
  );
  return { id, token: t.token };
}

/**
 * A new link for an alert's selection (a send that failed is retried with it: the token was never stored); the old
 * link stops, an expired selection lives again for `SELECTION_LIMITS.expiryDaysDefault` days. Null when the selection
 * is gone (deleted with its contact) or a member revoked it (the alert is not sent again). One statement.
 */
export async function relinkAlertSelection(tx: Tx, agencyId: string, id: string): Promise<string | null> {
  const t = newToken();
  const ok = await repo.relinkSelection(
    tx,
    { agencyId, id },
    {
      tokenHash: t.hash,
      tokenHint: t.hint,
      expiresAt: new Date(clock.now().getTime() + SELECTION_LIMITS.expiryDaysDefault * DAY_MS),
    },
  );
  return ok ? t.token : null;
}

/**
 * Never twice across sends: of these listings, the ones already in a selection the agency made for the contact (sent,
 * shared, a review draft — any). One statement.
 */
export async function contactSelectionTargets(
  tx: Tx,
  agencyId: string,
  contactId: string,
  targetIds: readonly string[],
): Promise<Set<string>> {
  return new Set(await repo.contactSelectionTargets(tx, agencyId, contactId, targetIds));
}
