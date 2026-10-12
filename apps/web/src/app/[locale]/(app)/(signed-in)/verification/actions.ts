'use server';

import { DocumentParams, SubmitVerificationBody } from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import { type ApiResult, deleteVerificationDocument, sessionRef, submitVerification } from '@/server/api';

/**
 * Verification form actions (transport only, S1-03): validate with the contracts, call the API, and
 * come back to the page with a notice or an error code (`verification.notices` / `verification.errors`).
 * Uploads go to the route handler `/api/verification/documents` (its own body limit, not a server action).
 */
const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v : undefined;
};

async function back(query: Record<string, string>): Promise<never> {
  const path = getPathname({ href: '/verification', locale: await getLocale() });
  redirect(`${path}?${new URLSearchParams(query)}`);
}

async function session() {
  const s = await auth();
  if (!s?.user?.id) redirect('/session/expired');
  return sessionRef(s.user);
}

const KNOWN_ERRORS = [
  'FORBIDDEN',
  'NOT_FOUND',
  'VERSION_CONFLICT',
  'AGENCY_NOT_ONBOARDED',
  'VERIFICATION_ALREADY_SUBMITTED',
  'VERIFICATION_DOCUMENTS_REQUIRED',
  'VERIFICATION_NOT_OPEN',
  'DOCUMENT_TYPE_NOT_ALLOWED',
  'DOCUMENT_LIMIT_REACHED',
  'DOCUMENT_LOCKED',
  'PAYLOAD_TOO_LARGE',
  'VALIDATION_FAILED',
  'RATE_LIMITED',
] as const;

async function finish(res: ApiResult<unknown>, notice: string): Promise<never> {
  if (res === 'revoked') redirect('/session/expired');
  if (res.ok) return back({ notice });
  const code = KNOWN_ERRORS.find((c) => c === res.error?.code) ?? 'generic';
  return back({ error: code });
}

export async function removeAction(form: FormData): Promise<void> {
  const params = DocumentParams.safeParse({ id: text(form, 'id') });
  if (!params.success) return back({ error: 'VALIDATION_FAILED' });
  const s = await session();
  return finish(await deleteVerificationDocument(s, params.data.id), 'removed');
}

export async function submitAction(form: FormData): Promise<void> {
  const parsed = SubmitVerificationBody.safeParse({ version: Number(text(form, 'version')) });
  if (!parsed.success) return back({ error: 'VALIDATION_FAILED' });
  const s = await session();
  return finish(await submitVerification(s, parsed.data.version), 'submitted');
}
