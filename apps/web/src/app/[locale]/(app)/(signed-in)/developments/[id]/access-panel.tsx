'use client';

import type { DevelopmentAccess, DevelopmentDto, DirectorySearchResult, PreferredAgencyDto } from '@inmolink/contracts';
import { Button, Input, Label } from '@inmolink/ui';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useId, useState, useTransition } from 'react';
import { makeT } from '../../listings/values';
import { saveAccessAction, searchDirectoryAction } from '../actions';

interface Props {
  development: DevelopmentDto;
  /** The agency's preferred agencies: the ones it can name here, by name. */
  partners: PreferredAgencyDto[];
  messages: Record<string, unknown>;
}

/**
 * Who sees the development (S4-03): every verified agency (OPEN) or only the agencies named (PRIVATE_NETWORK),
 * picked from the agency's preferred agencies or (R2-07a) found by name in the directory of verified agencies.
 * Named agencies show by their directory name (the API sends it); one that left the directory shows by id until it
 * is unticked. Saving replaces the list (the API needs a verified agency and an admin, and checks every new name).
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
  // R2-07a: names of agencies named outside the preferred list (from the API, then from directory results).
  const [names, setNames] = useState<Record<string, string>>(() => ({ ...(development.access?.agencyNames ?? {}) }));
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<DirectorySearchResult['items'] | null>(null);
  const [searching, startSearch] = useTransition();

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

  const search = () => {
    const q = query.trim();
    if (q.length < 3) return setStatus({ kind: 'error', text: t('access.search.short') });
    setStatus(null);
    startSearch(async () => {
      const res = await searchDirectoryAction(q);
      if (!res.ok) {
        if (res.revoked) return window.location.reload();
        return setStatus({ kind: 'error', text: t('errors.generic') });
      }
      setFound(res.data.items.filter((a) => a.agencyId !== development.agencyId));
      setNames((prev) => ({ ...prev, ...Object.fromEntries(res.data.items.map((a) => [a.agencyId, a.name])) }));
    });
  };

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
      if (res.data.access?.agencyNames) setNames((prev) => ({ ...prev, ...res.data.access?.agencyNames }));
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
                {names[id] ?? t('access.other', { id: id.slice(0, 8) })}
              </label>
            ))}
            <div className="mt-2 flex flex-col gap-1.5 border-t pt-2">
              <Label htmlFor={`${ids}-q`}>{t('access.search.label')}</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id={`${ids}-q`}
                  value={query}
                  maxLength={80}
                  className="h-8 max-w-xs"
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      search();
                    }
                  }}
                />
                <Button type="button" size="sm" variant="outline" disabled={searching} onClick={search}>
                  {t('access.search.submit')}
                </Button>
              </div>
              {found && found.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('access.search.none')}</p>
              ) : null}
              {found && found.length > 0 ? (
                <ul className="flex flex-col gap-1" data-testid="access-directory-results">
                  {found
                    .filter((a) => !named.has(a.agencyId) && !allowed.has(a.agencyId))
                    .map((a) => (
                      <li key={a.agencyId}>
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={false}
                            onChange={(e) => toggle(a.agencyId, e.target.checked)}
                          />
                          {t('access.search.add', { name: a.name })}
                        </label>
                      </li>
                    ))}
                </ul>
              ) : null}
            </div>
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
