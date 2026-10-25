import { createHmac } from 'node:crypto';
import { SafeFetchError, type SafeFetchOptions, safeFetch } from '@inmolink/platform/safe-fetch';
import type { MetaAppConfig } from './config';

/**
 * The Meta Graph API client of social posting (S12-07, PLAN §3 #58). Every request goes through `platform/safe-fetch`
 * (public addresses only, no redirects for writes, size and time caps). Tokens travel in the form body or query of a
 * request to Meta only, with `appsecret_proof`; they are never logged, and responses are parsed but never stored
 * whole. Sandbox or production is only configuration (`MetaAppConfig`): tests run it against a fake Graph server.
 *
 * Errors are `MetaError`s: `TOKEN_EXPIRED` (OAuth error 190: expired, revoked or a changed password — the account
 * needs reconnecting), `RATE_LIMITED` and `UNAVAILABLE` (retry later), `REJECTED` (the request itself: image, caption,
 * permissions). `ambiguous`: the request that would have created the post may or may not have reached Meta (a timeout
 * or a dropped connection on the publishing call) — the caller never retries it blindly.
 */

export type MetaErrorKind = 'TOKEN_EXPIRED' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'REJECTED' | 'NETWORK';

export class MetaError extends Error {
  override readonly name = 'MetaError';
  constructor(
    readonly kind: MetaErrorKind,
    /** Meta's own message (shown in the post's history), or ours. */
    message: string,
    readonly retryable: boolean,
    readonly ambiguous = false,
  ) {
    super(message);
  }
}

export interface MetaPage {
  id: string;
  name: string;
  accessToken: string;
  instagram: { id: string; username: string } | null;
}

export interface MetaToken {
  accessToken: string;
  /** Seconds until it expires, when Meta says. */
  expiresIn: number | null;
}

/** Permissions the login dialog asks for: list the Pages, post to them, and publish to their Instagram accounts. */
export const META_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'instagram_basic',
  'instagram_content_publish',
  'business_management',
] as const;

const MAX_RESPONSE_BYTES = 512 * 1024;
const TIMEOUT_MS = 20_000;
/** Meta's throttling codes (application, user, Page and rate limits). */
const THROTTLE_CODES = new Set([4, 17, 32, 341, 613, 80001, 80002]);

interface Exchange {
  status: number;
  json: Record<string, unknown> | null;
}

export class MetaGraphClient {
  constructor(
    private readonly app: MetaAppConfig,
    private readonly fetchOptions: Pick<SafeFetchOptions, 'resolver'> = {},
  ) {}

  /** The login dialog's URL for `state` (the member is sent there; Meta comes back to `redirectUri`). */
  dialogUrl(state: string): string {
    const u = new URL(`${this.app.dialogUrl.replace(/\/+$/, '')}/${this.app.graphVersion}/dialog/oauth`);
    u.searchParams.set('client_id', this.app.appId);
    u.searchParams.set('redirect_uri', this.app.redirectUri);
    u.searchParams.set('state', state);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', META_SCOPES.join(','));
    return u.toString();
  }

