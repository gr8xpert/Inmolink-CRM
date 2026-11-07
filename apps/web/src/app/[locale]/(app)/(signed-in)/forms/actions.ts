'use server';

import { CreateFormDocumentBody, FORM_DEFAULT_CURRENCY, type FormTemplate } from '@inmolink/contracts';
import { isUiLocale } from '@inmolink/i18n';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { getPathname } from '@/i18n/navigation';
import { cents, requireSession } from '@/server/actions';
import type { ApiResult } from '@/server/api';
import {
  createCollaborationAgreement,
  createDealSignatureRequest,
  createForm,
  createSignatureRequest,
  fetchForm,
  fetchSignatureRequest,
} from '@/server/forms-api';
import { isIdempotencyKey, isUuid, requestOptionsOf, signersOf, templateOf } from './query';

/**
 * The forms screens' actions (R2-05c, transport only): forms post here, the parsers keep malformed input out, the API
 * decides. Each returns to its screen with `done` or the API's error code (and a `SIGNERS_INVALID` reason).
 */

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

async function to(href: string, query: Record<string, string>): Promise<never> {
  const path = getPathname({ href, locale: await getLocale() });
  redirect(`${path}?${new URLSearchParams(query).toString()}`);
}

function refusal(res: Exclude<ApiResult<unknown>, 'revoked'>): Record<string, string> {
  if (res.ok) return {};
  const code = res.error?.code ?? 'generic';
  const reason = (res.error?.details as { reason?: unknown } | undefined)?.reason;
  return typeof reason === 'string' && /^[a-z_]{1,40}$/.test(reason) ? { error: code, reason } : { error: code };
}

const revokedGuard = <T>(res: ApiResult<T>): Exclude<ApiResult<T>, 'revoked'> => {
  if (res === 'revoked') redirect('/session/expired');
  return res;
};

const formIdOf = (form: FormData): string => {
  const id = text(form, 'formId');
  if (!isUuid(id)) redirect('/');
  return id;
};
const dealIdOf = (form: FormData): string => {
  const id = text(form, 'dealId');
  if (!isUuid(id)) redirect('/');
  return id;
};

/** A date field (`YYYY-MM-DD`) or undefined. */
const dateOf = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
const intOf = (v: string) => (/^\d{1,4}$/.test(v) ? Number(v) : undefined);
const amountOf = (v: string, currency: string) => {
  const c = cents(v);
  return c === null || c === undefined ? c : { amountCents: c, currency };
};

/** The typed fields of each template into the API's body; null when a field is malformed (the schema says which). */
function bodyOf(template: FormTemplate, form: FormData): unknown {
  const locale = text(form, 'locale');
  const base = { template, ...(isUiLocale(locale) ? { locale } : {}) };
  const contactId = text(form, 'contactId');
  const listingId = text(form, 'listingId');
  // the amounts are in the listing's currency (the generate screen posts it), else the forms' default
  const posted = text(form, 'currency');
  const currency = /^[A-Z]{3}$/.test(posted) ? posted : FORM_DEFAULT_CURRENCY;
  switch (template) {
    case 'LISTING_AGREEMENT':
      return {
        ...base,
        listingId,
        contactId,
        exclusive: form.get('exclusive') === 'on',
        termMonths: intOf(text(form, 'termMonths')),
      };
    case 'RESERVATION': {
      const price = amountOf(text(form, 'price'), currency);
      return {
        ...base,
        listingId,
        contactId,
        ...(price ? { price } : {}),
        deposit: amountOf(text(form, 'deposit'), currency),
        holdDays: intOf(text(form, 'holdDays')),
      };
    }
    case 'VIEWING_SHEET':
      return {
        ...base,
        contactId,
        listingIds: form.getAll('listingIds').filter((v): v is string => typeof v === 'string' && v !== ''),
        visitedOn: dateOf(text(form, 'visitedOn')),
      };
    case 'OFFER': {
      const conditions = text(form, 'conditions');
      return {
        ...base,
        listingId,
        contactId,
        offer: amountOf(text(form, 'offer'), currency),
        validUntil: dateOf(text(form, 'validUntil')),
        ...(conditions ? { conditions } : {}),
      };
    }
    default:
      return null;
  }
}

