'use server';

import { CreateDataExportBody, CreateDataExportHeaders } from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { z } from 'zod';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { createDataExport, fetchDataExport } from '@/server/contacts-api';

/**
 * Data export request (S11-F14, transport only). The member re-authenticates with a fresh second-factor code, which
 * travels to the API in the request body: the API verifies it and refuses the export without it (this action cannot
 * skip the check). Returns to the page with `done` or the error code (i18n keys under `data-export.errors`).
 */

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

async function back(extra: Record<string, string>): Promise<never> {
  redirect(
    `${getPathname({ href: '/data-export', locale: await getLocale() })}?${new URLSearchParams(extra).toString()}`,
  );
}

export async function requestExportAction(form: FormData): Promise<void> {
  const s = await auth();
  if (!s?.user?.id) redirect('/session/expired');
  const key = text(form, 'idempotencyKey');
  const parsed = CreateDataExportBody.safeParse({
    kind: text(form, 'kind'),
    format: text(form, 'format') || 'csv',
    twoFactorCode: text(form, 'twoFactorCode'),
  });
  // a malformed code is the same answer as a wrong one: the member re-enters it
  if (!parsed.success) {
    const codeProblem = parsed.error.issues.some((i) => i.path[0] === 'twoFactorCode');
    return back({ error: codeProblem ? 'MFA_CODE_INVALID' : 'VALIDATION_FAILED' });
  }
  // the same header contract the API validates
  if (!CreateDataExportHeaders.safeParse({ 'idempotency-key': key }).success)
    return back({ error: 'VALIDATION_FAILED' });
  const res = await createDataExport(sessionRef(s.user), parsed.data, key);
  if (res === 'revoked') redirect('/session/expired');
  return back(res.ok ? { done: '1' } : { error: res.error?.code ?? 'generic' });
}

/**
 * "Get download link" (a POST, because it mints a signed URL and writes an audit entry): asks the API for the link and
 * sends the browser straight to it, so the signed URL is never rendered into a page. Back to the list on any failure.
 */
export async function downloadExportAction(form: FormData): Promise<void> {
  const s = await auth();
  if (!s?.user?.id) redirect('/session/expired');
  const id = text(form, 'id');
  if (!z.uuid().safeParse(id).success) return back({ error: 'DATA_EXPORT_NOT_FOUND' });
  const res = await fetchDataExport(sessionRef(s.user), id, true);
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok) return back({ error: res.error?.code ?? 'generic' });
  if (!res.data.download) return back({ error: 'DATA_EXPORT_NOT_FOUND' });
  redirect(res.data.download.url);
}
