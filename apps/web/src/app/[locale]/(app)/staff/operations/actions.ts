'use server';

import { StaffOperationParams, StartStaffOperationBody } from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { cancelStaffOperation, startStaffOperation } from '@/server/staff-ops-api';

/** Staff bulk operations (S13-03, transport only): the API authorizes, audits and queues the job. */
const KNOWN_ERRORS = [
  'FORBIDDEN',
  'STAFF_OPERATION_ACTIVE',
  'STAFF_OPERATION_NOT_FOUND',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'OUTBOX_REPLAY_TYPE_REFUSED',
] as const;

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
};

/** `datetime-local` (read as UTC, as the label says) → ISO. */
const utc = (v: string | undefined) => (v ? `${v.length === 16 ? `${v}:00` : v}Z` : undefined);

async function session() {
  const s = await auth();
  if (!s?.user?.id) redirect('/session/expired');
  return sessionRef(s.user);
}

async function back(query: Record<string, string>): Promise<never> {
  const path = getPathname({ href: '/staff/operations', locale: await getLocale() });
  redirect(`${path}?${new URLSearchParams(query)}`);
}

export async function startOperationAction(form: FormData): Promise<void> {
  const kind = text(form, 'kind');
  const body = StartStaffOperationBody.safeParse({
    kind,
    agencyId: text(form, 'agencyId'),
    reason: text(form, 'reason'),
    replay:
      kind === 'REPLAY_OUTBOX'
        ? {
            since: utc(text(form, 'since')),
            until: utc(text(form, 'until')),
            type: text(form, 'eventType'),
            deadOnly: form.get('deadOnly') === 'on',
          }
        : undefined,
  });
  if (!body.success) return back({ error: 'VALIDATION_FAILED' });
  const res = await startStaffOperation(await session(), body.data);
  if (res === 'revoked') redirect('/session/expired');
  if (res.ok) return back({ notice: 'started' });
  return back({ error: KNOWN_ERRORS.find((c) => c === res.error?.code) ?? 'generic' });
}

export async function cancelOperationAction(form: FormData): Promise<void> {
  const params = StaffOperationParams.safeParse({ id: text(form, 'id') });
  if (!params.success) return back({ error: 'VALIDATION_FAILED' });
  const res = await cancelStaffOperation(await session(), params.data.id);
  if (res === 'revoked') redirect('/session/expired');
  if (res.ok) return back({ notice: 'cancelled' });
  return back({ error: KNOWN_ERRORS.find((c) => c === res.error?.code) ?? 'generic' });
}
