'use client';

import { KYERO_UNITS_MAX_BYTES, type KyeroUnitsPreview, MAX_UNITS_PER_BULK } from '@inmolink/contracts';
import { Button, Label } from '@inmolink/ui';
import { type ChangeEvent, useId, useState, useTransition } from 'react';
import type { makeT } from '../../listings/values';
import { createUnitsAction, type DevResult } from '../actions';

/** Problems listed before "…and N more". */
const SHOWN_PROBLEMS = 10;
/** The limits as the strings name them. */
const LIMITS = { max: String(MAX_UNITS_PER_BULK), mb: String(KYERO_UNITS_MAX_BYTES / (1024 * 1024)) };

type Read = { ok: true; data: KyeroUnitsPreview } | { ok: false; error: string };

/** The raw XML to the web relay (bigger than a server action takes); the API reads it, nothing is stored. */
async function readFile(developmentId: string, file: File): Promise<Read> {
  try {
    const res = await fetch(`/api/developments/${encodeURIComponent(developmentId)}/units/kyero`, {
      method: 'POST',
      headers: { 'content-type': 'application/xml' },
      body: file,
    });
    return (await res.json()) as Read;
  } catch {
    return { ok: false, error: 'generic' };
  }
}

interface Props {
  developmentId: string;
  t: ReturnType<typeof makeT>;
  /** After the units were created: the panel reloads its first page and says how many. */
  onImported: (count: number) => void;
  onError: (res: Extract<DevResult<unknown>, { ok: false }>) => void;
}

/**
 * R2-07a: units from a Kyero v3 file. The API reads the file (XXE-safe, ≤ 5 MB, ≤ 500 properties) and answers the
 * units or the problems by property; "Import units" then sends them through the CSV import's path (`createUnits`).
 */
export function KyeroImport({ developmentId, t, onImported, onError }: Props) {
  const ids = useId();
  const [read, setRead] = useState<KyeroUnitsPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const choose = (e: ChangeEvent<HTMLInputElement>) => {
    setRead(null);
    setError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > KYERO_UNITS_MAX_BYTES) return setError(t('kyero.tooLarge', LIMITS));
    startTransition(async () => {
      const res = await readFile(developmentId, file);
      if (res.ok) return setRead(res.data);
      if (res.error === 'revoked') return window.location.reload();
      const key = `errors.${res.error}`;
      const text = t(key);
      setError(text === key ? t('errors.generic') : text);
    });
  };

  const submit = () => {
    if (!read || read.units.length === 0) return;
    startTransition(async () => {
      const res = await createUnitsAction(developmentId, { units: read.units });
      if (!res.ok) return onError(res);
      setRead(null);
      onImported(res.data.items.length);
    });
  };

  const total = read ? read.problems.length + read.moreProblems : 0;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">{t('kyero.hint', LIMITS)}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={`${ids}-kyero`} className="sr-only">
          {t('kyero.file')}
        </Label>
        <input
          id={`${ids}-kyero`}
          type="file"
          accept=".xml,application/xml,text/xml"
          className="text-sm"
          disabled={pending}
          onChange={choose}
        />
        {read && read.problems.length === 0 && read.units.length > 0 ? (
          <Button type="button" size="sm" disabled={pending} onClick={submit}>
            {t('kyero.submit')}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {read && total === 0 ? <p className="text-sm">{t('kyero.ready', { count: String(read.units.length) })}</p> : null}
      {read && total > 0 ? (
        <ul role="alert" className="list-disc pl-5 text-sm text-destructive">
          {read.problems.slice(0, SHOWN_PROBLEMS).map((p) => (
            <li key={`${p.position}-${p.field}-${p.reason}`}>
              {t('kyero.problem', {
                position: String(p.position),
                ref: p.ref ?? '—',
                field: p.field,
                reason: t(`kyero.reasons.${p.reason}`, LIMITS),
              })}
            </li>
          ))}
          {total > SHOWN_PROBLEMS ? <li>{t('csv.more', { count: String(total - SHOWN_PROBLEMS) })}</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
