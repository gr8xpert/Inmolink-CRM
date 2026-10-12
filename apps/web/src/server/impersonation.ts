import type { ImpersonationDto } from '@inmolink/contracts';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { webConfig } from './env';

/**
 * The staff member's open impersonation session, as the browser remembers it (S1-09): an httpOnly,
 * SameSite=Strict cookie (`__Host-` in production) that lives until the session expires. It holds only
 * what the banner shows and the session id; it grants nothing by itself — the access-token mint checks
 * the session is the signed-in staff member's and still live, and the API re-checks it on every request.
 */
const Stored = z.object({
  id: z.uuid(),
  staffUserId: z.uuid(),
  agencyId: z.uuid(),
  agencyName: z.string().max(200),
  userName: z.string().max(200),
  expiresAt: z.iso.datetime(),
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

/** The stored session for this staff user, or null (none, unreadable, another user's, or expired unless asked). */
export async function readImpersonation(
  staffUserId: string,
  opts: { includeExpired?: boolean } = {},
): Promise<StoredImpersonation | null> {
  const { name } = await cookieSpec();
  const raw = (await cookies()).get(name)?.value;
  if (!raw) return null;
  try {
    const parsed = Stored.safeParse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    if (!parsed.success || parsed.data.staffUserId !== staffUserId) return null;
    return opts.includeExpired || Date.parse(parsed.data.expiresAt) > Date.now() ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Server actions only (cookies are read-only while rendering). */
export async function rememberImpersonation(staffUserId: string, dto: ImpersonationDto): Promise<void> {
  const { name, options } = await cookieSpec();
  const value: StoredImpersonation = {
    id: dto.id,
    staffUserId,
    agencyId: dto.agencyId,
    agencyName: dto.agencyName.slice(0, 200),
    userName: dto.userName.slice(0, 200),
    expiresAt: dto.expiresAt,
  };
  (await cookies()).set(name, Buffer.from(JSON.stringify(value)).toString('base64url'), {
    ...options,
    expires: new Date(dto.expiresAt),
  });
}

/** Server actions and route handlers only. */
export async function forgetImpersonation(): Promise<void> {
  const { name, options } = await cookieSpec();
  (await cookies()).set(name, '', { ...options, maxAge: 0 });
}
