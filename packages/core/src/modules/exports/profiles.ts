/**
 * Portal profiles (S9-02, PLAN §7 M7): everything that differs between portals, as data — the file format a portal
 * reads and the thresholds a listing must meet to be sent. Writers and the validator read a profile; no threshold is
 * written anywhere else (CLAUDE.md "Never: hard-coded ... values"). Changing a portal's rules is a change here only.
 *
 * H6 (portal feed specifications and credentials) has not arrived. Kyero v3 is publicly documented; the specification
 * of thinkSPAIN and of A Place in the Sun is not (both say on their sites that they take feeds from property
 * software, and neither publishes the format). Their profiles therefore use the Kyero v3 format — the format the
 * Spanish portals have in common — with thresholds that are ASSUMED (marked `confirmed: false`), and their writers
 * stay behind a feature flag (`exports.portal.<code>`, off by default) until H6 confirms them: see `portalFlagKey`.
 * To confirm: replace `tests/fixtures/<portal>/portal-feed.xsd` with the portal's own schema, adjust the profile,
 * re-run `exports/__tests__/portal-feeds.int.test.ts`, then switch the flag on for the pilot agencies.
 */
import { type FlagCtx, flag } from '@inmolink/platform/flags';

/** The content locale a feed's base text is taken in when the agency has it; else its first locale. */
export const PORTAL_PREFERRED_LOCALE = 'en';

export type PortalFormat = 'kyero-v3' | 'generic-v1';

export interface PortalProfile {
  /** The `portal_channels.code` the profile belongs to. */
  code: string;
  format: PortalFormat;
  /** false: the format and thresholds are assumptions waiting for H6; the writer needs its feature flag. */
  confirmed: boolean;
  /** Schema fixture the tests validate the output against (relative to `tests/fixtures`). */
  schema: string;
  /** Photos (pictures and floor plans) a listing needs; fewer: left out. */
  minPhotos: number;
  /** Photos written at most (the rest are cut; never a reason to leave a listing out). Null: no cap. */
  maxPhotos: number | null;
  /** A description of at least this many characters, in at least one language (0: none needed). */
  minDescriptionChars: number;
  /** No description longer than this (null: no limit). */
  maxDescriptionChars: number | null;
  /** Spanish law (RD 390/2021) wants the energy label in every advert; `required` leaves out listings without one. */
  energyRating: 'required' | 'optional';
  /** A price on request cannot be shown by portals that sort and filter by price. */
  priceOnRequest: 'allowed' | 'refused';
}

export const PORTAL_PROFILES: Readonly<Record<string, PortalProfile>> = {
  kyero: {
    code: 'kyero',
    format: 'kyero-v3',
    confirmed: true,
    schema: 'kyero/kyero-v3.xsd',
    minPhotos: 1,
    // Kyero takes at most 50 photos per property (published by CRM partners).
    maxPhotos: 50,
    minDescriptionChars: 30,
    maxDescriptionChars: 20_000,
    energyRating: 'required',
    priceOnRequest: 'refused',
  },
  thinkspain: {
    code: 'thinkspain',
    format: 'kyero-v3',
    confirmed: false,
    schema: 'thinkspain/portal-feed.xsd',
    minPhotos: 3,
    maxPhotos: 50,
    minDescriptionChars: 50,
    maxDescriptionChars: 20_000,
    energyRating: 'required',
    priceOnRequest: 'refused',
  },
  'a-place-in-the-sun': {
    code: 'a-place-in-the-sun',
    format: 'kyero-v3',
    confirmed: false,
    schema: 'a-place-in-the-sun/portal-feed.xsd',
    minPhotos: 5,
    maxPhotos: 50,
    minDescriptionChars: 100,
    maxDescriptionChars: 20_000,
    energyRating: 'required',
    priceOnRequest: 'refused',
  },
  'generic-xml': {
    code: 'generic-xml',
    format: 'generic-v1',
    confirmed: true,
    schema: 'website-feed/inmolink-feed-v1.xsd',
    minPhotos: 0,
    maxPhotos: null,
    minDescriptionChars: 0,
    maxDescriptionChars: null,
    energyRating: 'optional',
    priceOnRequest: 'allowed',
  },
};

export const profileOf = (channelCode: string): PortalProfile | null => PORTAL_PROFILES[channelCode] ?? null;

/** The feature flag that lets an unconfirmed portal's writer run (per agency, staff-managed). */
export const portalFlagKey = (channelCode: string) => `exports.portal.${channelCode}`;

/**
 * Whether a connection's feed may be generated: its portal has a profile and, if the profile is not confirmed, the
 * flag is on for the agency. The generator (S9-03) asks before every run.
 */
export async function portalWriterEnabled(ctx: FlagCtx, profile: PortalProfile | null): Promise<boolean> {
  if (!profile) return false;
  return profile.confirmed || (await flag(ctx, portalFlagKey(profile.code)));
}
