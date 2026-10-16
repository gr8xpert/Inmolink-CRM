'use client';

import type { DevelopmentAccess, DevelopmentDto, PreferredAgencyDto } from '@inmolink/contracts';
import { Button } from '@inmolink/ui';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useId, useState, useTransition } from 'react';
import { makeT } from '../../listings/values';
import { saveAccessAction } from '../actions';

interface Props {
  development: DevelopmentDto;
  /** The agency's preferred agencies: the ones it can name here, by name. */
  partners: PreferredAgencyDto[];
  messages: Record<string, unknown>;
}

/**
 * Who sees the development (S4-03): every verified agency (OPEN) or only the agencies named (PRIVATE_NETWORK),
 * picked from the agency's preferred agencies. An agency named earlier that is no longer a preferred one stays
 * listed by id until it is unticked. Saving replaces the list (the API needs a verified agency and an admin).
 */
export function AccessPanel({ development, partners, messages }: Props) {
  const t = makeT(messages);
  const router = useRouter();
  const ids = useId();
  const [version, setVersion] = useState(development.version);
  const [kind, setKind] = useState<DevelopmentAccess>(development.access?.kind ?? 'PRIVATE_NETWORK');
  const [allowed, setAllowed] = useState(() => new Set(development.access?.allowedAgencyIds ?? []));
  const [status, setStatus] = useState<{ kind: 'error' | 'saved'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  // Another panel saved the development: the version moved on (the sharing itself did not change).
  useEffect(() => {
    setVersion((v) => Math.max(v, development.version));
  }, [development.version]);

  const named = new Set(partners.map((p) => p.agencyId));
  const others = [...allowed].filter((id) => !named.has(id));
  const toggle = (id: string, on: boolean) =>
    setAllowed((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setStatus(null);
    startTransition(async () => {
      const res = await saveAccessAction(development.id, {
        version,
        kind,
        allowedAgencyIds: kind === 'OPEN' ? [] : [...allowed],
      });
      if (!res.ok) {
        if (res.revoked) return window.location.reload();
        const key = `errors.${res.code}`;
        const text = t(key);
        return setStatus({ kind: 'error', text: text === key ? t('errors.generic') : text });
      }
      setVersion(res.data.version);
      setStatus({ kind: 'saved', text: t('access.saved') });
      router.refresh();
    });
  };

  return (
    <section aria-labelledby={`${ids}-h`} className="flex flex-col gap-3 rounded-md border p-4">
      <div>
        <h2 id={`${ids}-h`} className="text-base font-semibold">
          {t('access.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('access.intro')}</p>
      </div>
      <form onSubmit={save} className="flex flex-col gap-3">
        <fieldset className="flex flex-col gap-1.5">
          <legend className="sr-only">{t('access.title')}</legend>
          {(['PRIVATE_NETWORK', 'OPEN'] as const).map((k) => (
            <label key={k} className="flex items-center gap-2 text-sm">
              <input type="radio" name={`${ids}-kind`} value={k} checked={kind === k} onChange={() => setKind(k)} />
              {t(`options.access.${k}`)}
            </label>
          ))}
        </fieldset>
        {kind === 'PRIVATE_NETWORK' ? (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-sm font-medium">{t('access.agencies')}</legend>
            {partners.length === 0 && others.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('access.noPartners')}</p>
            ) : null}
            {partners.map((p) => (
              <label key={p.agencyId} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={allowed.has(p.agencyId)}
                  onChange={(e) => toggle(p.agencyId, e.target.checked)}
                />
                {p.name}
              </label>
            ))}
            {others.map((id) => (
              <label key={id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked onChange={(e) => toggle(id, e.target.checked)} />
                {t('access.other', { id: id.slice(0, 8) })}
              </label>
            ))}
          </fieldset>
        ) : null}
        <Button type="submit" size="sm" className="self-start" disabled={pending}>
          {t('access.save')}
        </Button>
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
