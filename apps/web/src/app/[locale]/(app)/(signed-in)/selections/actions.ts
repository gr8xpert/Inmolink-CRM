'use server';

import { CreateSelectionBody } from '@inmolink/contracts';
import { CONTENT_LOCALES } from '@inmolink/i18n';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { createSelection, revokeSelection, rotateSelectionLink } from '@/server/selections-api';
import { SELECTION_ERRORS, type SelectionError, type ShareState } from './errors';

/**
 * Selection forms (S13-F13, transport only): create (from a bookmark folder or listing ids), rotate the link, revoke.
 * A new link comes back in the form state (shown once); revoke redirects with `?done=`.
 */

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

const known = (code: string | undefined): SelectionError => SELECTION_ERRORS.find((c) => c === code) ?? 'generic';

async function session() {
  const s = await auth();
  if (!s?.user?.id) return redirect(getPathname({ href: '/login', locale: await getLocale() }));
  return sessionRef(s.user);
}

export async function createSelectionAction(_state: ShareState, form: FormData): Promise<ShareState> {
  const ref = await session();
  const folder = text(form, 'fromFolderId');
  const ids = text(form, 'listingIds')
    .split(/[\s,;]+/)
    .filter(Boolean);
  const contactId = text(form, 'contactId');
  const locale = text(form, 'locale');
  const days = text(form, 'expiresInDays');
  const message = text(form, 'message');
  const parsed = CreateSelectionBody.safeParse({
    title: text(form, 'title'),
    locale: CONTENT_LOCALES.includes(locale) ? locale : '',
    ...(message ? { message } : {}),
    ...(contactId ? { contactId } : {}),
    ...(days ? { expiresInDays: Number(days) } : {}),
    ...(folder ? { fromFolderId: folder } : { items: ids.map((targetId) => ({ targetId })) }),
  });
  if (!parsed.success) return { error: 'VALIDATION_FAILED' };
  const res = await createSelection(ref, parsed.data);
  if (res === 'revoked') return redirect('/session/expired');
  if (!res.ok) return { error: known(res.error?.code) };
  return { share: res.data.share, selectionId: res.data.selection.id };
}

export async function rotateLinkAction(_state: ShareState, form: FormData): Promise<ShareState> {
  const version = Number(text(form, 'version'));
  const res = await rotateSelectionLink(
    await session(),
    text(form, 'selectionId'),
    Number.isInteger(version) ? version : 0,
  );
  if (res === 'revoked') return redirect('/session/expired');
  if (!res.ok) return { error: known(res.error?.code) };
  return { share: res.data.share, selectionId: res.data.selection.id };
}

export async function revokeSelectionAction(form: FormData): Promise<void> {
  const version = Number(text(form, 'version'));
  const id = text(form, 'selectionId');
  const res = await revokeSelection(await session(), id, Number.isInteger(version) ? version : 0);
  if (res === 'revoked') return redirect('/session/expired');
  const back = getPathname({ href: `/selections/${encodeURIComponent(id)}`, locale: await getLocale() });
  return redirect(`${back}?${res.ok ? 'done=revoked' : `error=${known(res.error?.code)}`}`);
}
