'use client';

import {
  type ListingBulkDto,
  type ListingColumn,
  type ListingFilter,
  ListingStatus,
  ShareScope,
  Visibility,
} from '@inmolink/contracts';
import { Button, Input, Label } from '@inmolink/ui';
import { useEffect, useRef, useState, useTransition } from 'react';
import { Link, useRouter } from '@/i18n/navigation';
import { bulkProgressAction, startBulkAction } from './actions';
import { ACTION_TYPES, type ActionType, bulkActionOf } from './bulk-action';
import type { Option } from './taxonomy';
import { makeT } from './values';

const SELECT = 'h-9 rounded-md border bg-background px-3 text-sm';
/** Progress polls back off from 1 s to 5 s and stop after 10 minutes (the record is failed if the job is lost). */
const POLL_FIRST_MS = 1_000;
const POLL_MAX_MS = 5_000;
const POLL_FOR_MS = 10 * 60_000;

export interface ListingRowView {
  id: string;
  /** Formatted on the server, per shown column. */
  cells: Record<ListingColumn, string>;
}

export interface ListingsTableProps {
  rows: ListingRowView[];
  columns: ListingColumn[];
  /** The list's filters: "every matching listing" targets them. */
  filter: ListingFilter;
  members: Option[];
  messages: Record<string, unknown>;
}

/**
 * The listing rows with selection (S3-07) and the bulk bar: pick an action for the selected rows or for every
 * listing matching the filters (≤ 5,000), then follow the job's progress until it is done.
 */
