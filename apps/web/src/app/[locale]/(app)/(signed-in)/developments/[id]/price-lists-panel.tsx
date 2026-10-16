'use client';

import type { PriceListDiff, PriceListDto } from '@inmolink/contracts';
import { Button, Input, Label } from '@inmolink/ui';
import { useRouter } from 'next/navigation';
import { useFormatter } from 'next-intl';
import { type ChangeEvent, useId, useState, useTransition } from 'react';
import { makeT } from '../../listings/values';
import { approvePriceListAction, createPriceListAction, type DevResult } from '../actions';
import { type CsvPriceEntry, type CsvProblem, priceListFromCsv } from '../csv';
import { CsvReport } from './units-panel';

interface Props {
  developmentId: string;
  currency: string;
  /** Newest first, as the API lists them. */
  initial: PriceListDto[];
  messages: Record<string, unknown>;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * The development's price lists (S4-03): a CSV upload becomes the next version with its diff against the units
 * as they are (new references, missing ones, changed prices or statuses); the diff view shows it, and approving
 * the latest version applies its prices and statuses (the page then reloads the units). New and missing
 * references are not applied: the person creates or deletes those units (S4-02 decision 3).
 */
export default function PriceListsPanel({ developmentId, currency, initial, messages }: Props) {
  const t = makeT(messages);
  const format = useFormatter();
  const router = useRouter();
  const ids = useId();
  const [lists, setLists] = useState(initial);
  const [open, setOpen] = useState<number | null>(initial[0]?.version ?? null);
  const [csv, setCsv] = useState<{ entries: CsvPriceEntry[]; problems: CsvProblem[] } | null>(null);
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [status, setStatus] = useState<{ kind: 'error' | 'saved'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const fail = (res: Extract<DevResult<unknown>, { ok: false }>) => {
    if (res.revoked) return window.location.reload();
    const key = `errors.${res.code}`;
    const text = t(key);
    setStatus({ kind: 'error', text: text === key ? t('errors.generic') : text });
  };

  const readCsv = async (e: ChangeEvent<HTMLInputElement>) => {
    setStatus(null);
    const file = e.target.files?.[0];
    setCsv(file ? priceListFromCsv(await file.text()) : null);
  };

  const upload = () => {
    if (!csv || csv.entries.length === 0) return;
    setStatus(null);
    startTransition(async () => {
      const res = await createPriceListAction(developmentId, {
        effectiveFrom,
        extractedBy: 'HUMAN',
        entries: csv.entries,
      });
      if (!res.ok) return fail(res);
      setLists((all) => [res.data, ...all.filter((l) => l.version !== res.data.version)]);
      setOpen(res.data.version);
      setCsv(null);
      setStatus({ kind: 'saved', text: t('priceLists.uploaded', { version: String(res.data.version) }) });
    });
  };

  const approve = (version: number) => {
    setStatus(null);
    startTransition(async () => {
      const res = await approvePriceListAction(developmentId, version);
      if (!res.ok) return fail(res);
      setLists((all) => all.map((l) => (l.version === version ? res.data : l)));
      setStatus({ kind: 'saved', text: t('priceLists.approved', { version: String(version) }) });
      // The units changed and the development was marked verified.
      router.refresh();
    });
  };

  const latest = lists[0]?.version ?? null;
  const shown = lists.find((l) => l.version === open) ?? null;
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });

