import { hmacSha256, hmacSha256Candidates } from '@inmolink/platform/crypto';

/**
 * Boot configuration (api and public pages): the key selection tokens are hashed with (`HMAC_KEY`, purpose
 * `presentations.selection-token`) and the public pages' origin share links point at (`PUBLIC_PAGES_URL`; absent:
 * links carry the path only).
 */
export interface PresentationsConfig {
  tokenKey: string;
  publicBaseUrl?: string | null;
}

let current: { tokenKey: Buffer; publicBaseUrl: string | null } | undefined;

export function configurePresentations(options: PresentationsConfig): void {
  if (!options.tokenKey) throw new Error('presentations: tokenKey is required');
  const base = options.publicBaseUrl ? options.publicBaseUrl.replace(/\/+$/, '') : null;
  if (base && !/^https?:\/\/[^/]+$/.test(base)) throw new Error('presentations: publicBaseUrl must be an origin');
  current = { tokenKey: Buffer.from(options.tokenKey), publicBaseUrl: base };
}

function configured() {
  if (!current) throw new Error('presentations: configurePresentations() was not called');
  return current;
}

const TOKEN_PURPOSE = 'presentations.selection-token';

/** The hash a selection token is stored and looked up as. */
export const selectionTokenHash = (token: string): string => hmacSha256(configured().tokenKey, TOKEN_PURPOSE, token);

/** The hashes a presented token may be stored under (S11-F13: the previous `HMAC_KEY`'s too, inside a rotation). */
export const selectionTokenHashCandidates = (token: string): string[] =>
  hmacSha256Candidates(configured().tokenKey, TOKEN_PURPOSE, token);

export const publicBaseUrl = (): string | null => configured().publicBaseUrl;

/** Where a selection's page is served on the public pages host. */
export const selectionPath = (token: string): string => `/s/${token}`;

/** A token as the page URL carries it: 32 random bytes, base64url (43 characters). */
export const SELECTION_TOKEN = /^[A-Za-z0-9_-]{43}$/;
