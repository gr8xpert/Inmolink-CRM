'use server';

import {
  ConvertProspectBody,
  CreateProspectBody,
  MoveProspectBody,
  ProspectStage,
  UpdateProspectBody,
} from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { z } from 'zod';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import { readAgencyTimeZone } from '@/server/agency-time-zone';
import type { ApiResult, SessionRef } from '@/server/api';
import { sessionRef } from '@/server/api';
import {
  convertProspect,
  createProspect,
  deleteProspect,
  fetchStageProspects,
  moveProspect,
  updateProspect,
} from '@/server/prospects-api';
import { parseLocalDateTime } from '../tasks/time';
import { type ProspectCard, toProspectCards } from './cards';

/**
 * Acquisition board actions (S10-07, transport only): validate with the contracts, call the API, hand back the result
 * or the error code (i18n keys under `acquisition.errors`). Authorization is the API's.
 */

export type ActionResult<T> = { ok: true; data: T } | { ok: false; code: string };

async function session(): Promise<SessionRef | null> {
  const s = await auth();
  return s?.user?.id ? sessionRef(s.user) : null;
}

async function requireSession(): Promise<SessionRef> {
  const s = await session();
  if (!s) redirect('/session/expired');
  return s;
}

function resultOf<T, U>(res: ApiResult<T>, map: (data: T) => U): ActionResult<U> {
  if (res === 'revoked') return { ok: false, code: 'SESSION_REVOKED' };
  if (res.ok) return { ok: true, data: map(res.data) };
  return { ok: false, code: res.error?.code ?? 'generic' };
}

const Uuid = z.uuid();

/** A drag (or a keyboard move): the prospect into `stage`, right after `afterId` (null: the top), at `version`. */
export async function moveProspectAction(
  id: string,
  body: unknown,
): Promise<ActionResult<{ version: number; stage: string }>> {
  const parsed = MoveProspectBody.safeParse(body);
  if (!Uuid.safeParse(id).success || !parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  const s = await session();
  if (!s) return { ok: false, code: 'SESSION_REVOKED' };
  return resultOf(await moveProspect(s, id, parsed.data), (p) => ({ version: p.version, stage: p.stage }));
}

/** A column's next page of cards. */
export async function loadColumnAction(
  stage: string,
  cursor: string,
): Promise<ActionResult<{ cards: ProspectCard[]; nextCursor: string | null }>> {
  const parsedStage = ProspectStage.safeParse(stage);
  if (!parsedStage.success || !/^[A-Za-z0-9_-]{1,400}$/.test(cursor)) return { ok: false, code: 'VALIDATION_FAILED' };
  const s = await session();
  if (!s) return { ok: false, code: 'SESSION_REVOKED' };
  const res = await fetchStageProspects(s, parsedStage.data, cursor);
  if (res === 'revoked' || !res.ok) return resultOf(res, () => ({ cards: [], nextCursor: null }));
  return { ok: true, data: { cards: await toProspectCards(res.data.items), nextCursor: res.data.nextCursor } };
}

// ---- forms ------------------------------------------------------------------------------------------------------------

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

async function to(path: string, query: Record<string, string> = {}): Promise<never> {
  const base = getPathname({ href: path, locale: await getLocale() });
  const q = new URLSearchParams(query).toString();
  redirect(q ? `${base}?${q}` : base);
}

/** The form's fields as a body: empty inputs are `null` (cleared) or left out (`omitEmpty`, a new prospect). */
function fields(form: FormData, omitEmpty: boolean, timeZone: string | null): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  const put = (key: string, value: unknown) => {
    if (value === null && omitEmpty) return;
    out[key] = value;
  };
  for (const key of ['contactId', 'address', 'area', 'propertyTypeId', 'locationId', 'confidentialNotes'] as const) {
    if (!form.has(key)) continue;
    put(key, text(form, key) || null);
  }
  if (form.has('price')) {
    const raw = text(form, 'price').replace(/[\s.,]/g, '');
    if (raw && !/^\d{1,12}$/.test(raw)) return null;
    // no currency: the API uses the agency's (its settings)
    const currency = text(form, 'currency');
    put('estimatedPrice', raw ? { amountCents: Number(raw) * 100, ...(currency ? { currency } : {}) } : null);
  }
  if (form.has('nextFollowUpAt')) {
    const value = text(form, 'nextFollowUpAt');
    // a typed local time is read in the agency's zone; when that cannot be read the form is refused
    if (value && !timeZone) return null;
    const at = value && timeZone ? parseLocalDateTime(value, timeZone) : null;
    if (value && !at) return null;
    put('nextFollowUpAt', at ? at.toISOString() : null);
  }
  return out;
}

export async function createProspectAction(form: FormData): Promise<void> {
  const s = await requireSession();
  const body = fields(form, true, text(form, 'nextFollowUpAt') ? await readAgencyTimeZone(s) : null);
  const parsed = body ? CreateProspectBody.safeParse({ ...body, title: text(form, 'title') }) : null;
  const key = text(form, 'idempotencyKey');
  if (!parsed?.success || !/^[A-Za-z0-9-]{8,64}$/.test(key))
    return to('/acquisition/new', { error: 'VALIDATION_FAILED' });
  const res = await createProspect(s, parsed.data, key);
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok) return to('/acquisition/new', { error: res.error?.code ?? 'generic' });
  return to(`/acquisition/${res.data.id}`, { done: 'created' });
}

export async function updateProspectAction(form: FormData): Promise<void> {
  const id = text(form, 'id');
  if (!Uuid.safeParse(id).success) return to('/acquisition', { error: 'VALIDATION_FAILED' });
  const s = await requireSession();
  const body = fields(form, false, text(form, 'nextFollowUpAt') ? await readAgencyTimeZone(s) : null);
  const parsed = body
    ? UpdateProspectBody.safeParse({ ...body, title: text(form, 'title'), version: Number(text(form, 'version')) })
    : null;
  if (!parsed?.success) return to(`/acquisition/${id}`, { error: 'VALIDATION_FAILED' });
  const res = await updateProspect(s, id, parsed.data);
  if (res === 'revoked') redirect('/session/expired');
  return to(`/acquisition/${id}`, res.ok ? { done: 'saved' } : { error: res.error?.code ?? 'generic' });
}

/** One click: the prospect becomes a DRAFT listing (a second click answers the same listing). */
export async function convertProspectAction(form: FormData): Promise<void> {
  const id = text(form, 'id');
  const parsed = ConvertProspectBody.safeParse({
    ...(text(form, 'propertyTypeId') ? { propertyTypeId: text(form, 'propertyTypeId') } : {}),
    ...(text(form, 'locationId') ? { locationId: text(form, 'locationId') } : {}),
  });
  if (!Uuid.safeParse(id).success || !parsed.success) return to('/acquisition', { error: 'VALIDATION_FAILED' });
  const res = await convertProspect(await requireSession(), id, parsed.data);
  if (res === 'revoked') redirect('/session/expired');
  return to(`/acquisition/${id}`, res.ok ? { done: 'converted' } : { error: res.error?.code ?? 'generic' });
}

export async function deleteProspectAction(form: FormData): Promise<void> {
  const id = text(form, 'id');
  if (!Uuid.safeParse(id).success) return to('/acquisition', { error: 'VALIDATION_FAILED' });
  const res = await deleteProspect(await requireSession(), id);
  if (res === 'revoked') redirect('/session/expired');
  return res.ok
    ? to('/acquisition', { done: 'deleted' })
    : to(`/acquisition/${id}`, { error: res.error?.code ?? 'generic' });
}