  return (
    <section aria-labelledby={`${ids}-h`} className="flex flex-col gap-3 rounded-md border p-4">
      <div>
        <h2 id={`${ids}-h`} className="text-base font-semibold">
          {t('priceLists.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('priceLists.intro')}</p>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">{t('priceLists.hint')}</p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${ids}-csv`}>{t('priceLists.file')}</Label>
            <input id={`${ids}-csv`} type="file" accept=".csv,text/csv" className="text-sm" onChange={readCsv} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${ids}-from`}>{t('priceLists.effectiveFrom')}</Label>
            <Input
              id={`${ids}-from`}
              type="date"
              className="h-9 w-44"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
            />
          </div>
          {csv && csv.problems.length === 0 ? (
            <Button type="button" size="sm" disabled={pending || !effectiveFrom} onClick={upload}>
              {t('priceLists.upload')}
            </Button>
          ) : null}
        </div>
        {csv ? (
          <CsvReport csv={csv} ready={t('priceLists.ready', { count: String(csv.entries.length) })} t={t} />
        ) : null}
      </div>

      {lists.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('priceLists.empty')}</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border text-sm">
          {lists.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <button
                type="button"
                className="text-left underline-offset-4 hover:underline"
                aria-expanded={open === l.version}
                onClick={() => setOpen(open === l.version ? null : l.version)}
              >
                {t('priceLists.version', { version: String(l.version) })} ·{' '}
                {t('priceLists.effective', { date: date(`${l.effectiveFrom}T12:00:00Z`) })}
              </button>
              <span className="flex items-center gap-2 text-muted-foreground">
                {l.reviewedAt ? t('priceLists.approvedAt', { date: date(l.reviewedAt) }) : t('priceLists.pending')}
                {!l.reviewedAt && l.version === latest ? (
                  <Button type="button" size="sm" disabled={pending} onClick={() => approve(l.version)}>
                    {t('priceLists.approve')}
                  </Button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}

      {shown ? <DiffView list={shown} currency={currency} t={t} /> : null}

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

function DiffView({ list, currency, t }: { list: PriceListDto; currency: string; t: ReturnType<typeof makeT> }) {
  const format = useFormatter();
  const ids = useId();
  const price = (cents: number | null) =>
    cents === null ? t('priceOnRequest') : format.number(cents / 100, { style: 'currency', currency });
  const diff: PriceListDiff = list.diff;
  const empty = diff.added.length + diff.removed.length + diff.changed.length === 0;
  const CELL = 'px-2 py-1';

  return (
    <section aria-labelledby={`${ids}-h`} className="flex flex-col gap-3" data-testid="price-list-diff">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={`${ids}-h`} className="text-sm font-semibold">
          {t('priceLists.diff.title', { version: String(list.version) })}
        </h3>
        <span className="text-xs text-muted-foreground">
          {t('priceLists.diff.unchanged', { count: String(diff.unchanged) })}
        </span>
      </div>
      {empty ? <p className="text-sm text-muted-foreground">{t('priceLists.diff.none')}</p> : null}
      {diff.changed.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h4 className="text-sm font-medium">
            {t('priceLists.diff.changed', { count: String(diff.changed.length) })}
          </h4>
          <table className="w-full text-sm" data-testid="diff-changed">
            <thead className="text-left">
              <tr className="border-b">
                <th className={CELL}>{t('priceLists.diff.ref')}</th>
                <th className={CELL}>{t('priceLists.diff.price')}</th>
                <th className={CELL}>{t('priceLists.diff.status')}</th>
              </tr>
            </thead>
            <tbody>
              {diff.changed.map((c) => (
                <tr key={c.unitId} className="border-b last:border-0">
                  <td className={`${CELL} font-mono`}>{c.ref}</td>
                  <td className={CELL}>
                    {c.priceCents
                      ? t('priceLists.diff.arrow', { from: price(c.priceCents.from), to: price(c.priceCents.to) })
                      : '—'}
                  </td>
                  <td className={CELL}>
                    {c.status
                      ? t('priceLists.diff.arrow', {
                          from: t(`options.unitStatus.${c.status.from}`),
                          to: t(`options.unitStatus.${c.status.to}`),
                        })
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {diff.added.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h4 className="text-sm font-medium">{t('priceLists.diff.added', { count: String(diff.added.length) })}</h4>
          <p className="text-xs text-muted-foreground">{t('priceLists.diff.addedHint')}</p>
          <ul className="flex flex-wrap gap-2 text-sm" data-testid="diff-added">
            {diff.added.map((a) => (
              <li key={a.ref} className="rounded bg-muted px-2 py-0.5">
                <span className="font-mono">{a.ref}</span> · {price(a.priceCents)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {diff.removed.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h4 className="text-sm font-medium">
            {t('priceLists.diff.removed', { count: String(diff.removed.length) })}
          </h4>
          <p className="text-xs text-muted-foreground">{t('priceLists.diff.removedHint')}</p>
          <ul className="flex flex-wrap gap-2 text-sm" data-testid="diff-removed">
            {diff.removed.map((r) => (
              <li key={r.unitId} className="rounded bg-muted px-2 py-0.5">
                <span className="font-mono">{r.ref}</span> · {price(r.priceCents)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
