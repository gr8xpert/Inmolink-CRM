'use client';

import type { LocationLevel, StaffCatalogItemDto, StaffLocationDto, StaffTaxonomyDto } from '@inmolink/contracts';
import { Button, Input } from '@inmolink/ui';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { type ReactNode, useState, useTransition } from 'react';
import {
  type ActionResult,
  addCatalogAliasAction,
  addLocationAliasAction,
  createLocationAction,
  loadCatalogItemAction,
  loadLocationAction,
  loadLocationChildrenAction,
  removeCatalogAliasAction,
  removeLocationAliasAction,
  reorderCatalogAction,
  reorderLocationsAction,
  updateCatalogItemAction,
  updateLocationAction,
} from './actions';
import { type T, type Translation, TranslationEditor } from './translation-editor';

// MapLibre and Terra Draw only load once an item is opened (frontend rules: heavy UI via next/dynamic).
const PolygonMap = dynamic(() => import('./polygon-map'), {
  ssr: false,
  loading: () => <div className="h-80 animate-pulse rounded-md bg-muted" />,
});

type Tab = 'locations' | 'propertyTypes' | 'features';
type CatalogKind = 'propertyType' | 'feature';
interface Row {
  id: string;
  name: string;
}
interface LocationNode extends Row {
  level: LocationLevel;
  childCount: number;
  /** Countries come with their regions; a region's cities and a city's areas load on expand (S3-F2). */
  children?: LocationNode[];
}
type Selection =
  | { kind: 'location'; id: string }
  | { kind: CatalogKind; scope: 'group' | 'item'; id: string; name: string };

const NEXT_LEVEL: Record<LocationLevel, LocationLevel | null> = {
  COUNTRY: 'REGION',
  REGION: 'CITY',
  CITY: 'AREA',
  AREA: null,
};

export interface EditorProps {
  tree: StaffTaxonomyDto;
  canWrite: boolean;
  locales: readonly string[];
  defaultLocale: string;
  mapStyleUrl: string;
  messages: Record<string, unknown>;
}

function makeT(messages: Record<string, unknown>): T {
  return (key, vars) => {
    let v: unknown = messages;
    for (const part of key.split('.')) v = (v as Record<string, unknown> | undefined)?.[part];
    const s = typeof v === 'string' ? v : key;
    return vars ? s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '') : s;
  };
}

/** Moves one id to the position of another; null when nothing changes. */
function moved(ids: string[], from: string, to: string): string[] | null {
  const a = ids.indexOf(from);
  const b = ids.indexOf(to);
  if (a < 0 || b < 0 || a === b) return null;
  const next = [...ids];
  next.splice(a, 1);
  next.splice(b, 0, from);
  return next;
}

