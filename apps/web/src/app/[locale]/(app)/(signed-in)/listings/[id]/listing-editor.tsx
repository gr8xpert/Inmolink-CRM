'use client';

import type { ListingContentDto, ListingDto, LockableListingField, TranslationOrigin } from '@inmolink/contracts';
import { formatter } from '@inmolink/i18n';
import { Button, Input, Label } from '@inmolink/ui';
import dynamic from 'next/dynamic';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  confirmListingAction,
  deleteTranslationAction,
  type EditorResult,
  saveFeaturesAction,
  saveListingAction,
  saveTranslationAction,
} from '../actions';
import type { Option, OptionGroup } from '../taxonomy';
import {
  EMPTY_TRANSLATION,
  type ListingValues,
  listingPatch,
  listingValues,
  makeT,
  parseDecimal,
  slugOf,
  type T,
  type TranslationDraft,
  translationBody,
  translationChanged,
  translationDraft,
} from '../values';
import { notifyListingChanged } from './listing-events';

// MapLibre loads only with the editor's location section (frontend rules: maps via next/dynamic).
const PinMap = dynamic(() => import('./pin-map'), {
  ssr: false,
  loading: () => <div className="h-72 animate-pulse rounded-md bg-muted" />,
});

/** Autosave waits this long after the last keystroke. */
const AUTOSAVE_MS = 800;

const TRANSACTION_TYPES = ['SALE', 'RENT_LONG_TERM', 'RENT_SHORT_TERM'] as const;
const PRICE_PERIODS = ['NIGHT', 'WEEK', 'MONTH'] as const;
const CEE = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'EXEMPT', 'PENDING'] as const;
const STATUSES = ['DRAFT', 'ACTIVE', 'UNDER_OFFER', 'SOLD', 'RENTED', 'WITHDRAWN'] as const;
const VISIBILITIES = ['PRIVATE', 'SHARED', 'PUBLIC'] as const;
const SCOPES = ['ALL', 'PREFERRED'] as const;
const SELECT = 'h-9 w-full rounded-md border bg-background px-3 text-sm disabled:opacity-60';
const TEXTAREA = 'min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-60';

export interface ListingEditorProps {
  listing: ListingDto;
  content: ListingContentDto | null;
  propertyTypes: OptionGroup[];
  locations: Option[];
  features: OptionGroup[];
  /** Content locales, the agency's default first. */
  contentLocales: { code: string; label: string }[];
  mapStyleUrl: string;
  /** The UI locale (dates). */
  locale: string;
  /** The `listings` catalog, translated on the server. */
  messages: Record<string, unknown>;
}

type SaveState = { kind: 'saved' } | { kind: 'pending' } | { kind: 'saving' } | { kind: 'error'; code: string };

/**
 * The listing editor (S3-05): sections for basics, location (map pin and precision), specs, features, price and
 * commission, status and visibility, internal fields and translations (tabs with origin badges), with field-lock
 * toggles. Every change autosaves after a short pause; saves run one at a time with the listing `version` the
 * last save returned, and a refused save shows its error code's message and marks the fields it names.
 */
