'use server';

import { CreateSiteBody, SiteParams, UpdateSiteBody } from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import { createSite, sessionRef, updateSite } from '@/server/api';
import { SITE_NOTICE_ERRORS } from './errors';

/**
 * Website site form actions (transport only, S7-01): read the form, validate with the contracts, call the API, and
 * come back with a notice or an error code (i18n keys under `websites`). Plain forms: they work without JavaScript.
 */
const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};
const list = (value: string, sep: RegExp) =>
  value
    .split(sep)
    .map((v) => v.trim())
    .filter(Boolean);
const ids = (form: FormData, name: string) =>
  form.getAll(name).filter((v): v is string => typeof v === 'string' && v !== '');
/**
 * Whole euros as typed (`250000`, `250.000`, `250,000`, `250 000`) → cents; empty → undefined. Decimals
 * (`250000,50`) and anything else → NaN, refused by the contract (never read as a bigger number).
 */
const WHOLE_EUROS = /^(?:\d{1,10}|\d{1,3}(?:[.,\s]\d{3}){1,3})$/;
function cents(form: FormData, name: string): number | undefined {
  const v = text(form, name);
  if (v === '') return undefined;
  return WHOLE_EUROS.test(v) ? Number(v.replace(/[.,\s]/g, '')) * 100 : Number.NaN;
}
const orNull = (v: string) => (v === '' ? null : v);

/** The site fields a form sends (both forms send all of them). */
function siteFields(form: FormData) {
  const policy = text(form, 'inventoryPolicy');
  const contact = Object.fromEntries(
    (['name', 'email', 'phone', 'whatsapp'] as const)
      .map((k) => [k, text(form, `contact.${k}`)] as const)
      .filter(([, v]) => v !== ''),
  );
  return {
    name: text(form, 'name'),
    domains: list(text(form, 'domains'), /[\s,]+/),
    mode: text(form, 'mode'),
    inventoryPolicy: policy,
    inventoryFilters:
      policy === 'CUSTOM'
        ? {
            includeOwn: form.get('includeOwn') === 'on',
            includeNetwork: form.get('includeNetwork') === 'on',
            locationIds: ids(form, 'locationIds'),
            propertyTypeIds: ids(form, 'propertyTypeIds'),
            priceMinCents: cents(form, 'priceMin'),
            priceMaxCents: cents(form, 'priceMax'),
            newBuilds: form.get('newBuilds') === 'on',
          }
        : null,
    referencePrefix: orNull(text(form, 'referencePrefix').toUpperCase()),
    locales: list(text(form, 'locales').toLowerCase(), /[\s,]+/),
    contact: Object.keys(contact).length > 0 ? contact : null,
  };
}

const known = (code: string | undefined) => SITE_NOTICE_ERRORS.find((c) => c === code) ?? 'generic';

/** Add a website (admins): back to the list on success, to the form with the error code otherwise. */
export async function createSiteAction(form: FormData): Promise<void> {
  const s = await auth();
  if (!s?.user?.id) redirect('/session/expired');
  const locale = await getLocale();
  const to = (href: string, query: Record<string, string>): never =>
    redirect(`${getPathname({ href, locale })}?${new URLSearchParams(query)}`);
  const parsed = CreateSiteBody.safeParse(siteFields(form));
  if (!parsed.success) return to('/websites/new', { error: 'VALIDATION_FAILED' });
  const res = await createSite(sessionRef(s.user), parsed.data);
  if (res === 'revoked') redirect('/session/expired');
  if (res.ok) return to('/websites', { done: 'created' });
  return to('/websites/new', { error: known(res.error?.code) });
}

/** Change a website (admins), on the version the form was loaded with. */
export async function updateSiteAction(form: FormData): Promise<void> {
  const s = await auth();
  if (!s?.user?.id) redirect('/session/expired');
  const locale = await getLocale();
  const to = (href: string, query: Record<string, string>): never =>
    redirect(`${getPathname({ href, locale })}?${new URLSearchParams(query)}`);
  const params = SiteParams.safeParse({ siteId: form.get('siteId') });
  if (!params.success) return to('/websites', { error: 'VALIDATION_FAILED' });
  const id = params.data.siteId;
  const parsed = UpdateSiteBody.safeParse({ version: Number(text(form, 'version')), ...siteFields(form) });
  if (!parsed.success) return to(`/websites/${id}`, { error: 'VALIDATION_FAILED' });
  const res = await updateSite(sessionRef(s.user), id, parsed.data);
  if (res === 'revoked') redirect('/session/expired');
  if (res.ok) return to('/websites', { done: 'saved' });
  return to(`/websites/${id}`, { error: known(res.error?.code) });
}
