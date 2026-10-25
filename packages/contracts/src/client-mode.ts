import { z } from 'zod';

/**
 * Client Mode (S12-06, PLAN §3 #56): the agent shows the dashboard to a buyer. The session carries the flag, every
 * access token minted from it carries `cm`, and the API answers as `ctx.clientMode`: policies refuse everything but a
 * few reads (`CLIENT_MODE_ALLOWED` per module) and the serializers of those reads drop commission, the owner agency,
 * internal notes and private fields. Leaving needs the PIN set on entry.
 */

/** A Client Mode PIN: digits only. The agency's policy sets the minimum length (4–8). */
export const CLIENT_MODE_PIN_MAX_LENGTH = 12;
export const ClientModePin = z.string().regex(/^\d+$/).min(4).max(CLIENT_MODE_PIN_MAX_LENGTH);

/** `POST /v1/session/client-mode`: the PIN that will end Client Mode. */
export const StartClientModeBody = z.object({ pin: ClientModePin }).strict();
export type StartClientModeBody = z.infer<typeof StartClientModeBody>;

/**
 * A short-lived, signed hand-over for the web session (never shown to anybody): the web app's session callback
 * checks it and stores the PIN's hash in the encrypted session cookie.
 */
export const StartClientModeDto = z.object({ proof: z.string(), expiresAt: z.iso.datetime() });
export type StartClientModeDto = z.infer<typeof StartClientModeDto>;

/**
 * Response fields that never leave the API in Client Mode (the dashboard API's safety net, S12-06): a non-empty value
 * is replaced (arrays by `[]`, anything else by `null`) and logged. The serializers already drop them — the net
 * catches a field a new serializer forgets. Generic names (`agencyId`, `ownerUserId`) cannot be listed: the
 * serializers null them for network records only (an own record's agency is the viewer's own).
 */
export const CLIENT_MODE_STRIPPED_FIELDS: ReadonlySet<string> = new Set([
  // commission and split
  'commission',
  'commissionBp',
  'commissionFixed',
  'splitBp',
  'defaultCommission',
  'defaultSplitBp',
  'minCommissionBp',
  // the owner agency and the agencies behind a deal
  'ownerAgency',
  'ownerAgencyId',
  'ownerAcceptedByUserId',
  'introducerAgencyId',
  'introducerName',
  'introducerAcceptedByUserId',
  'counterpartAgencyId',
  'counterpartName',
  'presentingAgencyId',
  'allowedAgencyIds',
  // internal notes and labels
  'internalNotes',
  'confidentialNotes',
  'note',
  'tags',
  // private fields (exact address, owner contacts) and credentials
  'private',
  'secret',
  'credentialKeys',
  // S12-06 review: contact details, addresses, references and the owner's own codes, wherever a DTO carries them
  'cadastralRef',
  'keysInfo',
  'externalRef',
  'address',
  'addressLine',
  'agencyName',
  'email',
  'emails',
  'emailUrl',
  'emailSenderName',
  'primaryEmail',
  'contactEmail',
  'phone',
  'phones',
  'primaryPhone',
  'contactPhone',
]);

/**
 * Response field names that look sensitive: each one a dashboard route can return must be in
 * `CLIENT_MODE_STRIPPED_FIELDS` or reviewed in `CLIENT_MODE_REVIEWED_FIELDS` (the contract test over all routes).
 */
export const CLIENT_MODE_SENSITIVE_FIELD =
  /commission|split|note|private|confidential|secret|owner|introducer|counterpart|presenting|allowedAgenc|tags$|cadastral|keys|phone|email|address|agencyName|vendor|seller|externalRef/i;

/** Sensitive-looking names that are safe as they are, and why (reviewed for S12-06). */
export const CLIENT_MODE_REVIEWED_FIELDS: Readonly<Record<string, string>> = {
  ownerUserId: 'the agent of an own record; serializers null it on network records',
  ownerAcceptedAt: 'a timestamp of an MLS viewing (MLS routes are refused in Client Mode)',
  introducerAcceptedAt: 'a timestamp of an MLS viewing (MLS routes are refused in Client Mode)',
};

/**
 * Replaces the values of `CLIENT_MODE_STRIPPED_FIELDS` anywhere in a JSON value (in place) and returns the paths it
 * changed (empty when the serializers already stripped everything).
 */
export function stripClientModeFields(value: unknown, path = '$', changed: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      stripClientModeFields(v, `${path}[${i}]`, changed);
    });
  } else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const [key, v] of Object.entries(record)) {
      if (CLIENT_MODE_STRIPPED_FIELDS.has(key)) {
        if (Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined) {
          record[key] = Array.isArray(v) ? [] : null;
          changed.push(`${path}.${key}`);
        }
      } else {
        stripClientModeFields(v, `${path}.${key}`, changed);
      }
    }
  }
  return changed;
}
