import { DEFAULT_TIME_ZONE } from '@inmolink/i18n';
import { cache } from 'react';
import { fetchAgencySettings, type SessionRef } from '@/server/api';

/**
 * The signed-in member's agency time zone (S11-F11), or null when the settings cannot be read. Any member reads the
 * settings; cached per request, so a page that asks twice reads once. Actions that turn a typed local time into an
 * instant use this and refuse when it is null (guessing a zone would store the wrong instant).
 */
export const readAgencyTimeZone = cache(async (session: SessionRef): Promise<string | null> => {
  const res = await fetchAgencySettings(session);
  return res !== 'revoked' && res.ok ? res.data.timeZone : null;
});

/** For read-only pages: the agency's zone, or the platform's when the settings cannot be read. */
export async function agencyTimeZone(session: SessionRef): Promise<string> {
  return (await readAgencyTimeZone(session)) ?? DEFAULT_TIME_ZONE;
}
