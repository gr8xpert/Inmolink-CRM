'use client';

import type { ListingOverrideDto, ListingOverrideTarget } from '@inmolink/contracts';
import { Button, Input, Label } from '@inmolink/ui';
import { type FormEvent, useEffect, useId, useState, useTransition } from 'react';
import {
  deleteListingOverrideAction,
  type EditorResult,
  listingOverridesAction,
  saveListingOverrideAction,
} from '../actions';
import { makeT } from '../values';

const SELECT = 'h-9 w-full rounded-md border bg-background px-3 text-sm disabled:opacity-60';
const TEXTAREA = 'min-h-32 w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-60';

export interface OverridePanelProps {
  /** A network listing here; a development or unit on the new-build pages (S4-03). */
  targetKind: ListingOverrideTarget;
  targetId: string;
  /** The owner's text per content locale, shown next to the agency's own. */
  ownerTexts: Record<string, { title: string; description: string | null }>;
  contentLocales: { code: string; label: string }[];
  messages: Record<string, unknown>;
}

/**
 * The agency's own title and description of another agency's listing or new build (S3-10), per content locale:
 * used on the agency's website and selections only. An empty field keeps the owner's text; removing the
 * override brings the owner's text back everywhere.
 */
export default function OverridePanel({
  targetKind,
  targetId,
  ownerTexts,
  contentLocales,
  messages,
}: OverridePanelProps) {
  const t = makeT(messages);
  const ids = useId();
  const [locale, setLocale] = useState(contentLocales[0]?.code ?? 'en');
  const [overrides, setOverrides] = useState<ListingOverrideDto[] | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<{ kind: 'error' | 'saved'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const fail = (res: Extract<EditorResult<unknown>, { ok: false }>) => {
    const key = `overrides.errors.${res.code}`;
    const text = t(key);
    setStatus({ kind: 'error', text: text === key ? t('overrides.errors.generic') : text });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once per target; `fail` only formats messages
  useEffect(() => {
    startTransition(async () => {
      const res = await listingOverridesAction(targetKind, targetId);
      if (!res.ok) return fail(res);
      setOverrides(res.data.items);
    });
  }, [targetKind, targetId]);

  const current = overrides?.find((o) => o.locale === locale) ?? null;
  // The form shows the saved override of the chosen locale.
  useEffect(() => {
    setTitle(current?.title ?? '');
    setDescription(current?.description ?? '');
  }, [current]);

  const owner = ownerTexts[locale] ?? null;

  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setStatus(null);
    startTransition(async () => {
      const res = await saveListingOverrideAction(targetKind, targetId, locale, {
        title: title.trim() || null,
        description: description.trim() || null,
      });
      if (!res.ok) return fail(res);
      setOverrides((list) => [...(list ?? []).filter((o) => o.locale !== locale), res.data]);
      setStatus({ kind: 'saved', text: t('overrides.saved') });
    });
  };

  const remove = () => {
    setStatus(null);
    startTransition(async () => {
      const res = await deleteListingOverrideAction(targetKind, targetId, locale);
      if (!res.ok && res.code !== 'LISTING_OVERRIDE_NOT_FOUND') return fail(res);
      setOverrides((list) => (list ?? []).filter((o) => o.locale !== locale));
      setStatus({ kind: 'saved', text: t('overrides.removed') });
    });
  };

  return (
    <section aria-labelledby={`${ids}-h`} className="flex flex-col gap-3 rounded-md border p-4">
      <div>
        <h2 id={`${ids}-h`} className="text-base font-semibold">
          {t('overrides.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('overrides.intro')}</p>
      </div>
      <div className="flex flex-col gap-1.5 sm:max-w-xs">
        <Label htmlFor={`${ids}-locale`}>{t('overrides.locale')}</Label>
        <select
          id={`${ids}-locale`}
          className={SELECT}
          value={locale}
          onChange={(e) => {
            setLocale(e.target.value);
            setStatus(null);
          }}
        >
          {contentLocales.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
              {overrides?.some((o) => o.locale === l.code) ? ` · ${t('overrides.overridden')}` : ''}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium">{t('overrides.ownerText')}</p>
          {owner ? (
            <div className="rounded-md bg-muted p-3 text-sm">
              <p className="font-medium">{owner.title}</p>
              {owner.description ? (
                <p className="mt-1 whitespace-pre-line text-muted-foreground">{owner.description}</p>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('overrides.noOwnerText')}</p>
          )}
        </div>
        <form onSubmit={save} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${ids}-title`}>{t('overrides.fields.title')}</Label>
            <Input
              id={`${ids}-title`}
              maxLength={200}
              value={title}
              placeholder={owner?.title ?? ''}
              disabled={overrides === null}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${ids}-description`}>{t('overrides.fields.description')}</Label>
            <textarea
              id={`${ids}-description`}
              className={TEXTAREA}
              maxLength={20_000}
              value={description}
              disabled={overrides === null}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <p className="text-xs text-muted-foreground">{t('overrides.hint')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={pending || overrides === null || (!title.trim() && !description.trim())}
            >
              {t('overrides.save')}
            </Button>
            {current ? (
              <Button type="button" size="sm" variant="outline" disabled={pending} onClick={remove}>
                {t('overrides.remove')}
              </Button>
            ) : null}
          </div>
        </form>
      </div>
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
