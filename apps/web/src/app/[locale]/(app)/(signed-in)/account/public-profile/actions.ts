'use server';

import { MEMBER_PHOTO_MAX_BYTES, UpdateMemberPublicProfileBody } from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import { removeMyPublicProfilePhoto, saveMyPublicProfile, sessionRef, uploadMyPublicProfilePhoto } from '@/server/api';

/**
 * The member's portal profile (S15-F10, transport only): validate with the contract, call the API, come back to the
 * page with a notice or an error code (`team.publicProfile.notices` / `.errors`). Works without JavaScript.
 */

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

async function back(query: Record<string, string>): Promise<never> {
  const path = getPathname({ href: '/account/public-profile', locale: await getLocale() });
  redirect(`${path}?${new URLSearchParams(query)}`);
}

async function session() {
  const s = await auth();
  if (!s?.user?.id) redirect('/session/expired');
  return sessionRef(s.user);
}

const KNOWN = new Set(['UNSUPPORTED_MEDIA_TYPE', 'PAYLOAD_TOO_LARGE', 'RATE_LIMITED']);

/** An API error code as the page's error key. */
function errorKey(code: string | undefined): string {
  if (code === 'VERSION_CONFLICT') return 'conflict';
  if (code === 'FORBIDDEN') return 'forbidden';
  if (code === 'VALIDATION_FAILED') return 'invalidInput';
  return code && KNOWN.has(code) ? code : 'generic';
}

export async function savePublicProfileAction(form: FormData): Promise<void> {
  const parsed = UpdateMemberPublicProfileBody.safeParse({
    version: Number(text(form, 'version')),
    published: form.get('published') === 'on',
    displayName: text(form, 'displayName'),
    languages: form.getAll('languages').filter((v): v is string => typeof v === 'string'),
    phone: text(form, 'phone') || null,
    email: text(form, 'email') || null,
  });
  if (!parsed.success) return back({ error: 'invalidInput' });
  const res = await saveMyPublicProfile(await session(), parsed.data);
  if (res === 'revoked') redirect('/session/expired');
  return res.ok ? back({ notice: 'saved' }) : back({ error: errorKey(res.error?.code) });
}

export async function uploadPhotoAction(form: FormData): Promise<void> {
  const file = form.get('photo');
  if (!(file instanceof File) || file.size === 0) return back({ error: 'invalidInput' });
  if (file.size > MEMBER_PHOTO_MAX_BYTES) return back({ error: 'PAYLOAD_TOO_LARGE' });
  const res = await uploadMyPublicProfilePhoto(await session(), {
    bytes: new Uint8Array(await file.arrayBuffer()),
    contentType: file.type,
  });
  if (res === 'revoked') redirect('/session/expired');
  return res.ok ? back({ notice: 'photoUploaded' }) : back({ error: errorKey(res.error?.code) });
}

export async function removePhotoAction(): Promise<void> {
  const res = await removeMyPublicProfilePhoto(await session());
  if (res === 'revoked') redirect('/session/expired');
  return res.ok ? back({ notice: 'photoRemoved' }) : back({ error: errorKey(res.error?.code) });
}
