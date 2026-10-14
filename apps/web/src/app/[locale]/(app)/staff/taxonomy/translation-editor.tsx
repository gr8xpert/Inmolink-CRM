'use client';

import { Button, Input, Label } from '@inmolink/ui';
import { useState } from 'react';

export interface Translation {
  locale: string;
  name: string;
  slug: string;
}

export type T = (key: string, vars?: Record<string, string>) => string;

/** Lowercase, accent-free, dashes: the shape the API accepts for a slug. */
export function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * One row per language: name and URL slug. The slug follows the name until it is edited by hand. The list is
 * saved as a whole (the API replaces the set), so removing a row removes that language.
 */
export function TranslationEditor({
  initial,
  locales,
  disabled,
  busy,
  submitLabel,
  t,
  onSubmit,
}: {
  initial: Translation[];
  locales: readonly string[];
  disabled: boolean;
  busy: boolean;
  submitLabel: string;
  t: T;
  onSubmit: (rows: Translation[]) => void;
}) {
  const [rows, setRows] = useState<(Translation & { slugEdited: boolean })[]>(
    initial.map((r) => ({ ...r, slugEdited: r.slug !== '' })),
  );
  const free = locales.filter((l) => !rows.some((r) => r.locale === l));
  const patch = (locale: string, p: Partial<Translation & { slugEdited: boolean }>) =>
    setRows((rs) => rs.map((r) => (r.locale === locale ? { ...r, ...p } : r)));

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(rows.map(({ locale, name, slug }) => ({ locale, name: name.trim(), slug })));
      }}
    >
      {rows.map((r) => (
        <div key={r.locale} className="grid grid-cols-[4rem_1fr_1fr_auto] items-end gap-2">
          <div>
            <Label className="text-xs">{t('translations.locale')}</Label>
            <p className="h-10 content-center text-sm font-medium uppercase">{r.locale}</p>
          </div>
          <div>
            <Label htmlFor={`name-${r.locale}`} className="text-xs">
              {t('translations.name')}
            </Label>
            <Input
              id={`name-${r.locale}`}
              value={r.name}
              required
              maxLength={200}
              disabled={disabled}
              onChange={(e) =>
                patch(r.locale, { name: e.target.value, ...(r.slugEdited ? {} : { slug: slugify(e.target.value) }) })
              }
            />
          </div>
          <div>
            <Label htmlFor={`slug-${r.locale}`} className="text-xs">
              {t('translations.slug')}
            </Label>
            <Input
              id={`slug-${r.locale}`}
              value={r.slug}
              required
              maxLength={120}
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              disabled={disabled}
              onChange={(e) => patch(r.locale, { slug: e.target.value, slugEdited: true })}
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t('translations.remove', { locale: r.locale.toUpperCase() })}
            disabled={disabled || rows.length === 1}
            onClick={() => setRows((rs) => rs.filter((x) => x.locale !== r.locale))}
          >
            ×
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        {free.length > 0 ? (
          <select
            aria-label={t('translations.add')}
            className="h-9 rounded-md border bg-background px-2 text-sm"
            disabled={disabled}
            value=""
            onChange={(e) => {
              const locale = e.target.value;
              if (locale) setRows((rs) => [...rs, { locale, name: '', slug: '', slugEdited: false }]);
            }}
          >
            <option value="">{t('translations.add')}</option>
            {free.map((l) => (
              <option key={l} value={l}>
                {l.toUpperCase()}
              </option>
            ))}
          </select>
        ) : null}
        <Button type="submit" size="sm" disabled={disabled || busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
