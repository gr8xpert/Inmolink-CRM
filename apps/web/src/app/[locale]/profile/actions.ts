'use server';

import { AGENCY_LOGO_MAX_BYTES, UpdateAgencyProfileBody } from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import { removeAgencyLogo, saveAgencyProfile, sessionRef, uploadAgencyLogo } from '@/server/api';

/**
 * Agency profile actions (S1-06, transport only): validate with the contract and call the API. The
 * profile form keeps its state; the logo forms come back to the page with a notice or an error code
 * (`agency.profile.notices` / `agency.errors`). Logos are ≤ 512 KB, inside the server-action body limit.
 */
export interface ProfileValues {
  primaryColor: string;
  accentColor: string;
  contactEmail: string;
  contactPhone: string;
  websiteUrl: string;
  /** Per locale: tagline and description as typed. */
  texts: Record<string, { tagline: string; description: string }>;
}

export interface ProfileState {
  error?: 'invalidInput' | 'conflict' | 'forbidden' | 'generic';
  fields?: string[];
  done?: boolean;
  version?: number;
  values?: ProfileValues;
  revoked?: boolean;
  submission?: number;
}

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

function valuesOf(form: FormData, locales: string[]): ProfileValues {
  return {
    primaryColor: text(form, 'primaryColor'),
    accentColor: text(form, 'accentColor'),
    contactEmail: text(form, 'contactEmail'),
    contactPhone: text(form, 'contactPhone'),
    websiteUrl: text(form, 'websiteUrl'),
    texts: Object.fromEntries(
      locales.map((l) => [l, { tagline: text(form, `tagline.${l}`), description: text(form, `description.${l}`) }]),
    ),
  };
}

const ERRORS: Record<string, NonNullable<ProfileState['error']>> = {
  VERSION_CONFLICT: 'conflict',
  FORBIDDEN: 'forbidden',
  VALIDATION_FAILED: 'invalidInput',
};

export async function saveProfileAction(prev: ProfileState, form: FormData): Promise<ProfileState> {
  const session = await auth();
  if (!session?.user?.id) return { revoked: true };
  const submission = (prev.submission ?? 0) + 1;
  const locales = form.getAll('locales').filter((v): v is string => typeof v === 'string');
  const values = valuesOf(form, locales);
  const version = prev.version ?? Number(text(form, 'version'));
  const parsed = UpdateAgencyProfileBody.safeParse({
    version,
    primaryColor: values.primaryColor || null,
    accentColor: values.accentColor || null,
    contactEmail: values.contactEmail || null,
    contactPhone: values.contactPhone || null,
    websiteUrl: values.websiteUrl || null,
    translations: Object.entries(values.texts)
      .filter(([, t]) => t.tagline || t.description)
      .map(([locale, t]) => ({ locale, tagline: t.tagline || null, description: t.description || null })),
  });
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
    return { version, error: 'invalidInput', fields, values, submission };
  }
  const res = await saveAgencyProfile(sessionRef(session.user), parsed.data);
  if (res === 'revoked') return { revoked: true };
  if (res.ok) return { done: true, version: res.data.version, values, submission };
  return { version, error: ERRORS[res.error?.code ?? ''] ?? 'generic', values, submission };
}

const LOGO_ERRORS = new Set([
  'FORBIDDEN',
  'UNSUPPORTED_MEDIA_TYPE',
  'PAYLOAD_TOO_LARGE',
  'VALIDATION_FAILED',
  'RATE_LIMITED',
]);

async function back(query: Record<string, string>): Promise<never> {
  const path = getPathname({ href: '/profile', locale: await getLocale() });
  redirect(`${path}?${new URLSearchParams(query)}`);
}

async function session() {
  const s = await auth();
  if (!s?.user?.id) redirect('/session/expired');
  return sessionRef(s.user);
}

function logoError(code: string | undefined): string {
  if (code === 'FORBIDDEN') return 'forbidden';
  if (code === 'VALIDATION_FAILED') return 'invalidInput';
  return code && LOGO_ERRORS.has(code) ? code : 'generic';
}

export async function uploadLogoAction(form: FormData): Promise<void> {
  const file = form.get('logo');
  if (!(file instanceof File) || file.size === 0) return back({ error: 'invalidInput' });
  if (file.size > AGENCY_LOGO_MAX_BYTES) return back({ error: 'PAYLOAD_TOO_LARGE' });
  const res = await uploadAgencyLogo(await session(), {
    bytes: new Uint8Array(await file.arrayBuffer()),
    contentType: file.type,
  });
  if (res === 'revoked') redirect('/session/expired');
  return res.ok ? back({ notice: 'logoUploaded' }) : back({ error: logoError(res.error?.code) });
}

export async function removeLogoAction(): Promise<void> {
  const res = await removeAgencyLogo(await session());
  if (res === 'revoked') redirect('/session/expired');
  return res.ok ? back({ notice: 'logoRemoved' }) : back({ error: logoError(res.error?.code) });
}