/** Generate a form: into its page (it renders in the background), or back to the generate screen with the error. */
export async function createFormAction(form: FormData): Promise<void> {
  const template = templateOf(text(form, 'template'));
  const back = (error: string): Promise<never> => {
    const keep: Record<string, string> = { error };
    if (template) keep.template = template;
    for (const name of ['contactId', 'listingId']) {
      const v = text(form, name);
      if (isUuid(v)) keep[name] = v;
    }
    return to('/forms/new', keep);
  };
  const key = text(form, 'idempotencyKey');
  if (!template || template === 'COLLABORATION_AGREEMENT' || !isIdempotencyKey(key)) return back('VALIDATION_FAILED');
  const body = CreateFormDocumentBody.safeParse(bodyOf(template, form));
  if (!body.success) return back('VALIDATION_FAILED');
  const res = revokedGuard(await createForm(await requireSession(), body.data, key));
  if (!res.ok) return back(res.error?.code ?? 'generic');
  return to(`/forms/${res.data.id}`, { done: 'created' });
}

/** A short signed link to the form's PDF (returned for `OpenFileForm`); a refusal goes back to the form. */
export async function openFormAction(form: FormData): Promise<{ url: string }> {
  const id = formIdOf(form);
  const res = revokedGuard(await fetchForm(await requireSession(), id));
  if (!res.ok) return to(`/forms/${id}`, refusal(res));
  if (!res.data.url) return to(`/forms/${id}`, { error: 'FORM_NOT_READY' });
  return { url: res.data.url };
}

/** A short signed link to a request's signed PDF (once COMPLETED). */
export async function openSignedAction(form: FormData): Promise<{ url: string }> {
  const id = formIdOf(form);
  const requestId = text(form, 'requestId');
  if (!isUuid(requestId)) return to(`/forms/${id}`, { error: 'VALIDATION_FAILED' });
  const res = revokedGuard(await fetchSignatureRequest(await requireSession(), requestId));
  if (!res.ok) return to(`/forms/${id}`, refusal(res));
  if (!res.data.url) return to(`/forms/${id}`, { error: 'FORM_NOT_READY' });
  return { url: res.data.url };
}

/** Send a form (not a collaboration agreement: that goes from its deal room) for signature. */
export async function sendForSignatureAction(form: FormData): Promise<void> {
  const id = formIdOf(form);
  const back = (q: Record<string, string>) => to(`/forms/${id}`, q);
  const template = templateOf(text(form, 'template'));
  const key = text(form, 'idempotencyKey');
  if (!template || template === 'COLLABORATION_AGREEMENT' || !isIdempotencyKey(key)) {
    return back({ error: 'VALIDATION_FAILED' });
  }
  const signers = signersOf(form, template);
  const options = requestOptionsOf(form);
  if (!signers || !options) return back({ error: 'VALIDATION_FAILED' });
  const res = revokedGuard(await createSignatureRequest(await requireSession(), id, { signers, ...options }, key));
  return back(res.ok ? { done: 'sent' } : refusal(res));
}

// ---- the deal room ----------------------------------------------------------------------------------------------------

/** Back to the deal room, its collaboration agreement section's notice (`formDone`) or error (`formError`). */
function toDeal(
  id: string,
  res: Exclude<ApiResult<unknown>, 'revoked'> | { error: string; reason?: string },
  done: string,
): Promise<never> {
  if ('ok' in res && res.ok) return to(`/deals/${id}`, { formDone: done });
  const r = 'ok' in res ? refusal(res) : res;
  return to(`/deals/${id}`, {
    formError: r.error ?? 'generic',
    ...(r.reason ? { formReason: r.reason } : {}),
  });
}

export async function createCollaborationAgreementAction(form: FormData): Promise<void> {
  const id = dealIdOf(form);
  const key = text(form, 'idempotencyKey');
  const locale = text(form, 'locale');
  if (!isIdempotencyKey(key)) return toDeal(id, { error: 'VALIDATION_FAILED' }, 'created');
  const body = isUiLocale(locale) ? { locale } : {};
  const res = revokedGuard(await createCollaborationAgreement(await requireSession(), id, body, key));
  return toDeal(id, res, 'created');
}

/**
 * Send the deal's collaboration agreement for signature: one signer per party, picked by user id from the deal's
 * signers (their names and addresses are the API's, which takes no other).
 */
export async function sendDealSignatureAction(form: FormData): Promise<void> {
  const id = dealIdOf(form);
  const formId = formIdOf(form);
  const key = text(form, 'idempotencyKey');
  const options = requestOptionsOf(form);
  const ownUserId = text(form, 'ownUserId');
  const counterpartUserId = text(form, 'counterpartUserId');
  if (!isIdempotencyKey(key) || !options || !isUuid(ownUserId) || !isUuid(counterpartUserId)) {
    return toDeal(id, { error: 'VALIDATION_FAILED' }, 'sent');
  }
  const res = revokedGuard(
    await createDealSignatureRequest(
      await requireSession(),
      id,
      { formId, ownUserId, counterpartUserId, ...options },
      key,
    ),
  );
  return toDeal(id, res, 'sent');
}
