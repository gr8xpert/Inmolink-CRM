'use server';

import { CreatePipelineStageBody, MoveLeadBody, UpdatePipelineStageBody } from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { z } from 'zod';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import type { ApiResult, SessionRef } from '@/server/api';
import { sessionRef } from '@/server/api';
import {
  createPipelineStage,
  fetchPipelineStages,
  fetchStageLeads,
  moveLead,
  reorderPipelineStages,
  updatePipelineStage,
} from '@/server/crm-api';
import { type BoardCard, toBoardCards } from './cards';

/**
 * Pipeline actions (S10-03, transport only): validate with the contracts, call the API, hand back the result or the
 * error code (i18n keys under `leads.pipeline.errors`). Authorization is the API's: members drag, admins change stages.
 */

export type ActionResult<T> = { ok: true; data: T } | { ok: false; code: string };

async function session(): Promise<SessionRef | null> {
  const s = await auth();
  return s?.user?.id ? sessionRef(s.user) : null;
}

function resultOf<T, U>(res: ApiResult<T>, map: (data: T) => U): ActionResult<U> {
  if (res === 'revoked') return { ok: false, code: 'SESSION_REVOKED' };
  if (res.ok) return { ok: true, data: map(res.data) };
  return { ok: false, code: res.error?.code ?? 'generic' };
}

const Uuid = z.uuid();
const Assigned = z.enum(['me', 'unassigned']).optional();

/** A drag (or a keyboard move): the lead into `stageId`, right after `afterLeadId` (null: the top), at `version`. */
export async function moveLeadAction(
  leadId: string,
  body: unknown,
): Promise<ActionResult<{ version: number; stageId: string }>> {
  const parsed = MoveLeadBody.safeParse(body);
  if (!Uuid.safeParse(leadId).success || !parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  const s = await session();
  if (!s) return { ok: false, code: 'SESSION_REVOKED' };
  return resultOf(await moveLead(s, leadId, parsed.data), (lead) => ({ version: lead.version, stageId: lead.stageId }));
}

/** A column's next page of cards. */
export async function loadColumnAction(
  stageId: string,
  cursor: string,
  assigned: unknown,
): Promise<ActionResult<{ cards: BoardCard[]; nextCursor: string | null }>> {
  const filter = Assigned.safeParse(assigned);
  if (!Uuid.safeParse(stageId).success || !/^[A-Za-z0-9_-]{1,400}$/.test(cursor) || !filter.success) {
    return { ok: false, code: 'VALIDATION_FAILED' };
  }
  const s = await session();
  if (!s) return { ok: false, code: 'SESSION_REVOKED' };
  const res = await fetchStageLeads(s, stageId, cursor, filter.data);
  if (res === 'revoked' || !res.ok) return resultOf(res, () => ({ cards: [], nextCursor: null }));
  return { ok: true, data: { cards: await toBoardCards(res.data.items), nextCursor: res.data.nextCursor } };
}

// ---- stage settings (forms; admins) ---------------------------------------------------------------------------------

async function back(query: Record<string, string>): Promise<never> {
  const base = getPathname({ href: '/pipeline/stages', locale: await getLocale() });
  redirect(`${base}?${new URLSearchParams(query).toString()}`);
}

async function settle(res: ApiResult<unknown>): Promise<never> {
  if (res === 'revoked') redirect('/session/expired');
  return back(res.ok ? { done: '1' } : { error: res.error?.code ?? 'generic' });
}

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

async function requireSession(): Promise<SessionRef> {
  const s = await session();
  if (!s) redirect('/session/expired');
  return s;
}

export async function addStageAction(form: FormData): Promise<void> {
  const parsed = CreatePipelineStageBody.safeParse({ name: text(form, 'name'), kind: text(form, 'kind') });
  const key = text(form, 'idempotencyKey');
  if (!parsed.success || !/^[A-Za-z0-9-]{8,64}$/.test(key)) return back({ error: 'VALIDATION_FAILED' });
  return settle(await createPipelineStage(await requireSession(), parsed.data, key));
}

export async function updateStageAction(form: FormData): Promise<void> {
  const id = text(form, 'id');
  const intent = text(form, 'intent');
  const version = Number(text(form, 'version'));
  const body =
    intent === 'archive'
      ? { version, archived: true }
      : intent === 'restore'
        ? { version, archived: false }
        : intent === 'reset'
          ? { version, name: null }
          : { version, name: text(form, 'name') };
  const parsed = UpdatePipelineStageBody.safeParse(body);
  if (!Uuid.safeParse(id).success || !parsed.success) return back({ error: 'VALIDATION_FAILED' });
  return settle(await updatePipelineStage(await requireSession(), id, parsed.data));
}

/** Moves one stage up or down: the whole active order, re-read just before (a concurrent change is refused). */
export async function shiftStageAction(form: FormData): Promise<void> {
  const id = text(form, 'id');
  const dir = text(form, 'dir') === 'up' ? -1 : 1;
  if (!Uuid.safeParse(id).success) return back({ error: 'VALIDATION_FAILED' });
  const s = await requireSession();
  const current = await fetchPipelineStages(s);
  if (current === 'revoked') redirect('/session/expired');
  if (!current.ok) return back({ error: current.error?.code ?? 'generic' });
  const ids = current.data.items.map((st) => st.id);
  const at = ids.indexOf(id);
  const to = at + dir;
  if (at < 0 || to < 0 || to >= ids.length) return back({});
  [ids[at], ids[to]] = [ids[to] as string, ids[at] as string];
  return settle(await reorderPipelineStages(s, ids));
}
