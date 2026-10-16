'use client';

import type { ListingColumn, ListingFilter, ListingSort, ListingViewDto } from '@inmolink/contracts';
// Plain lists, no zod in the client chunk (S4-F2); the page re-validates every filter from the URL.
import {
  LISTING_COLUMNS,
  LISTING_SORTS,
  LISTING_STATUSES,
  TRANSACTION_TYPES,
  VISIBILITIES,
} from '@inmolink/contracts/values';
import { Button, Input, Label } from '@inmolink/ui';
import { type FormEvent, useState, useTransition } from 'react';
import { Link, useRouter } from '@/i18n/navigation';
import { deleteViewAction, saveViewAction } from './actions';
import { centsOf, listSearch, viewHref } from './list-query';
import type { Option, OptionGroup } from './taxonomy';
import { makeT } from './values';

const SELECT = 'h-9 w-full rounded-md border bg-background px-3 text-sm';

export interface ListingsToolbarProps {
  state: { filter: ListingFilter; sort: ListingSort; columns: ListingColumn[] };
  propertyTypes: OptionGroup[];
  locations: Option[];
  members: Option[];
  views: ListingViewDto[];
  messages: Record<string, unknown>;
}

/**
 * Filters, sort, columns and saved views of the listing list (S3-07). Every change becomes the URL (the server
 * page reads it), so the back button, links and saved views all work the same way.
 */
