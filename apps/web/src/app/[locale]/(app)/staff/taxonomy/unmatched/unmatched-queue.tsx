'use client';

import type { CatalogKind, StaffTaxonomyDto, UnmatchedDto, UnmatchedKind, UnmatchedPageDto } from '@inmolink/contracts';
import { Button, Input, Label } from '@inmolink/ui';
import { useId, useMemo, useRef, useState } from 'react';
import { Link } from '@/i18n/navigation';
import {
  createCatalogItemAction,
  ignoreUnmatchedAction,
  loadLocationChildrenAction,
  loadLocationPathAction,
  loadUnmatchedAction,
  mapUnmatchedAction,
} from '../actions';
import { makeT, type T } from '../translation-editor';
import {
  appendPage,
  type CatalogGroup,
  catalogOptions,
  childNodes,
  filterOptions,
  type LocationNode,
  locationLabel,
  newCatalogItem,
  type PickOption,
  pathLabel,
  QUEUE_PAGE_SIZE,
  rootLocationNodes,
} from './queue-logic';

/** The API's error code as text; an unknown code reads as the generic error. */
function errorText(t: T, code: string): string {
  const key = `errors.${code}`;
  const text = t(key);
  return text === key ? t('errors.generic') : text;
}

const selectClass = 'w-full rounded-md border bg-background p-1 text-sm';

/** A native list narrowed by a text input: keyboard and screen readers work, and no dependency is needed. */
function FilteredSelect({
  options,
  value,
  t,
  onPick,
}: {
  options: readonly PickOption[];
  value: string | null;
  t: T;
  onPick: (option: PickOption) => void;
}) {
  const [query, setQuery] = useState('');
  const uid = useId();
  const { shown, hidden } = filterOptions(options, query);
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`${uid}-filter`} className="text-xs">
        {t('unmatched.filter')}
      </Label>
      <Input id={`${uid}-filter`} value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
      <Label htmlFor={`${uid}-list`} className="text-xs">
        {t('unmatched.target')}
      </Label>
      <select
        id={`${uid}-list`}
        size={7}
        className={selectClass}
        value={value ?? ''}
        onChange={(e) => {
          const picked = options.find((o) => o.id === e.target.value);
          if (picked) onPick(picked);
        }}
      >
        {shown.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {shown.length === 0 ? <p className="text-xs text-muted-foreground">{t('unmatched.noMatch')}</p> : null}
      {hidden > 0 ? (
        <p className="text-xs text-muted-foreground">{t('unmatched.moreHidden', { count: String(hidden) })}</p>
      ) : null}
    </div>
  );
}

/**
 * The location tree one level at a time: countries and regions come with the page, cities and areas load when opened
 * (a region can have over 2,000 cities; the API has no search over the whole tree). Every option shows its path.
 */
function LocationPicker({
  roots,
  loaded,
  value,
  t,
  onPick,
  onError,
}: {
  roots: readonly LocationNode[];
  /** Children already loaded by id, shared by the rows. */
  loaded: Map<string, LocationNode[]>;
  value: string | null;
  t: T;
  onPick: (option: PickOption) => void;
  onError: (code: string) => void;
}) {
  const [trail, setTrail] = useState<LocationNode[]>([]);
  const [picked, setPicked] = useState<LocationNode | null>(null);
  const [busy, setBusy] = useState(false);
  const current = trail[trail.length - 1];
  const nodes = current ? (loaded.get(current.id) ?? []) : roots;
  const moveTo = (next: LocationNode[]) => {
    setTrail(next);
    setPicked(null);
  };
  const label = (n: LocationNode) => `${locationLabel(n)} (${t(`levels.${n.level}`)})`;
  const options = nodes.map((n) => ({ id: n.id, label: label(n) }));

  const open = async (node: LocationNode) => {
    if (!loaded.has(node.id)) {
      setBusy(true);
      const res = await loadLocationChildrenAction(node.id);
      setBusy(false);
      if (!res.ok) {
        onError(res.error);
        return;
      }
      loaded.set(node.id, childNodes(node, res.data.children));
    }
    moveTo([...trail, node]);
  };

  return (
    <div className="flex flex-col gap-2">
      <nav aria-label={t('unmatched.whereInTree')} className="flex flex-wrap items-center gap-1 text-xs">
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => moveTo([])}>
          {t('unmatched.allPlaces')}
        </Button>
        {trail.map((n, i) => (
          <Button
            key={n.id}
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            aria-current={i === trail.length - 1 ? 'location' : undefined}
            onClick={() => moveTo(trail.slice(0, i + 1))}
          >
            {`› ${n.name}`}
          </Button>
        ))}
      </nav>
      <FilteredSelect
        key={current?.id ?? 'root'}
        options={options}
        value={value}
        t={t}
        onPick={(o) => {
          setPicked(nodes.find((n) => n.id === o.id) ?? null);
          onPick(o);
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        disabled={busy || !picked || picked.childCount === 0}
        onClick={() => {
          if (picked) void open(picked);
        }}
      >
        {picked && picked.childCount > 0
          ? t('unmatched.openInside', { name: picked.name })
          : t('unmatched.openInsideNone')}
      </Button>
    </div>
  );
}

/** "Create new and map" of a property type or feature: the group is the only choice; the feed value is the name. */
function CreatePanel({
  value,
  kind,
  groups,
  busy,
  t,
  onCreate,
}: {
  value: string;
  kind: CatalogKind;
  groups: readonly CatalogGroup[];
  busy: boolean;
  t: T;
  onCreate: (groupId: string) => void;
}) {
  const [groupId, setGroupId] = useState(groups[0]?.id ?? '');
  const uid = useId();
  if (groups.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t('unmatched.noGroups')}{' '}
        <Link href="/staff/taxonomy" className="underline underline-offset-4">
          {t('unmatched.toEditor')}
        </Link>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">{t(`unmatched.createAs.${kind}`, { value })}</p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={uid} className="text-xs">
            {t('unmatched.group')}
          </Label>
          <select id={uid} className={selectClass} value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
        <Button type="button" size="sm" disabled={busy || !groupId} onClick={() => onCreate(groupId)}>
          {t('unmatched.createAndMap')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('unmatched.createHint')}</p>
    </div>
  );
}