/** Siblings that can be dragged onto each other (native drag and drop) or moved with the arrow buttons. */
function SortableList({
  rows,
  disabled,
  selectedId,
  t,
  onReorder,
  onSelect,
  extra,
}: {
  rows: Row[];
  disabled: boolean;
  selectedId: string | null;
  t: T;
  onReorder: (ids: string[]) => void;
  onSelect: (row: Row) => void;
  extra?: (row: Row) => ReactNode;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const ids = rows.map((r) => r.id);
  const drop = (target: string) => {
    const next = dragging ? moved(ids, dragging, target) : null;
    setDragging(null);
    if (next) onReorder(next);
  };
  return (
    <ul className="flex flex-col gap-0.5">
      {rows.map((row, i) => (
        <li key={row.id}>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: native drag and drop; the arrow buttons are the keyboard alternative */}
          <div
            draggable={!disabled}
            onDragStart={(e) => {
              e.stopPropagation();
              e.dataTransfer.effectAllowed = 'move';
              setDragging(row.id);
            }}
            onDragOver={(e) => dragging && ids.includes(dragging) && e.preventDefault()}
            onDrop={(e) => {
              e.stopPropagation();
              drop(row.id);
            }}
            onDragEnd={() => setDragging(null)}
            className={`flex items-center gap-1 rounded px-1 ${selectedId === row.id ? 'bg-accent' : ''} ${
              dragging === row.id ? 'opacity-50' : ''
            }`}
            data-testid={`row-${row.id}`}
          >
            <span aria-hidden className={disabled ? 'invisible' : 'cursor-grab select-none text-muted-foreground'}>
              ⠿
            </span>
            <button
              type="button"
              className="min-w-0 flex-1 truncate py-1 text-left text-sm"
              aria-current={selectedId === row.id ? 'true' : undefined}
              onClick={() => onSelect(row)}
            >
              {row.name}
            </button>
            {disabled ? null : (
              <>
                <button
                  type="button"
                  className="px-1 text-xs disabled:opacity-30"
                  aria-label={t('moveUp', { name: row.name })}
                  disabled={i === 0}
                  onClick={() => onReorder(moved(ids, row.id, ids[i - 1] as string) ?? ids)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="px-1 text-xs disabled:opacity-30"
                  aria-label={t('moveDown', { name: row.name })}
                  disabled={i === rows.length - 1}
                  onClick={() => onReorder(moved(ids, row.id, ids[i + 1] as string) ?? ids)}
                >
                  ↓
                </button>
              </>
            )}
          </div>
          {extra?.(row)}
        </li>
      ))}
    </ul>
  );
}

function AliasList({
  aliases,
  disabled,
  busy,
  t,
  onAdd,
  onRemove,
}: {
  aliases: { id: string; alias: string }[];
  disabled: boolean;
  busy: boolean;
  t: T;
  onAdd: (alias: string) => void;
  onRemove: (aliasId: string) => void;
}) {
  const [value, setValue] = useState('');
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{t('aliases.title')}</h3>
      <p className="text-xs text-muted-foreground">{t('aliases.hint')}</p>
      {aliases.length === 0 ? <p className="text-sm text-muted-foreground">{t('aliases.empty')}</p> : null}
      <ul className="flex flex-wrap gap-2">
        {aliases.map((a) => (
          <li key={a.id} className="flex items-center gap-1 rounded-full border px-3 py-1 text-sm">
            {a.alias}
            {disabled ? null : (
              <button type="button" aria-label={t('aliases.remove', { alias: a.alias })} onClick={() => onRemove(a.id)}>
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      {disabled ? null : (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) onAdd(value.trim());
            setValue('');
          }}
        >
          <Input
            aria-label={t('aliases.title')}
            value={value}
            maxLength={200}
            placeholder={t('aliases.placeholder')}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button type="submit" size="sm" disabled={busy || !value.trim()}>
            {t('aliases.add')}
          </Button>
        </form>
      )}
    </section>
  );
}

/**
 * Staff taxonomy editor (S2-04): the location tree and the property type / feature catalog with drag-and-drop
 * ordering, a translation editor, feed aliases and (locations) a polygon drawn on a map. Presentation only: every
 * change goes through a server action to `/v1/staff/taxonomy`, then the page re-reads the uncached countries and
 * regions and the editor re-reads the cities and areas it has open (loaded on expand, S3-F2).
 */
export function TaxonomyEditor({ tree, canWrite, locales, defaultLocale, mapStyleUrl, messages }: EditorProps) {
  const t = makeT(messages);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [tab, setTab] = useState<Tab>('locations');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [location, setLocation] = useState<StaffLocationDto | null>(null);
  const [catalogItem, setCatalogItem] = useState<StaffCatalogItemDto | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState<Map<string, LocationNode[]>>(new Map());
  const [creating, setCreating] = useState<{ parentId: string | null; level: LocationLevel } | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const disabled = !canWrite;

  const fail = (code: string) => {
    const key = `errors.${code}`;
    const text = t(key);
    setStatus({ kind: 'error', text: text === key ? t('errors.generic') : text });
  };

  /** Runs an action, shows its outcome, re-reads the tree on success. */
  const run = async <R,>(action: () => Promise<ActionResult<R>>, onOk?: (data: R) => void) => {
    setBusy(true);
    setStatus(null);
    try {
      const res = await action();
      if (!res.ok) return fail(res.error);
      onOk?.(res.data);
      setStatus({ kind: 'ok', text: t('saved') });
      startTransition(() => router.refresh());
      await reloadOpen();
    } catch {
      fail('generic');
    } finally {
      setBusy(false);
    }
  };

  const selectLocation = async (id: string) => {
    setSelection({ kind: 'location', id });
    setCreating(null);
    setLocation(null);
    setStatus(null);
    const res = await loadLocationAction(id);
    if (res.ok) setLocation(res.data);
    else fail(res.error);
  };

  const selectCatalog = async (kind: CatalogKind, scope: 'group' | 'item', row: Row) => {
    setSelection({ kind, scope, id: row.id, name: row.name });
    setCatalogItem(null);
    setStatus(null);
    const res = await loadCatalogItemAction(kind, scope, row.id);
    if (res.ok) setCatalogItem(res.data);
    else fail(res.error);
  };

  /** Loads one location's children (cities or areas) into the editor; countries carry their regions. */
  const loadChildren = async (id: string) => {
    const res = await loadLocationChildrenAction(id);
    if (!res.ok) return fail(res.error);
    setLoaded((m) => new Map(m).set(id, res.data.children));
  };

  /** After a save: re-read every open region's or city's children (countries come with the page's refresh). */
  const reloadOpen = async () => {
    const countries = new Set(tree.locations.map((c) => c.id));
    await Promise.all([...expanded].filter((id) => !countries.has(id)).map(loadChildren));
  };

  const childrenOf = (node: LocationNode) => node.children ?? loaded.get(node.id);

  const toggle = (node: LocationNode) => {
    const opening = !expanded.has(node.id);
    setExpanded((s) => {
      const n = new Set(s);
      n.has(node.id) ? n.delete(node.id) : n.add(node.id);
      return n;
    });
    if (opening && !childrenOf(node) && node.childCount > 0) void loadChildren(node.id);
  };

  // ---- Location tree ----
  const renderLocations = (parentId: string | null, nodes: LocationNode[]): ReactNode => (
    <SortableList
      rows={nodes}
      disabled={disabled || busy}
      selectedId={selection?.kind === 'location' ? selection.id : null}
      t={t}
      onReorder={(orderedIds) => run(() => reorderLocationsAction({ parentId, orderedIds }))}
      onSelect={(row) => selectLocation(row.id)}
      extra={(row) => {
        const node = nodes.find((n) => n.id === row.id) as LocationNode;
        const open = expanded.has(node.id);
        const kids = childrenOf(node);
        const nextLevel = NEXT_LEVEL[node.level];
        return (
          <div className="ml-5">
            {nextLevel ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="text-xs text-muted-foreground"
                  aria-expanded={open}
                  onClick={() => toggle(node)}
                >
                  {open ? '▾' : '▸'} {t(`levels.${nextLevel}`)} ({kids?.length ?? node.childCount})
                </button>
                {!disabled ? (
                  <button
                    type="button"
                    className="text-xs underline"
                    onClick={() => {
                      setCreating({ parentId: node.id, level: nextLevel });
                      setSelection(null);
                      setExpanded((s) => new Set(s).add(node.id));
                      if (!kids && node.childCount > 0) void loadChildren(node.id);
                    }}
                  >
                    {t('addChild', { level: t(`levels.${nextLevel}`).toLowerCase() })}
                  </button>
                ) : null}
              </div>
            ) : null}
            {open && kids === undefined && node.childCount > 0 ? (
              <p className="text-xs text-muted-foreground">{t('loading')}</p>
            ) : null}
            {open && kids?.length ? renderLocations(node.id, kids) : null}
          </div>
        );
      }}
    />
  );

  const saveLocationTranslations = (rows: Translation[]) =>
    run(
      () => updateLocationAction(selection?.kind === 'location' ? selection.id : '', { translations: rows }),
      setLocation,
    );

  const detail = (
    <>
      {creating ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">{t('createTitle', { level: t(`levels.${creating.level}`) })}</h2>
          <TranslationEditor
            initial={[{ locale: defaultLocale, name: '', slug: '' }]}
            locales={locales}
            disabled={disabled}
            busy={busy}
            submitLabel={t('create')}
            t={t}
            onSubmit={(translations) =>
              run(
                () => createLocationAction({ parentId: creating.parentId, level: creating.level, translations }),
                (created) => {
                  setCreating(null);
                  void selectLocation(created.id);
                },
              )
            }
          />
          <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setCreating(null)}>
            {t('cancel')}
          </Button>
        </section>
      ) : selection?.kind === 'location' ? (
        location ? (
          <div className="flex flex-col gap-6" key={location.id}>
            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-semibold">
                {t(`levels.${location.level}`)}: {location.translations[0]?.name}
              </h2>
              <h3 className="text-sm font-semibold">{t('translations.title')}</h3>
              <TranslationEditor
                key={JSON.stringify(location.translations)}
                initial={location.translations}
                locales={locales}
                disabled={disabled}
                busy={busy}
                submitLabel={t('translations.save')}
                t={t}
                onSubmit={saveLocationTranslations}
              />
            </section>
            <AliasList
              aliases={location.aliases}
              disabled={disabled}
              busy={busy}
              t={t}
              onAdd={(alias) => run(() => addLocationAliasAction(location.id, { alias }), setLocation)}
              onRemove={(aliasId) => run(() => removeLocationAliasAction(location.id, aliasId), setLocation)}
            />
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">{t('polygon.title')}</h3>
              <PolygonMap
                key={`${location.id}:${location.polygon ? JSON.stringify(location.polygon).length : 0}`}
                polygon={location.polygon}
                centroid={location.centroid}
                styleUrl={mapStyleUrl}
                disabled={disabled}
                busy={busy}
                t={t}
                onSave={(polygon) => run(() => updateLocationAction(location.id, { polygon }), setLocation)}
              />
            </section>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('loading')}</p>
        )
      ) : selection ? (
        catalogItem ? (
          <div className="flex flex-col gap-6" key={catalogItem.id}>
            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-semibold">{selection.name}</h2>
              <h3 className="text-sm font-semibold">{t('translations.title')}</h3>
              <TranslationEditor
                key={JSON.stringify(catalogItem.translations)}
                initial={catalogItem.translations}
                locales={locales}
                disabled={disabled}
                busy={busy}
                submitLabel={t('translations.save')}
                t={t}
                onSubmit={(translations) =>
                  run(
                    () =>
                      updateCatalogItemAction(catalogItem.id, {
                        kind: catalogItem.kind,
                        scope: catalogItem.scope,
                        translations,
                      }),
                    setCatalogItem,
                  )
                }
              />
            </section>
            {catalogItem.scope === 'item' ? (
              <AliasList
                aliases={catalogItem.aliases}
                disabled={disabled}
                busy={busy}
                t={t}
                onAdd={(alias) =>
                  run(() => addCatalogAliasAction(catalogItem.kind, catalogItem.id, { alias }), setCatalogItem)
                }
                onRemove={(aliasId) =>
                  run(() => removeCatalogAliasAction(catalogItem.kind, catalogItem.id, aliasId), setCatalogItem)
                }
              />
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('loading')}</p>
        )
      ) : (
        <p className="text-sm text-muted-foreground">{t('selectPrompt')}</p>
      )}
    </>
  );

  // ---- Catalog lists ----
  const catalogGroups = (kind: CatalogKind) =>
    kind === 'propertyType'
      ? tree.propertyTypes.map((g) => ({ id: g.id, name: g.name, items: g.types }))
      : tree.features.map((g) => ({ id: g.id, name: g.name, items: g.features }));

  const renderCatalog = (kind: CatalogKind) => {
    const groups = catalogGroups(kind);
    const selectedId = selection && selection.kind === kind ? selection.id : null;
    return (
      <SortableList
        rows={groups}
        disabled={disabled || busy}
        selectedId={selectedId}
        t={t}
        onReorder={(orderedIds) => run(() => reorderCatalogAction({ kind, groupId: null, orderedIds }))}
        onSelect={(row) => selectCatalog(kind, 'group', row)}
        extra={(row) => {
          const group = groups.find((g) => g.id === row.id) as (typeof groups)[number];
          return (
            <div className="ml-5">
              <SortableList
                rows={group.items}
                disabled={disabled || busy}
                selectedId={selectedId}
                t={t}
                onReorder={(orderedIds) => run(() => reorderCatalogAction({ kind, groupId: group.id, orderedIds }))}
                onSelect={(item) => selectCatalog(kind, 'item', item)}
              />
            </div>
          );
        }}
      />
    );
  };

  const tabs: Tab[] = ['locations', 'propertyTypes', 'features'];
  return (
    <div className="flex flex-col gap-4" aria-busy={busy || pending}>
      {disabled ? <p className="rounded-md border bg-muted p-3 text-sm">{t('readOnly')}</p> : null}
      <div role="tablist" className="flex gap-4 border-b text-sm">
        {tabs.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`-mb-px border-b-2 pb-2 ${tab === id ? 'border-primary font-semibold' : 'border-transparent'}`}
            onClick={() => {
              setTab(id);
              setSelection(null);
              setCreating(null);
            }}
          >
            {t(`tabs.${id}`)}
          </button>
        ))}
      </div>
      <p
        role="status"
        className={`min-h-5 text-sm ${status?.kind === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}
      >
        {status?.text}
      </p>
      <div className="grid gap-6 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <nav aria-label={t('tree')} className="flex flex-col gap-2">
          {!disabled ? <p className="text-xs text-muted-foreground">{t('dragHint')}</p> : null}
          {tab === 'locations' ? (
            <>
              {tree.locations.length === 0 ? <p className="text-sm text-muted-foreground">{t('noChildren')}</p> : null}
              {renderLocations(null, tree.locations as LocationNode[])}
              {!disabled ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="self-start"
                  onClick={() => {
                    setCreating({ parentId: null, level: 'COUNTRY' });
                    setSelection(null);
                  }}
                >
                  {t('addRoot')}
                </Button>
              ) : null}
            </>
          ) : (
            renderCatalog(tab === 'propertyTypes' ? 'propertyType' : 'feature')
          )}
        </nav>
        <div>{detail}</div>
      </div>
    </div>
  );
}
