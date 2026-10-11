'use server';

import { InvitableRole, InviteMemberBody, InviteParams, MemberParams } from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import { type ApiResult, changeMemberRole, deactivateMember, inviteMember, revokeInvite } from '@/server/api';

/**
 * Team form actions (transport only, S1-02): validate with the contracts, call the API, and come back
 * to the team page with a notice or an error code (i18n keys under `team.notices` / `team.errors`).
 * Plain forms: they work without JavaScript.
 */
const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v : undefined;
};

async function back(query: Record<string, string>): Promise<never> {
  const path = getPathname({ href: '/team', locale: await getLocale() });
  redirect(`${path}?${new URLSearchParams(query)}`);
}

async function session() {
  const s = await auth();
  if (!s?.user?.id) redirect('/session/expired');
  return { userId: s.user.id, sessionVersion: s.user.sessionVersion };
}

const KNOWN_ERRORS = ['FORBIDDEN', 'NOT_FOUND', 'ALREADY_MEMBER', 'VALIDATION_FAILED', 'RATE_LIMITED'] as const;

async function finish(res: ApiResult<unknown>, notice: string): Promise<never> {
  if (res === 'revoked') redirect('/session/expired');
  if (res.ok) return back({ notice });
  const code = KNOWN_ERRORS.find((c) => c === res.error?.code) ?? 'generic';
  return back({ error: code });
}

export async function inviteAction(form: FormData): Promise<void> {
  const parsed = InviteMemberBody.safeParse({ email: text(form, 'email'), role: text(form, 'role') });
  if (!parsed.success) return back({ error: 'VALIDATION_FAILED' });
  const s = await session();
  return finish(await inviteMember(s, { ...parsed.data, locale: text(form, 'locale') || undefined }), 'invited');
}

export async function changeRoleAction(form: FormData): Promise<void> {
  const params = MemberParams.safeParse({ userId: text(form, 'userId') });
  const role = InvitableRole.safeParse(text(form, 'role'));
  if (!params.success || !role.success) return back({ error: 'VALIDATION_FAILED' });
  const s = await session();
  return finish(await changeMemberRole(s, params.data.userId, role.data), 'roleChanged');
}

export async function deactivateAction(form: FormData): Promise<void> {
  const params = MemberParams.safeParse({ userId: text(form, 'userId') });
  if (!params.success) return back({ error: 'VALIDATION_FAILED' });
  const s = await session();
  return finish(await deactivateMember(s, params.data.userId), 'deactivated');
}

export async function revokeInviteAction(form: FormData): Promise<void> {
  const params = InviteParams.safeParse({ inviteId: text(form, 'inviteId') });
  if (!params.success) return back({ error: 'VALIDATION_FAILED' });
  const s = await session();
  return finish(await revokeInvite(s, params.data.inviteId), 'revoked');
}
