import { hmacSha256, type Keyring, rowCipher } from '@inmolink/platform/crypto';
import type { SafeFetchOptions } from '@inmolink/platform/safe-fetch';
import { z } from 'zod';

/**
 * Process settings for social posting (S12-07), set once at boot (api: encrypts tokens when an account is connected and
 * exchanges the OAuth code; worker: decrypts them to publish and refresh). Configuration only — never tenant or user
 * state (CLAUDE.md rule 4). Without `meta` (no Meta app yet, H3) connecting answers `SOCIAL_NOT_ENABLED`.
 */
export interface MetaAppConfig {
  /** `META_APP_ID` / `META_APP_SECRET` (H3: the Meta developer app; app review for Pages and Instagram publishing). */
  appId: string;
  appSecret: string;
  /** `META_GRAPH_URL` (production `https://graph.facebook.com`; a sandbox or fake in tests), no trailing slash. */
  graphUrl: string;
  /** `META_DIALOG_URL`: the OAuth login dialog's host (production `https://www.facebook.com`). */
  dialogUrl: string;
  /** `META_GRAPH_VERSION`, e.g. `v21.0`. */
  graphVersion: string;
  /** `SOCIAL_OAUTH_REDIRECT_URL`: the web app's callback (`<WEB_URL>/social/callback`), registered with the Meta app. */
  redirectUri: string;
}

export interface SocialConfig {
  /** `ENCRYPTION_KEYS` / `ENCRYPTION_ACTIVE_KEY_ID` (platform/crypto): Page and user tokens are stored encrypted. */
  keyring?: Keyring;
  /** `HMAC_KEY`: the OAuth `state` is signed with it (purpose `social.oauth-state`). */
  stateKey: string;
  meta?: MetaAppConfig;
  /** `MEDIA_CDN_URL` (worker): the public image URLs Meta fetches (`<base>/<variant key>`). */
  mediaBaseUrl?: string;
  /** Tests: options handed to safe-fetch (fixture servers). */
  fetchOptions?: Pick<SafeFetchOptions, 'resolver'>;
}

let current: SocialConfig | undefined;

export function configureSocial(config: SocialConfig): void {
  if (!config.stateKey) throw new Error('social: stateKey is required');
  if (config.meta) {
    for (const k of ['appId', 'appSecret', 'graphUrl', 'dialogUrl', 'graphVersion', 'redirectUri'] as const) {
      if (!config.meta[k]) throw new Error(`social: meta.${k} is required`);
    }
  }
  current = config;
}

export function socialConfig(): SocialConfig {
  if (!current) throw new Error('social is not configured (call configureSocial at boot)');
  return current;
}

/** The Meta app, or null when it is not configured (H3). */
export const metaApp = (): MetaAppConfig | null => current?.meta ?? null;

function keyring(): Keyring {
  const k = socialConfig().keyring;
  if (!k) throw new Error('social: no keyring configured (tokens cannot be encrypted or decrypted here)');
  return k;
}

/** A social account's Page access token, encrypted and bound to (agency, table, column, row). */
export const pageTokenCipher = rowCipher('social_accounts', 'token_enc', keyring, z.string().min(1));
/** The long-lived user token the Page token came from (refreshes it). */
export const userTokenCipher = rowCipher('social_accounts', 'user_token_enc', keyring, z.string().min(1));

/** HMAC of an OAuth state's payload. */
export const stateMac = (payload: string): string => hmacSha256(socialConfig().stateKey, 'social.oauth-state', payload);

/** The Meta app from `socialEnv` values, or undefined until H3 provides its id, secret and redirect URL. */
export function metaAppFromEnv(env: {
  META_APP_ID?: string | undefined;
  META_APP_SECRET?: string | undefined;
  META_GRAPH_URL: string;
  META_DIALOG_URL: string;
  META_GRAPH_VERSION: string;
  SOCIAL_OAUTH_REDIRECT_URL?: string | undefined;
}): MetaAppConfig | undefined {
  if (!env.META_APP_ID || !env.META_APP_SECRET || !env.SOCIAL_OAUTH_REDIRECT_URL) return undefined;
  return {
    appId: env.META_APP_ID,
    appSecret: env.META_APP_SECRET,
    graphUrl: env.META_GRAPH_URL,
    dialogUrl: env.META_DIALOG_URL,
    graphVersion: env.META_GRAPH_VERSION,
    redirectUri: env.SOCIAL_OAUTH_REDIRECT_URL,
  };
}
