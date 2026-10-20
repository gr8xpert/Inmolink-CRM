/**
 * The agency as public pages present it (S7-02, PLAN §3 #6, §9.1): its directory name, brand colours and the
 * contact details it publishes (`agency_profiles`). Read as `app_public` (`withPublicRead`; feed-api, before any
 * tenant session): only listed agencies (VERIFIED, in the directory) — the registry's public predicates on
 * `agency_directory` and `agency_profiles`.
 */
import type { Tx } from '@inmolink/db';
import * as repo from './preferred-repo';

export type PublicAgency = repo.PublicAgencyRow;

/** Listed agencies' public presentation, by id (one statement); unlisted or unknown ids are absent. */
export async function publicAgencies(tx: Tx, ids: readonly string[]): Promise<Map<string, PublicAgency>> {
  const rows = await repo.publicAgencies(tx, [...new Set(ids)]);
  return new Map(rows.map((r) => [r.agencyId, r]));
}

/** Who an agency is, as the white-label sanitizer removes it from network listings' text (S7-02). */
export interface OwnerIdentity {
  names: string[];
  emails: string[];
  phones: string[];
  /** Website host names, without `www.`. */
  hosts: string[];
}

/** Legal-form suffixes dropped to find the name an agency goes by ("Costa Homes S.L." → "Costa Homes"). */
const LEGAL_FORM =
  /[\s,]+(?:s\.?\s?l\.?\s?u?\.?|s\.?\s?a\.?|s\.?\s?l\.?\s?n\.?\s?e\.?|s\.?\s?c\.?|c\.?\s?b\.?|ltd\.?|limited|llc|gmbh|b\.?v\.?|inc\.?|plc)\s*$/i;

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/**
 * Owners' identities for the white-label sanitizer (S7-02): directory name (and the name without its legal form),
 * published contact e-mail and phone, website host — of any agency, listed or not, so a document of an owner that
 * left the directory is still cleaned. One statement; reads as `app_public`.
 */
export async function ownerIdentities(tx: Tx, ids: readonly string[]): Promise<Map<string, OwnerIdentity>> {
  const rows = await repo.ownerIdentityRows(tx, [...new Set(ids)]);
  return new Map(
    rows.map((r) => {
      const names = new Set<string>();
      if (r.name) {
        names.add(r.name.trim());
        const short = r.name.replace(LEGAL_FORM, '').trim();
        if (short.length >= 4) names.add(short);
      }
      const host = hostOf(r.website);
      return [
        r.agencyId,
        {
          names: [...names],
          emails: r.email ? [r.email] : [],
          phones: r.phone ? [r.phone] : [],
          hosts: host ? [host] : [],
        },
      ];
    }),
  );
}