export function ListingsToolbar(props: ListingsToolbarProps) {
  const t = makeT(props.messages);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [viewName, setViewName] = useState('');
  const [viewError, setViewError] = useState<string | null>(null);
  const { filter, sort, columns } = props.state;

  const go = (next: { filter?: ListingFilter; sort?: ListingSort; columns?: ListingColumn[] }) => {
    const search = listSearch({ filter, sort, columns, ...next });
    startTransition(() => router.push(search ? `/listings?${search}` : '/listings'));
  };

  const applyFilters = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim();
    const raw = {
      q: text('q') || undefined,
      status: text('status') || undefined,
      visibility: text('visibility') || undefined,
      transactionType: text('transactionType') || undefined,
      propertyTypeId: text('propertyTypeId') || undefined,
      locationId: text('locationId') || undefined,
      ownerUserId: text('ownerUserId') || undefined,
      mine: form.get('mine') === 'on' ? true : undefined,
      priceMin: centsOf(text('priceMin')),
      priceMax: centsOf(text('priceMax')),
      bedroomsMin: text('bedroomsMin') || undefined,
      tag: text('tag') || undefined,
    };
    // The URL carries the values as typed; the page parses each one and drops what is invalid (`parseListState`).
    go({ filter: Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)) as ListingFilter });
  };

  const toggleColumn = (column: ListingColumn, on: boolean) => {
    const next = on
      ? LISTING_COLUMNS.filter((c) => c === column || columns.includes(c))
      : columns.filter((c) => c !== column);
    if (next.length > 0) go({ columns: next });
  };

  const saveView = () => {
    setViewError(null);
    startTransition(async () => {
      const res = await saveViewAction({ name: viewName, query: { ...filter, sort }, columns });
      if (!res.ok) {
        setViewError(t(`errors.${res.code}`));
        return;
      }
      setViewName('');
      router.refresh();
    });
  };

  const removeView = (id: string) =>
    startTransition(async () => {
      const res = await deleteViewAction(id);
      if (!res.ok) setViewError(t(`errors.${res.code}`));
      router.refresh();
    });

  const euros = (cents: number | undefined) => (cents === undefined ? '' : String(Math.round(cents / 100)));

  return (
    <div className="flex flex-col gap-3" aria-busy={pending}>
      {props.views.length > 0 ? (
        <nav aria-label={t('views.title')} className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t('views.title')}:</span>
          {props.views.map((v) => (
            <span key={v.id} className="inline-flex items-center gap-1 rounded-full border px-3 py-1">
              <Link href={viewHref(v)} className="underline-offset-4 hover:underline">
                {v.name}
              </Link>
              <button
                type="button"
                className="text-muted-foreground hover:text-destructive"
                aria-label={t('views.delete', { name: v.name })}
                onClick={() => removeView(v.id)}
              >
                ×
              </button>
            </span>
          ))}
        </nav>
      ) : null}

      <form
        onSubmit={applyFilters}
        className="grid grid-cols-2 gap-3 rounded-md border p-3 md:grid-cols-4 lg:grid-cols-6"
        data-testid="listing-filters"
        // a new URL brings new defaults: remount the uncontrolled fields
        key={listSearch({ filter })}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor="f-q">{t('filters.q')}</Label>
          <Input id="f-q" name="q" defaultValue={filter.q ?? ''} maxLength={16} className="h-9" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="f-status">{t('editor.fields.status')}</Label>
          <select id="f-status" name="status" className={SELECT} defaultValue={filter.status ?? ''}>
            <option value="">{t('filters.any')}</option>
            {LISTING_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`editor.options.status.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="f-visibility">{t('editor.fields.visibility')}</Label>
          <select id="f-visibility" name="visibility" className={SELECT} defaultValue={filter.visibility ?? ''}>
            <option value="">{t('filters.any')}</option>
            {VISIBILITIES.map((v) => (
              <option key={v} value={v}>
                {t(`editor.options.visibility.${v}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="f-transaction">{t('editor.fields.transactionType')}</Label>
          <select
            id="f-transaction"
            name="transactionType"
            className={SELECT}
            defaultValue={filter.transactionType ?? ''}
          >
            <option value="">{t('filters.any')}</option>
            {TRANSACTION_TYPES.map((v) => (
              <option key={v} value={v}>
                {t(`editor.options.transactionType.${v}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="f-type">{t('editor.fields.propertyTypeId')}</Label>
          <select id="f-type" name="propertyTypeId" className={SELECT} defaultValue={filter.propertyTypeId ?? ''}>
            <option value="">{t('filters.any')}</option>
            {props.propertyTypes.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="f-location">{t('editor.fields.locationId')}</Label>
          <select id="f-location" name="locationId" className={SELECT} defaultValue={filter.locationId ?? ''}>
            <option value="">{t('filters.any')}</option>
            {props.locations.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="f-price-min">{t('filters.priceMin')}</Label>
          <Input
            id="f-price-min"
            name="priceMin"
            inputMode="numeric"
            defaultValue={euros(filter.priceMin)}
            className="h-9"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="f-price-max">{t('filters.priceMax')}</Label>
          <Input
            id="f-price-max"
            name="priceMax"
            inputMode="numeric"
            defaultValue={euros(filter.priceMax)}
            className="h-9"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="f-bedrooms">{t('filters.bedroomsMin')}</Label>
          <Input
            id="f-bedrooms"
            name="bedroomsMin"
            type="number"
            min={0}
            max={1000}
            defaultValue={filter.bedroomsMin ?? ''}
            className="h-9"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="f-tag">{t('filters.tag')}</Label>
          <Input id="f-tag" name="tag" maxLength={40} defaultValue={filter.tag ?? ''} className="h-9" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="f-owner">{t('columns.owner')}</Label>
          <select id="f-owner" name="ownerUserId" className={SELECT} defaultValue={filter.ownerUserId ?? ''}>
            <option value="">{t('filters.any')}</option>
            {props.members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input type="checkbox" name="mine" defaultChecked={filter.mine === true} />
          {t('mine')}
        </label>
        <div className="col-span-2 flex items-end gap-2 md:col-span-4 lg:col-span-6">
          <Button type="submit" size="sm" disabled={pending}>
            {t('filters.apply')}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => go({ filter: {} })}>
            {t('filters.clear')}
          </Button>
        </div>
      </form>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="l-sort">{t('sort.label')}</Label>
          <select
            id="l-sort"
            className={SELECT}
            value={sort}
            onChange={(e) => go({ sort: e.target.value as ListingSort })}
          >
            {LISTING_SORTS.map((s) => (
              <option key={s} value={s}>
                {t(`sort.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <details className="relative">
          <summary className="cursor-pointer rounded-md border px-3 py-2 text-sm">{t('columns.choose')}</summary>
          <fieldset className="absolute z-10 mt-1 grid w-56 gap-1 rounded-md border bg-background p-3 shadow">
            <legend className="sr-only">{t('columns.choose')}</legend>
            {LISTING_COLUMNS.map((c) => (
              <label key={c} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={columns.includes(c)}
                  disabled={c === 'ref'}
                  onChange={(e) => toggleColumn(c, e.target.checked)}
                />
                {t(`columns.${c}`)}
              </label>
            ))}
          </fieldset>
        </details>
        <div className="flex items-end gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="v-name">{t('views.name')}</Label>
            <Input
              id="v-name"
              value={viewName}
              maxLength={60}
              onChange={(e) => setViewName(e.target.value)}
              className="h-9"
            />
          </div>
          <Button type="button" size="sm" variant="outline" disabled={pending || !viewName.trim()} onClick={saveView}>
            {t('views.save')}
          </Button>
        </div>
        {viewError ? (
          <p role="alert" className="text-sm text-destructive">
            {viewError}
          </p>
        ) : null}
      </div>
    </div>
  );
}