function QueueRow({
  item,
  options,
  groups,
  roots,
  loaded,
  canWrite,
  newItemLocale,
  number,
  percent,
  t,
  onCreated,
  onDone,
}: {
  item: UnmatchedDto;
  options: readonly PickOption[];
  groups: readonly CatalogGroup[];
  roots: readonly LocationNode[];
  loaded: Map<string, LocationNode[]>;
  canWrite: boolean;
  newItemLocale: string;
  number: Intl.NumberFormat;
  percent: Intl.NumberFormat;
  t: T;
  onCreated: (groupId: string, created: { id: string; name: string }) => void;
  onDone: (id: string, message: string) => void;
}) {
  const isLocation = item.kind === 'location';
  const { candidate } = item;
  // A location's name repeats: its suggestion is chosen only once its path is on screen (`checkSuggestion`).
  const [target, setTarget] = useState<PickOption | null>(
    candidate && !isLocation
      ? { id: candidate.id, label: options.find((o) => o.id === candidate.id)?.label ?? candidate.name }
      : null,
  );
  const [panel, setPanel] = useState<'choose' | 'create' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fail = (code: string) => setError(errorText(t, code));
  const toggle = (next: 'choose' | 'create') => setPanel(panel === next ? null : next);

  const checkSuggestion = async () => {
    if (!candidate) return;
    setBusy(true);
    setError(null);
    const res = await loadLocationPathAction(candidate.id);
    setBusy(false);
    if (!res.ok) {
      fail(res.error);
      return;
    }
    const last = res.data[res.data.length - 1];
    const level = last ? ` (${t(`levels.${last.level}`)})` : '';
    setTarget({ id: candidate.id, label: `${pathLabel(res.data.map((s) => s.name))}${level}` });
  };

  const map = async (targetId: string, label: string) => {
    setBusy(true);
    setError(null);
    const res = await mapUnmatchedAction(item.id, { targetId });
    setBusy(false);
    if (res.ok) onDone(item.id, t('unmatched.mapped', { value: item.value, target: label }));
    else fail(res.error);
  };

  const ignore = async () => {
    setBusy(true);
    setError(null);
    const res = await ignoreUnmatchedAction(item.id);
    setBusy(false);
    if (res.ok) onDone(item.id, t('unmatched.ignored', { value: item.value }));
    else fail(res.error);
  };

  /** Two calls: if the mapping fails the new item stays, is chosen, and Map can be pressed again. */
  const createAndMap = async (groupId: string) => {
    if (item.kind === 'location') return;
    const input = newCatalogItem(item.kind, groupId, item.value, newItemLocale);
    if (!input) {
      fail('VALIDATION_FAILED');
      return;
    }
    setBusy(true);
    setError(null);
    const created = await createCatalogItemAction(input);
    setBusy(false);
    if (!created.ok) {
      fail(created.error);
      return;
    }
    const group = groups.find((g) => g.id === groupId);
    const label = pathLabel([group?.name ?? '', item.value.trim()]);
    onCreated(groupId, { id: created.data.id, name: item.value.trim() });
    setTarget({ id: created.data.id, label });
    setPanel(null);
    await map(created.data.id, label);
  };

  return (
    <li className="flex flex-col gap-2 rounded-md border p-3" data-testid="unmatched-row">
      <div>
        <p className="font-medium">{item.value}</p>
        <p className="text-xs text-muted-foreground">
          {t('unmatched.seen', { count: number.format(item.count) })}
          {item.examples.length > 0 ? ` · ${t('unmatched.examples', { list: item.examples.join(', ') })}` : ''}
        </p>
      </div>
      {candidate ? (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span>
            {t('unmatched.suggestion', { name: candidate.name, confidence: percent.format(candidate.confidence) })}
          </span>
          {canWrite && isLocation && target?.id !== candidate.id ? (
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void checkSuggestion()}>
              {t('unmatched.useSuggestion')}
            </Button>
          ) : null}
        </p>
      ) : null}
      {canWrite ? (
        <>
          <p className="text-sm" data-testid="unmatched-target">
            {target ? t('unmatched.willMapTo', { target: target.label }) : t('unmatched.noTarget')}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy || !target}
              onClick={() => {
                if (target) void map(target.id, target.label);
              }}
            >
              {t('unmatched.map')}
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => toggle('choose')}>
              {t('unmatched.choose')}
            </Button>
            {isLocation ? null : (
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => toggle('create')}>
                {t('unmatched.createNew')}
              </Button>
            )}
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void ignore()}>
              {t('unmatched.ignore')}
            </Button>
          </div>
          {panel === 'choose' ? (
            isLocation ? (
              <LocationPicker
                roots={roots}
                loaded={loaded}
                value={target?.id ?? null}
                t={t}
                onPick={setTarget}
                onError={fail}
              />
            ) : (
              <FilteredSelect options={options} value={target?.id ?? null} t={t} onPick={setTarget} />
            )
          ) : null}
          {panel === 'create' && item.kind !== 'location' ? (
            <CreatePanel
              value={item.value}
              kind={item.kind}
              groups={groups}
              busy={busy}
              t={t}
              onCreate={(groupId) => void createAndMap(groupId)}
            />
          ) : null}
        </>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </li>
  );
}

