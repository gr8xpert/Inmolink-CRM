'use server';

import { CreateWindowCardsBody, type PdfDocumentDto, PdfDocumentId } from '@inmolink/contracts';
import { auth } from '@/auth';
import { type ApiResult, type SessionRef, sessionRef } from '@/server/api';
import { createWindowCards, fetchWindowCards } from '@/server/window-cards-api';

/** Window-card actions (R2-06, transport only): ask for a batch, then poll it until it is ready or failed. */
export type WindowCardsResult = { ok: true; data: PdfDocumentDto } | { ok: false; code: string; revoked?: boolean };

const revoked: WindowCardsResult = { ok: false, code: 'SESSION_REVOKED', revoked: true };

async function call(fn: (s: SessionRef) => Promise<ApiResult<PdfDocumentDto>>): Promise<WindowCardsResult> {
  const session = await auth();
  if (!session?.user?.id) return revoked;
  const res = await fn(sessionRef(session.user));
  if (res === 'revoked') return revoked;
  if (res.ok) return { ok: true, data: res.data };
  return { ok: false, code: res.error?.code ?? (res.status === 0 ? 'NETWORK' : 'INTERNAL') };
}

export async function createWindowCardsAction(body: unknown): Promise<WindowCardsResult> {
  const parsed = CreateWindowCardsBody.safeParse(body);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  return call((s) => createWindowCards(s, parsed.data));
}

export async function windowCardsStateAction(id: string): Promise<WindowCardsResult> {
  if (!PdfDocumentId.safeParse(id).success) return { ok: false, code: 'VALIDATION_FAILED' };
  return call((s) => fetchWindowCards(s, id));
}
