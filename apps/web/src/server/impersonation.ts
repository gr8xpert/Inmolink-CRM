import type { ImpersonationDto } from '@inmolink/contracts';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { webConfig } from './env';

/**
 * The staff member's open impersonation session, as the browser remembers it (S1-09): an httpOnly,
 * SameSite=Strict cookie (`__Host-` in production) that lives until the session expires. It holds only
 * what the banner shows and the session id; it grants nothing by itself — the access-token mint checks
 * the session is the signed-in staff member's and still live, and the API re-checks it on every request.
 * `ended` (S17-F46): the API confirmed the session is over. The cookie then only feeds the "session ended, dismiss"
 * banner: no token is minted from it, so the browser is the staff member again, not a member.
 */
const Stored = z.object({
  id: z.uuid(),
  staffUserId: z.uuid(),
  agencyId: z.uuid(),
  agencyName: z.string().max(200),
  userName: z.string().max(200),
  expiresAt: z.iso.datetime(),
  ended: z.literal(true).optional(),
});
export type StoredImpersonation = z.infer<typeof Stored>;

async function cookieSpec() {
  const secure = (await webConfig()).WEB_URL.startsWith('https://');
  return {
    name: `${secure ? '__Host-' : ''}inmolink.impersonation`,
    options: { httpOnly: true, secure, sameSite: 'strict' as const, path: '/' },
  };
}

/** Whether this browser holds an impersonation cookie at all (cheap: no session lookup). */
export async function hasImpersonationCookie(): Promise<boolean> {
  return (await cookies()).has((await cookieSpec()).name);
}

/**
 * The stored session for this staff user, or null (none, unreadable, another user's). A session that is over (expired,
 * or marked ended) only comes back with `includeEnded`: what acts on the session (the mint, S17-F46) never sees it.
 */
export async function readImpersonation(
  staffUserId: string,
  opts: { includeEnded?: boolean } = {},
): Promise<StoredImpersonation | null> {
  const { name } = await cookieSpec();
  const raw = (await cookies()).get(name)?.value;
  if (!raw) return null;
  try {
    const parsed = Stored.safeParse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    if (!parsed.success || parsed.data.staffUserId !== staffUserId) return null;
    if (opts.includeEnded) return parsed.data;
    return !parsed.data.ended && Date.parse(parsed.data.expiresAt) > Date.now() ? parsed.data : null;
  } catch {
    return null;
  }
}

async function storeImpersonation(value: StoredImpersonation): Promise<void> {
  const { name, options } = await cookieSpec();
  (await cookies()).set(name, Buffer.from(JSON.stringify(value)).toString('base64url'), {
    ...options,
    expires: new Date(value.expiresAt),
  });
}

/** Server actions only (cookies are read-only while rendering). */
export async function rememberImpersonation(staffUserId: string, dto: ImpersonationDto): Promise<void> {
  await storeImpersonation({
    id: dto.id,
    staffUserId,
    agencyId: dto.agencyId,
    agencyName: dto.agencyName.slice(0, 200),
    userName: dto.userName.slice(0, 200),
    expiresAt: dto.expiresAt,
  });
}

/**
 * Route handlers only (S17-F46), once the API confirmed the session is over: nothing mints from the cookie any more,
 * and the banner can still say whose session ended. It keeps the session's own expiry: an expired one simply goes.
 */
export async function markImpersonationEnded(stored: StoredImpersonation): Promise<void> {
  await storeImpersonation({ ...stored, ended: true });
}

/** Server actions and route handlers only. */
export async function forgetImpersonation(): Promise<void> {
  const { name, options } = await cookieSpec();
  (await cookies()).set(name, '', { ...options, maxAge: 0 });
}
