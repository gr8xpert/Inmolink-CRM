import type { Tx } from '@inmolink/db';
import * as agencies from './modules/agencies';
import {
  compileOwner,
  NO_OWNER,
  type OwnerMatcher,
  ownerRefsOf,
  type TextRemovals,
  whiteLabelText,
} from './white-label';
import { readAiRemovals } from './white-label-store';

/**
 * S13-F11: one white-label pass for a listing's texts shown outside its owner agency — the owner's identity (names,
 * contacts, website), the listing's own references (`ownerRefsOf`: its own and its development's) and the model pass's
 * cached removals of those texts (S12-03). Every serving path that white-labels a listing's free text one by one
 * (listing content in Client Mode, social captions, selection notes) goes through it; the website serializer cleans
 * whole documents with the same `whiteLabelText`.
 */

/** The listing a text belongs to: its owner agency and the references its text loses. */
export interface WhiteLabelListing {
  id: string;
  agencyId: string;
  ref: string;
  developmentOwnRef?: string | null;
}

/** What the pass knows about the owner: its compiled identity and the cached removals of the listing's texts. */
export interface ListingOwnerFacts {
  matcher: OwnerMatcher;
  removals?: TextRemovals;
}

export interface WhiteLabelListingOptions {
  /** How the viewer's own listing's texts are shown (default: as they are — nobody else's identity to remove). */
  own?: (text: string) => string;
}

type Texts = readonly (string | null)[];
type Cleaned<T extends Texts> = { -readonly [K in keyof T]: T[K] };

/**
 * The pass with the owner's facts already read (pure): a page that read them for many listings at once (a website
 * view's `matchers` and `aiRemovals`) cleans each text without another statement. Nulls stay null.
 */
export function whiteLabelListingTextWith<T extends Texts>(
  owner: ListingOwnerFacts | null,
  listing: WhiteLabelListing,
  viewerAgencyId: string,
  texts: T,
  options: WhiteLabelListingOptions = {},
): Cleaned<T> {
  if (listing.agencyId === viewerAgencyId) {
    const own = options.own;
    return (own ? texts.map((t) => (t === null ? null : own(t))) : [...texts]) as Cleaned<T>;
  }
  const matcher = owner?.matcher ?? compileOwner(NO_OWNER);
  const refs = ownerRefsOf(listing);
  return texts.map((t) => (t === null ? null : whiteLabelText(t, matcher, refs, owner?.removals))) as Cleaned<T>;
}

/**
 * A listing's texts as a viewer agency may show them to a client: another agency's listing loses its owner's identity,
 * its own references and the cached model removals (one statement and one redis-cache MGET, none for the viewer's
 * own listing). Nulls stay null; the result is plain text (escape it when rendering).
 */
export async function whiteLabelListingText<T extends Texts>(
  tx: Tx,
  listing: WhiteLabelListing,
  viewerAgencyId: string,
  texts: T,
  options: WhiteLabelListingOptions = {},
): Promise<Cleaned<T>> {
  if (listing.agencyId === viewerAgencyId)
    return whiteLabelListingTextWith(null, listing, viewerAgencyId, texts, options);
  const identity = (await agencies.ownerIdentities(tx, [listing.agencyId])).get(listing.agencyId) ?? NO_OWNER;
  const removals = (await readAiRemovals([{ agencyId: listing.agencyId, targetId: listing.id }])).get(listing.id);
  return whiteLabelListingTextWith({ matcher: compileOwner(identity), removals }, listing, viewerAgencyId, texts);
}