export function ListingsTable(props: ListingsTableProps) {
  const t = makeT(props.messages);
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [type, setType] = useState<ActionType>('STATUS');
  const [value, setValue] = useState('');
  const [bulk, setBulk] = useState<ListingBulkDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const [pending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);
  // A new page or filter starts with nothing selected.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the rows change
  useEffect(() => {
    setSelected(new Set());
    setAllMatching(false);
  }, [props.rows]);

  const running = bulk !== null && (bulk.state === 'QUEUED' || bulk.state === 'RUNNING');
  const action = bulkActionOf(type, value);
  const count = allMatching ? null : selected.size;
  const everyOnPage = props.rows.length > 0 && props.rows.every((r) => selected.has(r.id));

  const poll = (id: string, delay = POLL_FIRST_MS, since = Date.now()) => {
    timer.current = setTimeout(async () => {
      const res = await bulkProgressAction(id);
      if (!res.ok) {
        setError(t(`errors.${res.code}`));
        return;
      }
      setBulk(res.data);
      if (res.data.state !== 'QUEUED' && res.data.state !== 'RUNNING') {
        router.refresh();
        return;
      }
      if (Date.now() - since > POLL_FOR_MS) setGaveUp(true);
      else poll(id, Math.min(delay * 1.5, POLL_MAX_MS), since);
    }, delay);
  };

  const start = () => {
    if (!action) return;
    setError(null);
    startTransition(async () => {
      const target = allMatching ? { filter: props.filter } : { ids: [...selected] };
      const res = await startBulkAction({ action, target });
      if (!res.ok) {
        setError(t(`errors.${res.code}`));
        return;
      }
      setBulk(res.data);
      setGaveUp(false);
      poll(res.data.id);
    });
  };

  const toggle = (id: string, on: boolean) => {
    setAllMatching(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const valueField = () => {
    const common = {
      id: 'bulk-value',
      value,
      onChange: (e: { target: { value: string } }) => setValue(e.target.value),
    };
    const options = (values: readonly string[], label: (v: string) => string) => (
      <select {...common} className={SELECT}>
        <option value="">{t('bulk.choose')}</option>
        {values.map((v) => (
          <option key={v} value={v}>
            {label(v)}
          </option>
        ))}
      </select>
    );
    switch (type) {
      case 'STATUS':
        return options(ListingStatus.options, (v) => t(`editor.options.status.${v}`));
      case 'VISIBILITY':
        return options(Visibility.options, (v) => t(`editor.options.visibility.${v}`));
      case 'SHARE_SCOPE':
        return options(ShareScope.options, (v) => t(`editor.options.shareScope.${v}`));
      case 'ASSIGN':
        return options(
          props.members.map((m) => m.id),
          (id) => props.members.find((m) => m.id === id)?.label ?? id,
        );
      case 'PRICE_CHANGE':
        return <Input {...common} inputMode="decimal" placeholder="-5" className="h-9 w-28" />;
      case 'ADD_TAG':
        return <Input {...common} maxLength={40} className="h-9 w-48" />;
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3 rounded-md border p-3" data-testid="bulk-bar">
        <p className="self-center text-sm">
          {count === null ? t('bulk.allMatching') : t('bulk.selected', { count: String(count) })}
        </p>
        <div className="flex flex-col gap-1">
          <Label htmlFor="bulk-type">{t('bulk.action')}</Label>
          <select
            id="bulk-type"
            className={SELECT}
            value={type}
            onChange={(e) => {
              setType(e.target.value as ActionType);
              setValue('');
            }}
          >
            {ACTION_TYPES.map((a) => (
              <option key={a} value={a}>
                {t(`bulk.types.${a}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="bulk-value">{t(`bulk.values.${type}`)}</Label>
          {valueField()}
        </div>
        <Button
          type="button"
          size="sm"
          disabled={pending || running || !action || (count !== null && count === 0)}
          onClick={start}
        >
          {t('bulk.apply')}
        </Button>
        {!allMatching ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => setAllMatching(true)}>
            {t('bulk.selectAllMatching')}
          </Button>
        ) : null}
      </div>

      {bulk ? (
        <div
          className="flex flex-col gap-1 rounded-md border p-3 text-sm"
          aria-live="polite"
          data-testid="bulk-progress"
        >
          <progress className="w-full" max={bulk.total} value={bulk.processed} aria-label={t('bulk.progressLabel')} />
          <p>
            {running
              ? t(gaveUp ? 'bulk.stillRunning' : 'bulk.running', {
                  processed: String(bulk.processed),
                  total: String(bulk.total),
                })
              : bulk.state === 'FAILED'
                ? t('bulk.failedAll')
                : t('bulk.done', {
                    succeeded: String(bulk.succeeded),
                    unchanged: String(bulk.unchanged),
                    failed: String(bulk.failed),
                  })}
          </p>
          {bulk.failures.length > 0 ? (
            <ul className="list-inside list-disc text-muted-foreground">
              {Object.entries(
                bulk.failures.reduce<Record<string, number>>((acc, f) => {
                  acc[f.code] = (acc[f.code] ?? 0) + 1;
                  return acc;
                }, {}),
              ).map(([code, n]) => (
                <li key={code}>{t('bulk.failureLine', { reason: t(`errors.${code}`), count: String(n) })}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm" data-testid="listings-table">
          <thead className="bg-muted text-left">
            <tr>
              <th className="w-8 p-2">
                <input
                  type="checkbox"
                  aria-label={t('bulk.selectPage')}
                  checked={everyOnPage}
                  onChange={(e) => {
                    setAllMatching(false);
                    setSelected(e.target.checked ? new Set(props.rows.map((r) => r.id)) : new Set());
                  }}
                />
              </th>
              {props.columns.map((c) => (
                <th key={c} className="p-2 font-medium">
                  {t(`columns.${c}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {props.rows.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="p-2">
                  <input
                    type="checkbox"
                    aria-label={t('bulk.selectRow', { ref: r.cells.ref })}
                    checked={allMatching || selected.has(r.id)}
                    onChange={(e) => toggle(r.id, e.target.checked)}
                  />
                </td>
                {props.columns.map((c) => (
                  <td key={c} className={c === 'ref' ? 'p-2 font-mono' : 'p-2'}>
                    {c === 'ref' ? (
                      <Link href={`/listings/${r.id}`} className="underline-offset-4 hover:underline">
                        {r.cells.ref}
                      </Link>
                    ) : (
                      r.cells[c]
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
