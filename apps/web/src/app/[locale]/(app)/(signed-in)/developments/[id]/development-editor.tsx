'use client';

import { type DevelopmentDto, LOCKABLE_DEVELOPMENT_FIELDS, type LockableDevelopmentField } from '@inmolink/contracts';
import { Button, Input, Label } from '@inmolink/ui';
import { useRouter } from 'next/navigation';
import { useFormatter } from 'next-intl';
import { type FormEvent, useEffect, useId, useState, useTransition } from 'react';
import type { Option } from '../../listings/taxonomy';
import { makeT } from '../../listings/values';
import { type DevResult, saveDevelopmentAction } from '../actions';

const SELECT = 'h-9 w-full rounded-md border bg-background px-3 text-sm disabled:opacity-60';
const STATUSES = ['OFF_PLAN', 'UNDER_CONSTRUCTION', 'KEY_READY', 'SOLD_OUT'] as const;

interface Props {
  development: DevelopmentDto;
  locations: Option[];
  readOnly: boolean;
  messages: Record<string, unknown>;
}

interface Draft {
  ref: string;
  name: string;
  status: string;
  completionDate: string;
  locationId: string;
  /** Percentage as typed ("3", "2.5"); empty: no percentage commission. */
  commissionPct: string;
  includesVat: boolean;
  /** The feed field locks (S8-F5); empty on a development no feed created. */
  lockedFields: LockableDevelopmentField[];
}

/** The lock a hand edit of each draft field turns on (S8-F5). */
const LOCK_OF: Partial<Record<keyof Draft, LockableDevelopmentField>> = { name: 'name', locationId: 'location' };

const draftOf = (d: DevelopmentDto): Draft => ({
  ref: d.ref,
  name: d.name,
  status: d.status,
  completionDate: d.completionDate ?? '',
  locationId: d.locationId,
  commissionPct: d.commission?.type === 'PCT' ? String(d.commission.basisPoints / 100) : '',
  includesVat: d.commission?.includesVat ?? false,
  lockedFields: d.feed?.lockedFields ?? [],
});

/**
 * The development's details (S4-03): saved with one button (the changed fields and the version held), and the
 * maintainer's "units and prices are current" confirmation (`verified`, the freshness SLA). The commission is a
 * percentage here; a fixed amount set elsewhere is shown and kept unless the field is used. On a feed development
 * (S8-F5) the fields the feed keeps current carry a lock: editing one turns its lock on, and the owner may turn it off.
 */
