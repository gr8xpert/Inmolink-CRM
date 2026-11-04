'use server';

import {
  type ContactImportDto,
  type ContactImportPreviewDto,
  StartContactImportBody,
  type StartContactImportInput,
} from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireSession } from '@/server/actions';
import type { ApiResult } from '@/server/api';
import { fetchContactImport, previewContactImport, startContactImport } from '@/server/contacts-api';

/** The import screen's calls (S17-F29, transport only): the contract validates, the API decides who may and what happens. */

export type ImportResult<T> = { ok: true; data: T } | { ok: false; error: string; reason?: string };

function settled<T>(res: ApiResult<T>): ImportResult<T> {
  if (res === 'revoked') redirect('/session/expired');
  if (res.ok) return { ok: true, data: res.data };
  const reason = (res.error?.details as { reason?: unknown } | undefined)?.reason;
  return {
    ok: false,
    error: res.error?.code ?? 'generic',
    ...(typeof reason === 'string' ? { reason: reason.slice(0, 40) } : {}),
  };
}

const Id = z.uuid();

export async function previewImportAction(
  id: string,
  input: StartContactImportInput,
): Promise<ImportResult<ContactImportPreviewDto>> {
  const importId = Id.safeParse(id);
  const body = StartContactImportBody.safeParse(input);
  if (!importId.success || !body.success) return { ok: false, error: 'VALIDATION_FAILED' };
  return settled(await previewContactImport(await requireSession(), importId.data, body.data));
}

export async function startImportAction(
  id: string,
  input: StartContactImportInput,
): Promise<ImportResult<ContactImportDto>> {
  const importId = Id.safeParse(id);
  const body = StartContactImportBody.safeParse(input);
  if (!importId.success || !body.success) return { ok: false, error: 'VALIDATION_FAILED' };
  return settled(await startContactImport(await requireSession(), importId.data, body.data));
}

export async function importStatusAction(id: string): Promise<ImportResult<ContactImportDto>> {
  const importId = Id.safeParse(id);
  if (!importId.success) return { ok: false, error: 'VALIDATION_FAILED' };
  return settled(await fetchContactImport(await requireSession(), importId.data));
}
