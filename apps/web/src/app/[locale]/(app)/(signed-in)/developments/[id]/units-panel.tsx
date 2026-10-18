'use client';

import type { UnitDto, UnitPage } from '@inmolink/contracts';
import { Button, Input, Label } from '@inmolink/ui';
import { useFormatter } from 'next-intl';
import { type ChangeEvent, useId, useState, useTransition } from 'react';
import type { Option } from '../../listings/taxonomy';
import { makeT } from '../../listings/values';
import {
  bulkUnitsAction,
  createUnitsAction,
  type DevResult,
  deleteUnitAction,
  saveUnitAction,
  unitsPageAction,
} from '../actions';
import {
  type CsvProblem,
  type CsvUnit,
  csvSizeProblem,
  priceToCents,
  type UnitStatusValue,
  unitsFromCsv,
} from '../csv';

const SELECT = 'h-8 rounded-md border bg-background px-2 text-sm disabled:opacity-60';
const STATUSES: UnitStatusValue[] = ['AVAILABLE', 'RESERVED', 'SOLD'];
/** Problems listed before "…and N more". */
const SHOWN_PROBLEMS = 10;

interface Props {
  developmentId: string;
  currency: string;
  initial: UnitPage;
  propertyTypes: Option[];
  readOnly: boolean;
  messages: Record<string, unknown>;
}

interface RowDraft {
  price: string;
  status: UnitStatusValue;
}

const majorOf = (u: UnitDto) => (u.price ? String(u.price.amountCents / 100) : '');

/**
 * The development's units (S4-03), 100 per page in reference order (keyset: first / next page, never more rows
 * than one page, so no virtualization). Price and status edit inline and save per row with the unit's version;
 * ticked rows change status together (bulk, ≤ 500); a CSV adds up to 500 units at once after it is checked here.
 */