export function UnmatchedQueue({
  kind,
  initial,
  groups: initialGroups,
  locations,
  canWrite,
  newItemLocale,
  locale,
  messages,
}: {
  kind: UnmatchedKind;
  initial: UnmatchedPageDto;
  groups: CatalogGroup[];
  locations: StaffTaxonomyDto['locations'];
  canWrite: boolean;
  /** The language of a new item's name: a feed value is English (S17-F13's key rule). */
  newItemLocale: string;
  locale: string;
  messages: Record<string, unknown>;
}) {
  const t = useMemo(() => makeT(messages), [messages]);
  const number = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const percent = useMemo(() => new Intl.NumberFormat(locale, { style: 'percent' }), [locale]);
  const [items, setItems] = useState(initial.items);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [groups, setGroups] = useState(initialGroups);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const options = useMemo(() => catalogOptions(groups), [groups]);
  const roots = useMemo(() => rootLocationNodes(locations), [locations]);
  // A country's regions came with the page; cities and areas are added as they are opened.
  const loaded = useRef(
    new Map(
      locations.flatMap((c) => {
        const country = roots.find((r) => r.id === c.id);
        return country ? [[c.id, childNodes(country, c.children)] as const] : [];
      }),
    ),
  );

  const loadMore = async () => {
    if (!cursor) return;
    setLoading(true);
    const res = await loadUnmatchedAction({ kind, cursor, limit: QUEUE_PAGE_SIZE });
    setLoading(false);
    if (!res.ok) {
      setStatus({ kind: 'error', text: errorText(t, res.error) });
      return;
    }
    setItems((current) => appendPage(current, res.data.items));
    setCursor(res.data.nextCursor);
  };

  return (
    <div className="flex flex-col gap-3">
      {canWrite ? null : <p className="rounded-md border bg-muted p-3 text-sm">{t('readOnly')}</p>}
      <p className="text-sm text-muted-foreground">
        {t(kind === 'location' ? 'unmatched.locationNote' : 'unmatched.catalogNote')}
      </p>
      {kind === 'location' ? (
        <Link href="/staff/taxonomy" className="self-start text-sm underline underline-offset-4">
          {t('unmatched.addPlaces')}
        </Link>
      ) : null}
      <p className="text-sm text-muted-foreground">{t('unmatched.ignoreNote')}</p>
      <p
        role="status"
        className={`min-h-5 text-sm ${status?.kind === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}
      >
        {status?.text}
      </p>
      {items.length === 0 && !cursor ? <p className="text-sm text-muted-foreground">{t('unmatched.empty')}</p> : null}
      <ul className="flex flex-col gap-3">
        {items.map((item) => (
          <QueueRow
            key={item.id}
            item={item}
            options={options}
            groups={groups}
            roots={roots}
            loaded={loaded.current}
            canWrite={canWrite}
            newItemLocale={newItemLocale}
            number={number}
            percent={percent}
            t={t}
            onCreated={(groupId, created) =>
              setGroups((all) => all.map((g) => (g.id === groupId ? { ...g, items: [...g.items, created] } : g)))
            }
            onDone={(id, message) => {
              setItems((current) => current.filter((r) => r.id !== id));
              setStatus({ kind: 'ok', text: message });
            }}
          />
        ))}
      </ul>
      {cursor ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          disabled={loading}
          onClick={() => void loadMore()}
        >
          {loading ? t('loading') : t('unmatched.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}