export function DevelopmentEditor({ development, locations, readOnly, messages }: Props) {
  const t = makeT(messages);
  const format = useFormatter();
  const router = useRouter();
  const ids = useId();
  const [dev, setDev] = useState(development);
  const [draft, setDraft] = useState(() => draftOf(development));
  const [status, setStatus] = useState<{ kind: 'error' | 'saved'; text: string; fields?: string[] } | null>(null);
  const [pending, startTransition] = useTransition();

  // A refreshed page (an approval elsewhere) brings a newer version: start from it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a newer saved version replaces the draft
  useEffect(() => {
    if (development.version > dev.version) {
      setDev(development);
      setDraft(draftOf(development));
    }
  }, [development.version]);

  const fail = (res: Extract<DevResult<unknown>, { ok: false }>) => {
    if (res.revoked) return window.location.reload();
    const key = `errors.${res.code}`;
    const text = t(key);
    setStatus({ kind: 'error', text: text === key ? t('errors.generic') : text, fields: res.fields });
  };

  const changes = (): Record<string, unknown> => {
    const before = draftOf(dev);
    const body: Record<string, unknown> = {};
    if (draft.ref.trim() !== before.ref) body.ref = draft.ref.trim();
    if (draft.name.trim() !== before.name) body.name = draft.name.trim();
    if (draft.status !== before.status) body.status = draft.status;
    if (draft.completionDate !== before.completionDate) body.completionDate = draft.completionDate || null;
    if (draft.locationId !== before.locationId) body.locationId = draft.locationId;
    if (dev.feed && draft.lockedFields.join() !== before.lockedFields.join()) body.lockedFields = draft.lockedFields;
    if (draft.commissionPct !== before.commissionPct || draft.includesVat !== before.includesVat) {
      const pct = Number(draft.commissionPct.replace(',', '.'));
      if (draft.commissionPct.trim() === '') body.commission = dev.commission?.type === 'FIXED' ? dev.commission : null;
      else if (Number.isFinite(pct)) {
        body.commission = { type: 'PCT', basisPoints: Math.round(pct * 100), includesVat: draft.includesVat };
      } else body.commission = 'invalid';
    }
    return body;
  };

  const send = (body: Record<string, unknown>) => {
    setStatus(null);
    startTransition(async () => {
      const res = await saveDevelopmentAction(dev.id, { ...body, version: dev.version });
      if (!res.ok) return fail(res);
      setDev(res.data);
      setDraft(draftOf(res.data));
      setStatus({ kind: 'saved', text: t('editor.saved') });
      // The sharing panel and the list hold the version too.
      router.refresh();
    });
  };

  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const body = changes();
    if (Object.keys(body).length > 0) send(body);
  };

  /** A draft change; on a feed development, editing a feed-owned field locks it. */
  const edit = (patch: Partial<Draft>) =>
    setDraft((d) => {
      const next = { ...d, ...patch };
      if (!dev.feed) return next;
      const add = (Object.keys(patch) as (keyof Draft)[]).flatMap((k) => {
        const lock = LOCK_OF[k];
        return lock && !d.lockedFields.includes(lock) ? [lock] : [];
      });
      return add.length > 0 ? { ...next, lockedFields: [...d.lockedFields, ...add].sort() } : next;
    });
  const toggleLock = (f: LockableDevelopmentField, on: boolean) =>
    setDraft((d) => ({
      ...d,
      lockedFields: on ? [...new Set([...d.lockedFields, f])].sort() : d.lockedFields.filter((x) => x !== f),
    }));

  const bad = (field: string) => status?.kind === 'error' && (status.fields ?? []).some((f) => f.startsWith(field));
  const field = (name: keyof Draft) => ({
    id: `${ids}-${name}`,
    disabled: readOnly || pending,
    'aria-invalid': bad(name === 'commissionPct' ? 'commission' : name),
  });

  return (
    <section aria-labelledby={`${ids}-h`} className="flex flex-col gap-3 rounded-md border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`${ids}-h`} className="text-base font-semibold">
          {t('editor.details')}
        </h2>
        <p className="text-sm text-muted-foreground" data-testid="verified-at">
          {dev.lastVerifiedAt
            ? t('editor.verifiedAt', { date: format.dateTime(new Date(dev.lastVerifiedAt), { dateStyle: 'medium' }) })
            : t('editor.notVerified')}
        </p>
      </div>
      <form onSubmit={save} className="grid gap-3 md:grid-cols-2" noValidate>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-name`}>{t('fields.name')}</Label>
          <Input
            {...field('name')}
            maxLength={160}
            value={draft.name}
            onChange={(e) => edit({ name: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-ref`}>{t('fields.ref')}</Label>
          <Input
            {...field('ref')}
            maxLength={40}
            value={draft.ref}
            onChange={(e) => setDraft({ ...draft, ref: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-status`}>{t('fields.status')}</Label>
          <select
            {...field('status')}
            className={SELECT}
            value={draft.status}
            onChange={(e) => setDraft({ ...draft, status: e.target.value })}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`options.status.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-completionDate`}>{t('fields.completionDate')}</Label>
          <Input
            {...field('completionDate')}
            type="date"
            value={draft.completionDate}
            onChange={(e) => setDraft({ ...draft, completionDate: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5 md:col-span-2">
          <Label htmlFor={`${ids}-locationId`}>{t('fields.locationId')}</Label>
          <select
            {...field('locationId')}
            className={SELECT}
            value={draft.locationId}
            onChange={(e) => edit({ locationId: e.target.value })}
          >
            {locations.some((l) => l.id === draft.locationId) ? null : (
              <option value={draft.locationId}>{draft.locationId}</option>
            )}
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
        {dev.feed ? (
          <fieldset className="flex flex-col gap-1.5 rounded-md border p-3 md:col-span-2" data-testid="feed-locks">
            <legend className="px-1 text-sm font-medium">{t('editor.feed.legend')}</legend>
            <p className="text-xs text-muted-foreground">{t('editor.feed.intro')}</p>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {LOCKABLE_DEVELOPMENT_FIELDS.map((f) => (
                <label key={f} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    disabled={readOnly || pending}
                    checked={draft.lockedFields.includes(f)}
                    onChange={(e) => toggleLock(f, e.target.checked)}
                  />
                  {t('editor.feed.lockField', { field: t(`editor.feed.fields.${f}`) })}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        {readOnly ? null : (
          <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${ids}-commissionPct`}>{t('fields.commission')}</Label>
              <Input
                {...field('commissionPct')}
                inputMode="decimal"
                value={draft.commissionPct}
                onChange={(e) => setDraft({ ...draft, commissionPct: e.target.value })}
              />
              {dev.commission?.type === 'FIXED' ? (
                <p className="text-xs text-muted-foreground">
                  {t('editor.fixedCommission', {
                    amount: format.number(dev.commission.amount.amountCents / 100, {
                      style: 'currency',
                      currency: dev.commission.amount.currency,
                    }),
                  })}
                </p>
              ) : null}
            </div>
            <label className="flex items-center gap-2 self-end pb-2 text-sm">
              <input
                type="checkbox"
                disabled={pending}
                checked={draft.includesVat}
                onChange={(e) => setDraft({ ...draft, includesVat: e.target.checked })}
              />
              {t('fields.commissionIncludesVat')}
            </label>
            <div className="flex flex-wrap items-center gap-2 md:col-span-2">
              <Button type="submit" size="sm" disabled={pending}>
                {t('editor.save')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => send({ verified: true })}
              >
                {t('editor.verify')}
              </Button>
            </div>
          </>
        )}
      </form>
      {status ? (
        <p
          role={status.kind === 'error' ? 'alert' : 'status'}
          className={status.kind === 'error' ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}
        >
          {status.text}
        </p>
      ) : null}
    </section>
  );
}