export function ListingEditor(props: ListingEditorProps) {
  const t = makeT(props.messages);
  const readOnly = props.listing.private === null || props.listing.deletedAt !== null;
  const id = props.listing.id;

  const [values, setValues] = useState<ListingValues>(() => listingValues(props.listing));
  const [drafts, setDrafts] = useState<Record<string, TranslationDraft>>(() => draftsOf(props.content));
  const [origins, setOrigins] = useState<Record<string, TranslationOrigin>>(() => originsOf(props.content));
  const [featureIds, setFeatureIds] = useState<string[]>(() => [...(props.content?.featureIds ?? [])].sort());
  const [state, setState] = useState<SaveState>({ kind: 'saved' });
  const [fields, setFields] = useState<string[]>([]);
  const [tab, setTab] = useState(props.contentLocales[0]?.code ?? 'es');
  const [freshness, setFreshness] = useState(props.listing.freshness);
  const [confirming, setConfirming] = useState(false);

  // What the server holds, and the latest edits: refs, so the save loop never reads a stale render.
  const version = useRef(props.content?.version ?? props.listing.version);
  const saved = useRef({
    values: listingValues(props.listing),
    drafts: draftsOf(props.content),
    featureIds: [...(props.content?.featureIds ?? [])].sort(),
  });
  const latest = useRef({ values, drafts, featureIds });
  latest.current = { values, drafts, featureIds };
  const busy = useRef(false);
  const again = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** A content save answered: its version and what the server now holds. */
  const applyContent = useCallback((c: ListingContentDto) => {
    version.current = c.version;
    saved.current.drafts = draftsOf(c);
    saved.current.featureIds = [...c.featureIds].sort();
    setOrigins(originsOf(c));
  }, []);

  const flush = useCallback(async () => {
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    setState({ kind: 'saving' });
    const out: { failure: { code: string; fields: string[] } | null } = { failure: null };
    /** Records a refused save (fields renamed to the inputs they belong to); true when it was refused. */
    const refused = (r: EditorResult<unknown>, rename: (f: string) => string = (f) => f) => {
      if (r.ok) return false;
      if (r.revoked) window.location.reload();
      out.failure = { code: r.code, fields: r.fields.map(rename) };
      return true;
    };
    do {
      again.current = false;
      const now = latest.current;
      const patch = listingPatch(saved.current.values, now.values);
      if (Object.keys(patch).length > 0) {
        const r = await saveListingAction(id, { ...patch, version: version.current });
        if (refused(r) || !r.ok) break;
        version.current = r.data.version;
        saved.current.values = listingValues(r.data);
        setFreshness(r.data.freshness); // going ACTIVE again confirms it (S3-08)
      }
      for (const [locale, draft] of Object.entries(now.drafts)) {
        if (!translationChanged(saved.current.drafts[locale], draft)) continue;
        const r = await saveTranslationAction(id, locale, { ...translationBody(draft), version: version.current });
        if (refused(r, (f) => `${f}-${locale}`) || !r.ok) {
          setTab(locale);
          break;
        }
        applyContent(r.data);
      }
      if (out.failure) break;
      const wanted = [...now.featureIds].sort();
      if (wanted.join() !== saved.current.featureIds.join()) {
        const r = await saveFeaturesAction(id, { featureIds: wanted, version: version.current });
        if (refused(r) || !r.ok) break;
        applyContent(r.data);
      }
    } while (again.current);
    busy.current = false;
    if (out.failure) {
      setFields(out.failure.fields);
      setState({ kind: 'error', code: out.failure.code });
      return;
    }
    setFields([]);
    setState({ kind: 'saved' });
    notifyListingChanged(id);
  }, [id, applyContent]);

  // Every edit (re)starts the autosave timer; a refused save waits for the next edit before trying again.
  const schedule = useCallback(() => {
    setState((s) => (s.kind === 'error' ? s : { kind: 'pending' }));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), AUTOSAVE_MS);
  }, [flush]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  // Leaving with unsaved edits asks first.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (state.kind === 'pending' || state.kind === 'saving') e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [state.kind]);

  const set = <K extends keyof ListingValues>(key: K, value: ListingValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setFields((f) => f.filter((x) => x !== key));
    schedule();
  };
  const setDraft = (locale: string, patch: Partial<TranslationDraft>) => {
    setDrafts((d) => {
      const cur = d[locale] ?? EMPTY_TRANSLATION;
      const next = { ...cur, ...patch };
      if (patch.title !== undefined && !next.slugEdited) next.slug = slugOf(patch.title);
      return { ...d, [locale]: next };
    });
    schedule();
  };
  const toggleFeature = (fid: string, on: boolean) => {
    setFeatureIds((ids) => (on ? [...new Set([...ids, fid])] : ids.filter((x) => x !== fid)));
    schedule();
  };
  const toggleLock = (field: LockableListingField, on: boolean) =>
    set(
      'lockedFields',
      on ? [...new Set([...values.lockedFields, field])].sort() : values.lockedFields.filter((f) => f !== field),
    );

  const removeTranslation = async (locale: string) => {
    if (busy.current) return;
    busy.current = true;
    setState({ kind: 'saving' });
    const r = await deleteTranslationAction(id, locale, version.current);
    busy.current = false;
    if (!r.ok) {
      if (r.revoked) window.location.reload();
      setState({ kind: 'error', code: r.code });
      return;
    }
    applyContent(r.data);
    setDrafts((d) => {
      const { [locale]: _gone, ...rest } = d;
      return rest;
    });
    setState({ kind: 'saved' });
    notifyListingChanged(id);
  };

  /** "Still on the market" (S3-08), between saves: the answer carries the listing's new version. */
  const confirmOnMarket = async () => {
    if (busy.current) return;
    busy.current = true;
    setConfirming(true);
    const r = await confirmListingAction(id);
    busy.current = false;
    setConfirming(false);
    if (!r.ok) {
      if (r.revoked) window.location.reload();
      setState({ kind: 'error', code: r.code });
      return;
    }
    version.current = r.data.version;
    setFreshness(r.data.freshness);
    notifyListingChanged(id);
  };

  const invalid = (key: string) => fields.includes(key);
  const disabled = readOnly;

  /** A labelled control with the field's validation message under it. */
  const field = (key: string, label: string, control: (aria: Record<string, unknown>) => ReactNode) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={key}>{label}</Label>
      {control({
        id: key,
        name: key,
        disabled,
        'aria-invalid': invalid(key),
        'aria-describedby': invalid(key) ? `${key}-error` : undefined,
      })}
      {invalid(key) ? (
        <p id={`${key}-error`} className="text-xs text-destructive">
          {t('fieldInvalid')}
        </p>
      ) : null}
    </div>
  );
  const text = (key: keyof ListingValues, extra: Record<string, unknown> = {}) =>
    field(key, t(`editor.fields.${key}`), (aria) => (
      <Input {...aria} {...extra} value={values[key] as string} onChange={(e) => set(key, e.target.value as never)} />
    ));
  const select = (key: keyof ListingValues, options: readonly string[], label: (o: string) => string, empty = false) =>
    field(key, t(`editor.fields.${key}`), (aria) => (
      <select
        {...aria}
        className={SELECT}
        value={values[key] as string}
        onChange={(e) => set(key, e.target.value as never)}
      >
        {empty ? <option value="">{t('editor.options.none')}</option> : null}
        {options.map((o) => (
          <option key={o} value={o}>
            {label(o)}
          </option>
        ))}
      </select>
    ));
  const lock = (f: LockableListingField) => (
    <label key={f} className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <input
        type="checkbox"
        disabled={disabled}
        checked={values.lockedFields.includes(f)}
        onChange={(e) => toggleLock(f, e.target.checked)}
        aria-label={`${t('editor.lock')}: ${t(`editor.locks.${f}`)}`}
      />
      {t('editor.locked')}: {t(`editor.locks.${f}`)}
    </label>
  );
  const section = (key: string, locks: LockableListingField[], children: ReactNode) => (
    <fieldset id={`section-${key}`} className="flex flex-col gap-4 rounded-md border p-4">
      <legend className="px-1 text-sm font-semibold">{t(`editor.sections.${key}`)}</legend>
      {locks.length > 0 ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1" title={t('editor.lock')}>
          {locks.map(lock)}
        </div>
      ) : null}
      {children}
    </fieldset>
  );
  const cee = (o: string) => (o === 'EXEMPT' || o === 'PENDING' ? t(`editor.options.energyRating.${o}`) : o);
  const point = (() => {
    const [lat, lng] = [parseDecimal(values.lat), parseDecimal(values.lng)];
    return lat !== null && lng !== null && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  })();
  const draft = drafts[tab] ?? EMPTY_TRANSLATION;
  const tf = (k: string) => `${k}-${tab}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b bg-background py-2">
        <nav className="flex flex-wrap gap-3 text-sm" aria-label={t('title')}>
          {['basics', 'location', 'specs', 'features', 'price', 'visibility', 'private', 'translations'].map((s) => (
            <a key={s} href={`#section-${s}`} className="underline-offset-4 hover:underline">
              {t(`editor.sections.${s}`)}
            </a>
          ))}
        </nav>
        <p role="status" aria-live="polite" data-testid="save-status" className="text-sm text-muted-foreground">
          {state.kind === 'saving'
            ? t('editor.saving')
            : state.kind === 'pending'
              ? t('editor.unsaved')
              : state.kind === 'error'
                ? t('editor.failed')
                : t('editor.saved')}
        </p>
      </div>

      {state.kind === 'error' ? (
        <div
          role="alert"
          data-testid="editor-error"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive p-3 text-sm text-destructive"
        >
          <span>
            {t(`errors.${state.code}`) === `errors.${state.code}` ? t('errors.generic') : t(`errors.${state.code}`)}
          </span>
          {state.code === 'VERSION_CONFLICT' ? (
            <Button type="button" variant="outline" onClick={() => window.location.reload()}>
              {t('editor.reload')}
            </Button>
          ) : (
            <Button type="button" variant="outline" onClick={() => void flush()}>
              {t('editor.retry')}
            </Button>
          )}
        </div>
      ) : null}

      {/* Freshness counts for ACTIVE listings (and one the network hid until it is confirmed). */}
      {freshness && (values.status === 'ACTIVE' || freshness.networkHiddenAt) ? (
        <FreshnessNotice
          freshness={freshness}
          t={t}
          locale={props.locale}
          disabled={readOnly || confirming || state.kind === 'saving' || state.kind === 'pending'}
          onConfirm={() => void confirmOnMarket()}
        />
      ) : null}

      <form className="flex flex-col gap-4" noValidate onSubmit={(e) => e.preventDefault()}>
        {section(
          'basics',
          ['propertyType'],
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {select('transactionType', TRANSACTION_TYPES, (o) => t(`editor.options.transactionType.${o}`))}
            {field('propertyTypeId', t('editor.fields.propertyTypeId'), (aria) => (
              <select
                {...aria}
                className={SELECT}
                value={values.propertyTypeId}
                onChange={(e) => set('propertyTypeId', e.target.value)}
              >
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
            ))}
          </div>,
        )}

        {section(
          'location',
          ['location', 'coordinates'],
          <>
            {field('locationId', t('editor.fields.locationId'), (aria) => (
              <select
                {...aria}
                className={SELECT}
                value={values.locationId}
                onChange={(e) => set('locationId', e.target.value)}
              >
                {props.locations.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            ))}
            <p className="text-xs text-muted-foreground">{t('editor.fields.mapHint')}</p>
            <PinMap
              point={point}
              styleUrl={props.mapStyleUrl}
              disabled={disabled}
              failedText={t('editor.fields.mapFailed')}
              onPick={(p) => {
                setValues((v) => ({ ...v, lat: String(p.lat), lng: String(p.lng) }));
                setFields((f) => f.filter((x) => x !== 'lat' && x !== 'lng'));
                schedule();
              }}
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {text('lat', { inputMode: 'decimal' })}
              {text('lng', { inputMode: 'decimal' })}
              {select('locationPrecision', ['EXACT', 'APPROX'], (o) => t(`editor.options.locationPrecision.${o}`))}
            </div>
            {point && !disabled ? (
              <Button
                type="button"
                variant="outline"
                className="self-start"
                onClick={() => {
                  setValues((v) => ({ ...v, lat: '', lng: '' }));
                  schedule();
                }}
              >
                {t('editor.fields.clearPin')}
              </Button>
            ) : null}
          </>,
        )}

        {section(
          'specs',
          ['specs', 'energyRating'],
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {text('builtM2', { inputMode: 'decimal' })}
            {text('plotM2', { inputMode: 'decimal' })}
            {text('terraceM2', { inputMode: 'decimal' })}
            {text('bedrooms', { inputMode: 'numeric' })}
            {text('bathrooms', { inputMode: 'numeric' })}
            {text('yearBuilt', { inputMode: 'numeric' })}
            {select('energyRating', CEE, cee, true)}
            {select('energyEmissionsRating', CEE, cee, true)}
          </div>,
        )}

        {section(
          'features',
          ['features'],
          props.features.map((g) => (
            <fieldset key={g.label} className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">{g.label}</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {g.options.map((o) => (
                  <label key={o.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={featureIds.includes(o.id)}
                      onChange={(e) => toggleFeature(o.id, e.target.checked)}
                    />
                    {o.label}
                  </label>
                ))}
              </div>
            </fieldset>
          )),
        )}

        {section(
          'price',
          ['price', 'commission', 'split'],
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {text('price', { inputMode: 'decimal' })}
              {text('currency', { maxLength: 3 })}
              {values.transactionType === 'SALE'
                ? null
                : select('pricePeriod', PRICE_PERIODS, (o) => t(`editor.options.pricePeriod.${o}`), true)}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                disabled={disabled}
                checked={values.priceOnRequest}
                onChange={(e) => set('priceOnRequest', e.target.checked)}
              />
              {t('editor.fields.priceOnRequest')}
            </label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {select('commissionType', ['PCT', 'FIXED'], (o) => t(`editor.options.commissionType.${o}`))}
              {values.commissionType === 'PCT'
                ? text('commissionPercent', { inputMode: 'decimal' })
                : text('commissionAmount', { inputMode: 'decimal' })}
              {text('splitPercent', { inputMode: 'decimal' })}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                disabled={disabled}
                checked={values.commissionIncludesVat}
                onChange={(e) => set('commissionIncludesVat', e.target.checked)}
              />
              {t('editor.fields.commissionIncludesVat')}
            </label>
          </>,
        )}

        {section(
          'visibility',
          ['status'],
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {select('status', STATUSES, (o) => t(`editor.options.status.${o}`))}
            {select('visibility', VISIBILITIES, (o) => t(`editor.options.visibility.${o}`))}
            {values.visibility === 'SHARED'
              ? select('shareScope', SCOPES, (o) => t(`editor.options.shareScope.${o}`))
              : null}
          </div>,
        )}

        {section(
          'private',
          [],
          <>
            {text('cadastralRef', { maxLength: 40 })}
            {field('internalNotes', t('editor.fields.internalNotes'), (aria) => (
              <textarea
                {...aria}
                className={TEXTAREA}
                maxLength={10_000}
                value={values.internalNotes}
                onChange={(e) => set('internalNotes', e.target.value)}
              />
            ))}
            {text('keysInfo', { maxLength: 2_000 })}
          </>,
        )}

        {section(
          'translations',
          [],
          <>
            <div role="tablist" className="flex flex-wrap gap-1 border-b">
              {props.contentLocales.map((l) => {
                const origin = origins[l.code];
                return (
                  <button
                    key={l.code}
                    type="button"
                    role="tab"
                    id={`tab-${l.code}`}
                    aria-selected={tab === l.code}
                    aria-controls={`panel-${l.code}`}
                    onClick={() => setTab(l.code)}
                    className={`flex items-center gap-2 rounded-t-md px-3 py-1.5 text-sm ${
                      tab === l.code ? 'border border-b-0 bg-background font-medium' : 'text-muted-foreground'
                    }`}
                  >
                    {l.label}
                    <span
                      data-testid={`origin-${l.code}`}
                      className={`rounded px-1.5 py-0.5 text-xs ${
                        origin === 'AI_DRAFT'
                          ? 'bg-amber-100 text-amber-900'
                          : origin
                            ? 'bg-emerald-100 text-emerald-900'
                            : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {origin ? t(`editor.translations.origin.${origin}`) : t('editor.translations.missing')}
                    </span>
                  </button>
                );
              })}
            </div>
            <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="flex flex-col gap-3">
              {field(tf('title'), t('editor.translations.titleField'), (aria) => (
                <Input
                  {...aria}
                  maxLength={200}
                  value={draft.title}
                  onChange={(e) => setDraft(tab, { title: e.target.value })}
                />
              ))}
              {field(tf('slug'), t('editor.translations.slug'), (aria) => (
                <Input
                  {...aria}
                  maxLength={120}
                  value={draft.slug}
                  onChange={(e) => setDraft(tab, { slug: e.target.value, slugEdited: e.target.value !== '' })}
                />
              ))}
              {field(tf('description'), t('editor.translations.description'), (aria) => (
                <textarea
                  {...aria}
                  className={`${TEXTAREA} min-h-40`}
                  maxLength={20_000}
                  value={draft.description}
                  onChange={(e) => setDraft(tab, { description: e.target.value })}
                />
              ))}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {field(tf('metaTitle'), t('editor.translations.metaTitle'), (aria) => (
                  <Input
                    {...aria}
                    maxLength={70}
                    value={draft.metaTitle}
                    onChange={(e) => setDraft(tab, { metaTitle: e.target.value })}
                  />
                ))}
                {field(tf('metaDescription'), t('editor.translations.metaDescription'), (aria) => (
                  <Input
                    {...aria}
                    maxLength={160}
                    value={draft.metaDescription}
                    onChange={(e) => setDraft(tab, { metaDescription: e.target.value })}
                  />
                ))}
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={draft.locked}
                  onChange={(e) => setDraft(tab, { locked: e.target.checked })}
                />
                {t('editor.translations.locked')}
              </label>
              {origins[tab] && !disabled ? (
                <Button
                  type="button"
                  variant="outline"
                  className="self-start"
                  onClick={() => void removeTranslation(tab)}
                >
                  {t('editor.translations.remove')}
                </Button>
              ) : null}
            </div>
          </>,
        )}
      </form>
    </div>
  );
}

function draftsOf(c: ListingContentDto | null): Record<string, TranslationDraft> {
  return Object.fromEntries((c?.translations ?? []).map((tr) => [tr.locale, translationDraft(tr)]));
}

function originsOf(c: ListingContentDto | null): Record<string, TranslationOrigin> {
  return Object.fromEntries((c?.translations ?? []).map((tr) => [tr.locale, tr.origin]));
}

/**
 * Freshness (S3-08): when the listing was last confirmed as on the market, the prompt once 90 days have passed,
 * the notice once the network hid it (120 days), and the confirm button.
 */
function FreshnessNotice(props: {
  freshness: NonNullable<ListingDto['freshness']>;
  t: T;
  locale: string;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const { freshness, t } = props;
  const date = (iso: string) => formatter(props.locale).date(new Date(iso));
  const state = freshness.networkHiddenAt
    ? 'hidden'
    : Date.now() >= Date.parse(freshness.confirmDueAt)
      ? 'due'
      : 'fresh';
  const vars = {
    confirmed: date(freshness.lastConfirmedAt),
    due: date(freshness.confirmDueAt),
    hide: date(freshness.hideAt),
    hidden: freshness.networkHiddenAt ? date(freshness.networkHiddenAt) : '',
  };
  return (
    <section
      id="section-freshness"
      data-testid="freshness"
      data-state={state}
      role={state === 'fresh' ? undefined : 'alert'}
      className={`flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm ${
        state === 'fresh' ? 'text-muted-foreground' : 'border-amber-500'
      }`}
    >
      <span>{t(`editor.freshness.${state}`, vars)}</span>
      <Button
        type="button"
        variant={state === 'fresh' ? 'outline' : 'default'}
        disabled={props.disabled}
        onClick={props.onConfirm}
      >
        {t('editor.freshness.confirm')}
      </Button>
    </section>
  );
}