  /** The OAuth code → a short-lived user token → a long-lived one (about 60 days). */
  async userTokenFromCode(code: string): Promise<MetaToken> {
    const short = await this.#get('/oauth/access_token', {
      client_id: this.app.appId,
      client_secret: this.app.appSecret,
      redirect_uri: this.app.redirectUri,
      code,
    });
    return this.longLivedUserToken(tokenOf(short));
  }

  /** A long-lived user token for `userToken` (also refreshes a long-lived one before it expires). */
  async longLivedUserToken(userToken: string): Promise<MetaToken> {
    const res = await this.#get('/oauth/access_token', {
      grant_type: 'fb_exchange_token',
      client_id: this.app.appId,
      client_secret: this.app.appSecret,
      fb_exchange_token: userToken,
    });
    const expiresIn = typeof res.expires_in === 'number' && res.expires_in > 0 ? res.expires_in : null;
    return { accessToken: tokenOf(res), expiresIn };
  }

  /** The Pages the user manages, with their Page tokens and the Instagram Business account of each (at most 100). */
  async pages(userToken: string): Promise<MetaPage[]> {
    const res = await this.#get('/me/accounts', {
      fields: 'id,name,access_token,instagram_business_account{id,username}',
      limit: '100',
      access_token: userToken,
      appsecret_proof: this.#proof(userToken),
    });
    const data = Array.isArray(res.data) ? res.data : [];
    const pages: MetaPage[] = [];
    for (const raw of data as Record<string, unknown>[]) {
      const ig = raw.instagram_business_account as Record<string, unknown> | undefined;
      if (typeof raw.id !== 'string' || typeof raw.access_token !== 'string') continue;
      pages.push({
        id: raw.id,
        name: typeof raw.name === 'string' && raw.name ? raw.name.slice(0, 200) : raw.id,
        accessToken: raw.access_token,
        instagram:
          ig && typeof ig.id === 'string'
            ? {
                id: ig.id,
                username: typeof ig.username === 'string' && ig.username ? ig.username.slice(0, 200) : ig.id,
              }
            : null,
      });
    }
    return pages;
  }

  /**
   * A Facebook Page post: one image as a photo post, several as unpublished photos attached to one feed post. Only the
   * final call creates the post (it is the ambiguous one).
   */
  async publishFacebook(pageId: string, pageToken: string, post: { caption: string; imageUrls: string[] }) {
    const auth = { access_token: pageToken, appsecret_proof: this.#proof(pageToken) };
    if (post.imageUrls.length === 1) {
      const res = await this.#post(
        `/${pageId}/photos`,
        { ...auth, url: post.imageUrls[0] as string, message: post.caption },
        true,
      );
      return { externalId: idOf(res.post_id ?? res.id, true) };
    }
    const media: string[] = [];
    for (const url of post.imageUrls) {
      media.push(idOf((await this.#post(`/${pageId}/photos`, { ...auth, url, published: 'false' }, false)).id));
    }
    const fields: Record<string, string> = { ...auth, message: post.caption };
    media.forEach((id, i) => {
      fields[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id });
    });
    return { externalId: idOf((await this.#post(`/${pageId}/feed`, fields, true)).id, true) };
  }

  /**
   * An Instagram post: a media container (one image) or a carousel of item containers, then `media_publish` — the
   * only call that publishes (the ambiguous one).
   */
  async publishInstagram(igUserId: string, pageToken: string, post: { caption: string; imageUrls: string[] }) {
    const auth = { access_token: pageToken, appsecret_proof: this.#proof(pageToken) };
    let creationId: string;
    if (post.imageUrls.length === 1) {
      creationId = idOf(
        (
          await this.#post(
            `/${igUserId}/media`,
            { ...auth, image_url: post.imageUrls[0] as string, caption: post.caption },
            false,
          )
        ).id,
      );
    } else {
      const children: string[] = [];
      for (const url of post.imageUrls) {
        children.push(
          idOf(
            (await this.#post(`/${igUserId}/media`, { ...auth, image_url: url, is_carousel_item: 'true' }, false)).id,
          ),
        );
      }
      creationId = idOf(
        (
          await this.#post(
            `/${igUserId}/media`,
            { ...auth, media_type: 'CAROUSEL', children: children.join(','), caption: post.caption },
            false,
          )
        ).id,
      );
    }
    const published = await this.#post(`/${igUserId}/media_publish`, { ...auth, creation_id: creationId }, true);
    return { externalId: idOf(published.id, true) };
  }

  #proof(token: string): string {
    return createHmac('sha256', this.app.appSecret).update(token).digest('hex');
  }

  #url(path: string): string {
    return `${this.app.graphUrl.replace(/\/+$/, '')}/${this.app.graphVersion}${path}`;
  }

  async #get(path: string, query: Record<string, string>): Promise<Record<string, unknown>> {
    const u = new URL(this.#url(path));
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return checked(await this.#send('GET', u.toString(), undefined, false), false);
  }

  async #post(path: string, fields: Record<string, string>, publishing: boolean): Promise<Record<string, unknown>> {
    const body = new URLSearchParams(fields).toString();
    return checked(await this.#send('POST', this.#url(path), body, publishing), publishing);
  }

  async #send(method: 'GET' | 'POST', url: string, body: string | undefined, publishing: boolean): Promise<Exchange> {
    try {
      const res = await safeFetch(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
        },
        ...(body === undefined ? {} : { body }),
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_RESPONSE_BYTES,
        ...this.fetchOptions,
      });
      const text = await res.text();
      let json: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = text ? JSON.parse(text) : null;
        json = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
      } catch {
        json = null;
      }
      return { status: res.status, json };
    } catch (err) {
      if (err instanceof SafeFetchError && (err.code === 'BLOCKED_DESTINATION' || err.code === 'INVALID_URL')) {
        throw new MetaError('REJECTED', 'Meta endpoint refused by safe-fetch', false);
      }
      // A write that may have reached Meta: its outcome is unknown.
      throw new MetaError('NETWORK', 'Meta did not answer', true, publishing);
    }
  }
}

/** The response's data, or the Meta error it carries. */
function checked(res: Exchange, publishing: boolean): Record<string, unknown> {
  if (res.status >= 200 && res.status < 300 && res.json && !res.json.error) return res.json;
  const error = (res.json?.error ?? {}) as {
    code?: unknown;
    error_subcode?: unknown;
    message?: unknown;
    type?: unknown;
  };
  const message = typeof error.message === 'string' ? error.message.slice(0, 500) : `Meta answered ${res.status}`;
  const code = typeof error.code === 'number' ? error.code : null;
  if (code === 190 || (error.type === 'OAuthException' && res.status === 401)) {
    throw new MetaError('TOKEN_EXPIRED', message, false);
  }
  if ((code !== null && THROTTLE_CODES.has(code)) || res.status === 429)
    throw new MetaError('RATE_LIMITED', message, true);
  // A server error on the publishing call may come after the post was made: its outcome is unknown.
  if (code === 1 || code === 2 || res.status >= 500) throw new MetaError('UNAVAILABLE', message, true, publishing);
  throw new MetaError('REJECTED', message, false);
}

function tokenOf(res: Record<string, unknown>): string {
  if (typeof res.access_token !== 'string' || res.access_token.length === 0) {
    throw new MetaError('REJECTED', 'Meta answered without an access token', false);
  }
  return res.access_token;
}

/** An id Meta answered with; on the publishing call a missing one leaves the outcome unknown (`ambiguous`). */
function idOf(value: unknown, publishing = false): string {
  if (typeof value !== 'string' || !/^[0-9_]{1,64}$/.test(value)) {
    throw new MetaError('REJECTED', 'Meta answered without an id', false, publishing);
  }
  return value;
}
