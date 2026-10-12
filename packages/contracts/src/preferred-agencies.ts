import { z } from 'zod';
import { AgencyKind } from './agencies';
import { pageOf } from './common';

/**
 * Preferred agencies (S1-07, PLAN §3 #57): an agency's trusted partners. Listings shared to PREFERRED
 * reach only them (S3-02); network search can filter by the list. Admins of a verified agency add
 * verified agencies; the note is internal and never shown to the partner.
 */

/**
 * Most preferred agencies one agency keeps (a trust list, not a directory copy). The guard trigger on
 * `preferred_agencies` (migration 0022) enforces the same number for direct writes: change both together.
 */
export const MAX_PREFERRED_AGENCIES = 200;
export const PREFERRED_AGENCY_NOTE_MAX = 1000;

/** The internal note: trimmed, 1–1000 characters; empty means none. */
export const PreferredAgencyNote = z
  .string()
  .trim()
  .max(PREFERRED_AGENCY_NOTE_MAX)
  .transform((v) => (v === '' ? null : v))
  .nullable();

/** A partner on the list. `listed`: the partner is verified now (it receives PREFERRED shares only then). */
export const PreferredAgencyDto = z.object({
  agencyId: z.uuid(),
  /** The directory name; the name when added if the partner left the directory. */
  name: z.string(),
  kind: AgencyKind.nullable(),
  listed: z.boolean(),
  note: z.string().nullable(),
  addedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type PreferredAgencyDto = z.infer<typeof PreferredAgencyDto>;
export const PreferredAgencyPage = pageOf(PreferredAgencyDto);
export type PreferredAgencyPage = z.infer<typeof PreferredAgencyPage>;

/** `POST /v1/agency/preferred-agencies`: add a verified agency found in the directory. */
export const AddPreferredAgencyBody = z.object({ agencyId: z.uuid(), note: PreferredAgencyNote.optional() }).strict();
export type AddPreferredAgencyBody = z.infer<typeof AddPreferredAgencyBody>;

/** `PATCH /v1/agency/preferred-agencies/:agencyId`: replace the note (null clears it). */
export const UpdatePreferredAgencyBody = z.object({ note: PreferredAgencyNote }).strict();
export type UpdatePreferredAgencyBody = z.infer<typeof UpdatePreferredAgencyBody>;

export const PreferredAgencyParams = z.object({ agencyId: z.uuid() });
export type PreferredAgencyParams = z.infer<typeof PreferredAgencyParams>;

/**
 * `GET /v1/agency-directory?q=`: verified agencies whose name contains `q` (case-insensitive), at most
 * 20, by name. Name and kind only — the directory never shows tax ids, addresses or contacts.
 */
export const DirectorySearchQuery = z.object({ q: z.string().trim().min(3).max(80) });
export type DirectorySearchQuery = z.infer<typeof DirectorySearchQuery>;
export const DIRECTORY_SEARCH_LIMIT = 20;

export const DirectoryAgencyDto = z.object({
  agencyId: z.uuid(),
  name: z.string(),
  kind: AgencyKind,
  /** Already on the caller's preferred list. */
  preferred: z.boolean(),
});
export type DirectoryAgencyDto = z.infer<typeof DirectoryAgencyDto>;
export const DirectorySearchResult = z.object({ items: z.array(DirectoryAgencyDto) });
export type DirectorySearchResult = z.infer<typeof DirectorySearchResult>;
