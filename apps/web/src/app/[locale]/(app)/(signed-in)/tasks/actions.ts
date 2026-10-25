'use server';

import { CreateTaskBody, UpdateTaskBody } from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { z } from 'zod';
import { getPathname } from '@/i18n/navigation';
import { requireSession, settle } from '@/server/actions';
import { readAgencyTimeZone } from '@/server/agency-time-zone';
import { createTask, deleteTask, updateTask } from '@/server/crm-api';
import { parseLocalDateTime } from './time';

/**
 * My-tasks actions (S10-05, transport only): forms post here, the contracts validate, the API decides. Each action
 * returns to the list the member came from (`tab`, `scope`) with `done` or the error code (i18n keys under
 * `tasks.errors`).
 */

const TABS = new Set(['overdue', 'today', 'upcoming', 'noDate', 'done']);

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

async function back(form: FormData, extra: Record<string, string>): Promise<never> {
  const tab = text(form, 'tab');
  const query = new URLSearchParams({
    ...(TABS.has(tab) ? { tab } : {}),
    ...(text(form, 'scope') === 'all' ? { scope: 'all' } : {}),
    ...extra,
  });
  redirect(`${getPathname({ href: '/tasks', locale: await getLocale() })}?${query.toString()}`);
}

export async function addTaskAction(form: FormData): Promise<void> {
  const session = await requireSession();
  const due = text(form, 'dueAt');
  const timeZone = due ? await readAgencyTimeZone(session) : null;
  if (due && !timeZone) return back(form, { error: 'generic' });
  const dueAt = due && timeZone ? parseLocalDateTime(due, timeZone) : undefined;
  const key = text(form, 'idempotencyKey');
  const parsed = CreateTaskBody.safeParse({
    title: text(form, 'title'),
    ...(text(form, 'description') ? { description: text(form, 'description') } : {}),
    ...(dueAt ? { dueAt: dueAt.toISOString() } : {}),
    remind: form.get('remind') === 'on',
  });
  if ((due && !dueAt) || !parsed.success || !/^[A-Za-z0-9-]{16,64}$/.test(key)) {
    return back(form, { error: 'VALIDATION_FAILED' });
  }
  return settle(await createTask(session, parsed.data, key), (e) => back(form, e));
}

/** Completes, reopens or deletes one task (`intent`), at the `version` the member saw. */
export async function taskIntentAction(form: FormData): Promise<void> {
  const id = text(form, 'id');
  const intent = text(form, 'intent');
  const version = Number(text(form, 'version'));
  if (!z.uuid().safeParse(id).success) return back(form, { error: 'VALIDATION_FAILED' });
  const s = await requireSession();
  if (intent === 'delete') return settle(await deleteTask(s, id), (e) => back(form, e));
  const parsed = UpdateTaskBody.safeParse({ version, status: intent === 'reopen' ? 'OPEN' : 'DONE' });
  if (!parsed.success || !['complete', 'reopen'].includes(intent)) return back(form, { error: 'VALIDATION_FAILED' });
  return settle(await updateTask(s, id, parsed.data), (e) => back(form, e));
}
