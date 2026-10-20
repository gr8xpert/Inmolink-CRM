/**
 * The agency as public pages present it (S7-02, PLAN §3 #6, §9.1): its directory name, brand colours and the
 * contact details it publishes (`agency_profiles`). Read as `app_public` (`withPublicRead`; feed-api, before any
 * tenant session): only listed agencies (VERIFIED, in the directory) — the registry's public predicates on
 * `agency_directory` and `agency_profiles`.
 */
import type { Tx } from '@inmolink/db';
import type { OwnerIdentity } from '../../white-label';
import * as repo from './preferred-repo';

export type PublicAgency = repo.PublicAgencyRow;

/** Listed agencies' public presentation, by id (one statement); unlisted or unknown ids are absent. */
export async function publicAgencies(tx: Tx, ids: readonly string[]): Promise<Map<string, PublicAgency>> {
  const rows = await repo.publicAgencies(tx, [...new Set(ids)]);
  return new Map(rows.map((r) => [r.agencyId, r]));
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
  return new Map(rows.map((r) => [r.agencyId, identityOf([r.name], [r.email], [r.phone], r.website)]));
}

/** A name and, when it differs and is long enough, the name without its legal form. */
function namesOf(name: string | null): string[] {
  if (!name?.trim()) return [];
  const out = [name.trim()];
  const short = name.replace(LEGAL_FORM, '').trim();
  if (short.length >= 4 && short !== out[0]) out.push(short);
  return out;
}

const present = (xs: readonly (string | null)[]) => [...new Set(xs.flatMap((x) => (x?.trim() ? [x.trim()] : [])))];

function identityOf(
  names: readonly (string | null)[],
  emails: readonly (string | null)[],
  phones: readonly (string | null)[],
  website: string | null,
): OwnerIdentity {
  const host = hostOf(website);
  return {
    names: present(names.flatMap(namesOf)),
    emails: present(emails),
    phones: present(phones),
    hosts: host ? [host] : [],
  };
}

/**
 * Owners' identities for the search index (S7-F5), fuller than `ownerIdentities`: the legal name and the directory
 * name (each with and without its legal form), the white-label e-mail sender name, the office address and the tax id
 * as names; the published e-mail, phone and website — of any agency, verified or not. No name history is kept (an
 * agency's earlier name is not removed). One statement; worker-only: raw `tx` under `withSystem`.
 */
export async function indexOwnerIdentities(tx: Tx, ids: readonly string[]): Promise<Map<string, OwnerIdentity>> {
  const rows = await repo.indexIdentityRows(tx, [...new Set(ids)]);
  return new Map(
    rows.map((r) => [
      r.agencyId,
      identityOf([r.name, r.directoryName, r.senderName, r.addressLine, r.taxId], [r.email], [r.phone], r.website),
    ]),
  );
}