export function UnitsPanel({ developmentId, currency, initial, propertyTypes, readOnly, messages }: Props) {
  const t = makeT(messages);
  const format = useFormatter();
  const ids = useId();
  const [page, setPage] = useState(initial);
  const [cursor, setCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<'' | UnitStatusValue>('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkStatus, setBulkStatus] = useState<UnitStatusValue>('RESERVED');
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [csv, setCsv] = useState<{ units: CsvUnit[]; problems: CsvProblem[] } | null>(null);
  const [status, setStatus] = useState<{ kind: 'error' | 'saved'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const typeName = new Map(propertyTypes.map((o) => [o.id, o.label]));
  const typeByName = new Map(propertyTypes.map((o) => [o.label.toLowerCase(), o.id]));
  const typeId = (v: string) => (typeName.has(v) ? v : (typeByName.get(v.toLowerCase()) ?? null));
  const money = (cents: number) => format.number(cents / 100, { style: 'currency', currency });

  const fail = (res: Extract<DevResult<unknown>, { ok: false }>) => {
    if (res.revoked) return window.location.reload();
    const key = `errors.${res.code}`;
    const text = t(key);
    setStatus({ kind: 'error', text: text === key ? t('errors.generic') : text });
  };

  const load = (at: string | null, st: '' | UnitStatusValue) =>
    startTransition(async () => {
      const res = await unitsPageAction(developmentId, at, st);
      if (!res.ok) return fail(res);
      setPage(res.data);
      setCursor(at);
      setSelected(new Set());
      setDrafts({});
    });

  const replace = (updated: UnitDto[]) => {
    const byId = new Map(updated.map((u) => [u.id, u]));
    setPage((p) => ({ ...p, items: p.items.map((u) => byId.get(u.id) ?? u) }));
    setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([id]) => !byId.has(id))));
  };

  const draftOf = (u: UnitDto): RowDraft => drafts[u.id] ?? { price: majorOf(u), status: u.status };
  const dirty = (u: UnitDto) => {
    const d = drafts[u.id];
    return d !== undefined && (d.price !== majorOf(u) || d.status !== u.status);
  };

  const saveRow = (u: UnitDto) => {
    const d = draftOf(u);
    const cents = priceToCents(d.price);
    if (cents === undefined) return setStatus({ kind: 'error', text: t('errors.VALIDATION_FAILED') });
    setStatus(null);
    startTransition(async () => {
      const body: Record<string, unknown> = { version: u.version };
      if (d.price !== majorOf(u)) body.priceCents = cents;
      if (d.status !== u.status) body.status = d.status;
      const res = await saveUnitAction(developmentId, u.id, body);
      if (!res.ok) return fail(res);
      replace([res.data]);
      setStatus({ kind: 'saved', text: t('units.saved', { ref: u.ref }) });
    });
  };

  const removeRow = (u: UnitDto) => {
    setStatus(null);
    startTransition(async () => {
      const res = await deleteUnitAction(developmentId, u.id);
      if (!res.ok) return fail(res);
      setPage((p) => ({ ...p, items: p.items.filter((x) => x.id !== u.id) }));
      setSelected((s) => new Set([...s].filter((id) => id !== u.id)));
      setStatus({ kind: 'saved', text: t('units.deleted', { ref: u.ref }) });
    });
  };

  const applyBulk = () => {
    setStatus(null);
    startTransition(async () => {
      const res = await bulkUnitsAction(developmentId, { unitIds: [...selected], patch: { status: bulkStatus } });
      if (!res.ok) return fail(res);
      replace(res.data.items);
      setSelected(new Set());
      setStatus({ kind: 'saved', text: t('units.bulkDone', { count: String(res.data.items.length) }) });
    });
  };

  const readCsv = async (e: ChangeEvent<HTMLInputElement>) => {
    setStatus(null);
    const file = e.target.files?.[0];
    const tooLarge = file ? csvSizeProblem(file.size) : null;
    if (tooLarge) return setCsv({ units: [], problems: [tooLarge] });
    setCsv(file ? unitsFromCsv(await file.text(), typeId) : null);
  };

  const importCsv = () => {
    if (!csv || csv.units.length === 0) return;
    setStatus(null);
    startTransition(async () => {
      const res = await createUnitsAction(developmentId, { units: csv.units });
      if (!res.ok) return fail(res);
      setCsv(null);
      setStatus({ kind: 'saved', text: t('units.import.done', { count: String(res.data.items.length) }) });
      const first = await unitsPageAction(developmentId, null, filter);
      if (first.ok) {
        setPage(first.data);
        setCursor(null);
        setSelected(new Set());
      }
    });
  };

  const allTicked = page.items.length > 0 && page.items.every((u) => selected.has(u.id));
  const dash = '—';

  return (
    <section aria-labelledby={`${ids}-h`} className="flex flex-col gap-3 rounded-md border p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id={`${ids}-h`} className="text-base font-semibold">
          {t('units.title')}
        </h2>
        <div className="flex items-center gap-2">
          <Label htmlFor={`${ids}-filter`}>{t('units.filter')}</Label>
          <select
            id={`${ids}-filter`}
            className={SELECT}
            value={filter}
            disabled={pending}
            onChange={(e) => {
              const st = e.target.value as '' | UnitStatusValue;
              setFilter(st);
              load(null, st);
            }}
          >
            <option value="">{t('units.all')}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`options.unitStatus.${s}`)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {readOnly || selected.size === 0 ? null : (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted p-2 text-sm">
          <span data-testid="units-selected">{t('units.selected', { count: String(selected.size) })}</span>
          <Label htmlFor={`${ids}-bulk`}>{t('units.markAs')}</Label>
          <select
            id={`${ids}-bulk`}
            className={SELECT}
            value={bulkStatus}
            onChange={(e) => setBulkStatus(e.target.value as UnitStatusValue)}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`options.unitStatus.${s}`)}
              </option>
            ))}
          </select>
          <Button type="button" size="sm" disabled={pending} onClick={applyBulk}>
            {t('units.apply')}
          </Button>
        </div>
      )}

      {page.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('units.empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="units-table">
            <thead className="text-left">
              <tr className="border-b">
                {readOnly ? null : (
                  <th className="px-2 py-1.5">
                    <input
                      type="checkbox"
                      aria-label={t('units.selectAll')}
                      checked={allTicked}
                      onChange={(e) => setSelected(e.target.checked ? new Set(page.items.map((u) => u.id)) : new Set())}
                    />
                  </th>
                )}
                {(['ref', 'type', 'bedrooms', 'bathrooms', 'internalM2', 'floor', 'price', 'status'] as const).map(
                  (c) => (
                    <th key={c} className="px-2 py-1.5 font-medium">
                      {t(`units.columns.${c}`)}
                    </th>
                  ),
                )}
                {readOnly ? null : (
                  <th className="px-2 py-1.5 font-medium">
                    <span className="sr-only">{t('units.columns.actions')}</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {page.items.map((u) => {
                const d = draftOf(u);
                const edit = (patch: Partial<RowDraft>) => setDrafts((all) => ({ ...all, [u.id]: { ...d, ...patch } }));
                return (
                  <tr key={u.id} className="border-b last:border-0" data-testid={`unit-${u.ref}`}>
                    {readOnly ? null : (
                      <td className="px-2 py-1">
                        <input
                          type="checkbox"
                          aria-label={t('units.select', { ref: u.ref })}
                          checked={selected.has(u.id)}
                          onChange={(e) =>
                            setSelected((s) => {
                              const next = new Set(s);
                              if (e.target.checked) next.add(u.id);
                              else next.delete(u.id);
                              return next;
                            })
                          }
                        />
                      </td>
                    )}
                    <td className="px-2 py-1 font-mono">{u.ref}</td>
                    <td className="px-2 py-1">{typeName.get(u.propertyTypeId) ?? dash}</td>
                    <td className="px-2 py-1">{u.bedrooms ?? dash}</td>
                    <td className="px-2 py-1">{u.bathrooms ?? dash}</td>
                    <td className="px-2 py-1">{u.internalM2 === null ? dash : format.number(u.internalM2)}</td>
                    <td className="px-2 py-1">{u.floor ?? dash}</td>
                    <td className="px-2 py-1">
                      {readOnly ? (
                        u.price ? (
                          money(u.price.amountCents)
                        ) : (
                          t('priceOnRequest')
                        )
                      ) : (
                        <Input
                          className="h-8 w-32"
                          inputMode="decimal"
                          aria-label={t('units.priceOf', { ref: u.ref })}
                          placeholder={t('priceOnRequest')}
                          value={d.price}
                          onChange={(e) => edit({ price: e.target.value })}
                        />
                      )}
                    </td>
                    <td className="px-2 py-1">
                      {readOnly ? (
                        t(`options.unitStatus.${u.status}`)
                      ) : (
                        <select
                          className={SELECT}
                          aria-label={t('units.statusOf', { ref: u.ref })}
                          value={d.status}
                          onChange={(e) => edit({ status: e.target.value as UnitStatusValue })}
                        >
                          {STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {t(`options.unitStatus.${s}`)}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    {readOnly ? null : (
                      <td className="px-2 py-1">
                        <div className="flex gap-1">
                          {dirty(u) ? (
                            <Button type="button" size="sm" disabled={pending} onClick={() => saveRow(u)}>
                              {t('units.save')}
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={pending}
                            aria-label={t('units.delete', { ref: u.ref })}
                            onClick={() => removeRow(u)}
                          >
                            ×
                          </Button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex justify-end gap-3 text-sm">
        {cursor ? (
          <button type="button" className="underline-offset-4 hover:underline" onClick={() => load(null, filter)}>
            {t('units.first')}
          </button>
        ) : null}
        {page.nextCursor ? (
          <button
            type="button"
            className="underline-offset-4 hover:underline"
            onClick={() => load(page.nextCursor, filter)}
          >
            {t('units.next')}
          </button>
        ) : null}
      </div>

      {readOnly ? null : (
        <div className="flex flex-col gap-2 border-t pt-3">
          <h3 className="text-sm font-semibold">{t('units.import.title')}</h3>
          <p className="text-xs text-muted-foreground">{t('units.import.hint')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor={`${ids}-csv`} className="sr-only">
              {t('units.import.file')}
            </Label>
            <input id={`${ids}-csv`} type="file" accept=".csv,text/csv" className="text-sm" onChange={readCsv} />
            {csv && csv.problems.length === 0 ? (
              <Button type="button" size="sm" disabled={pending} onClick={importCsv}>
                {t('units.import.submit')}
              </Button>
            ) : null}
          </div>
          {csv ? (
            <CsvReport csv={csv} ready={t('units.import.ready', { count: String(csv.units.length) })} t={t} />
          ) : null}
        </div>
      )}

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

/** What a checked CSV holds: the count ready to send, or its problems by line and column. */
export function CsvReport({
  csv,
  ready,
  t,
}: {
  csv: { problems: CsvProblem[] };
  ready: string;
  t: ReturnType<typeof makeT>;
}) {
  if (csv.problems.length === 0) return <p className="text-sm">{ready}</p>;
  return (
    <ul role="alert" className="list-disc pl-5 text-sm text-destructive">
      {csv.problems.slice(0, SHOWN_PROBLEMS).map((p) => (
        <li key={`${p.line}-${p.column}-${p.reason}`}>
          {t('csv.problem', { line: String(p.line), column: p.column, reason: t(`csv.reasons.${p.reason}`) })}
        </li>
      ))}
      {csv.problems.length > SHOWN_PROBLEMS ? (
        <li>{t('csv.more', { count: String(csv.problems.length - SHOWN_PROBLEMS) })}</li>
      ) : null}
    </ul>
  );
}
