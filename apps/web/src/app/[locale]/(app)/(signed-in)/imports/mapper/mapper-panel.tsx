'use client';

import type {
  MapperDryRunDto,
  MapperPathDto,
  MapperPreviewDto,
  MapperSampleDto,
  XmlMappingInput,
} from '@inmolink/contracts';
import {
  MAPPER_SAMPLE,
  SHEET_MAX_COLUMNS,
  SHEET_MAX_ROWS,
  SHEET_UPLOAD_MAX_BYTES,
  XML_MAPPED_ENUM_FIELDS,
  XML_MAPPED_FIELDS,
  type XmlMappedField,
} from '@inmolink/contracts/values';
import { Button, Input, Label } from '@inmolink/ui';
import { useEffect, useId, useRef, useState, useTransition } from 'react';
import { useRouter } from '@/i18n/navigation';
import { makeT } from '../../listings/values';
import {
  dryRunAction,
  type MapperResult,
  previewAction,
  sampleUrlAction,
  saveProfileAction,
  startSheetImportAction,
} from './actions';
import {
  CONSTANT,
  type FieldState,
  hasRequired,
  initialState,
  type MapperState,
  type TranslationState,
  toMapping,
} from './mapping-state';

/**
 * The visual XML mapper (S6-04): read a sample (upload or URL), see the record the feed repeats, pick for each
 * listing field the path in the sample it comes from — with the values found there next to the picker — preview
 * the listings the mapping produces, run a dry run, and save the mapping as a profile. Loaded as its own chunk
 * (`mapper-entry.tsx`); every call goes through the server actions and the upload route.
 */
interface Props {
  messages: Record<string, unknown>;
  locales: string[];
  defaultLocale: string;
  /** A CSV / Excel connection to give the next file to (from "upload a new file"): its listings are updated, not duplicated. */
  connectionId?: string | undefined;
}

const SELECT = 'h-9 w-full rounded-md border bg-background px-2 text-sm';
const REQUIRED: readonly XmlMappedField[] = ['ref', 'propertyType'];

/** The upload decides by name only where to send the file; the API decides what it is by its first bytes. */
const isSheetName = (name: string) => /\.(csv|xlsx|xls|txt)$/i.test(name);

async function uploadSample(file: File, recordElement?: string): Promise<MapperResult<MapperSampleDto>> {
  const qs = new URLSearchParams(recordElement ? { recordElement } : {});
  const sheet = isSheetName(file.name);
  try {
    const res = await fetch(sheet ? '/api/imports/sheet' : `/api/imports/mapper/sample?${qs}`, {
      method: 'POST',
      headers: { 'content-type': sheet ? 'application/octet-stream' : 'application/xml' },
      body: file,
    });
    return (await res.json()) as MapperResult<MapperSampleDto>;
  } catch {
    return { ok: false, error: 'generic' };
  }
}

export default function MapperPanel({ messages, locales, defaultLocale, connectionId }: Props) {
  const t = makeT(messages);
  const router = useRouter();
  const ids = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState<{ kind: 'file'; file: File } | { kind: 'url'; url: string } | null>(null);
  const [sample, setSample] = useState<MapperSampleDto | null>(null);
  const [state, setState] = useState<MapperState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<MapperPreviewDto | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [report, setReport] = useState<MapperDryRunDto | null>(null);
  const [name, setName] = useState('');
  const [busy, start] = useTransition();

  const errorText = (res: { error: string; reason?: string | undefined }) => {
    const detail = res.reason ? t(`errors.reason.${res.reason}`) : '';
    const base = t(`errors.${res.error}`);
    return detail && !detail.startsWith('errors.reason.') ? `${base} ${detail}` : base;
  };

  const read = (from: NonNullable<typeof source>, recordElement?: string) =>
    start(async () => {
      setError(null);
      const res =
        from.kind === 'file'
          ? await uploadSample(from.file, recordElement)
          : await sampleUrlAction({ url: from.url, ...(recordElement ? { recordElement } : {}) });
      if (!res.ok) {
        if (res.error === 'revoked') return window.location.assign('/session/expired');
        return setError(errorText(res));
      }
      setSource(from);
      setSample(res.data);
      setReport(null);
      setPreview(null);
      // A new sample or record element starts from the server's guesses again.
      setState(initialState(res.data, defaultLocale));
    });

  const mapping: XmlMappingInput | null = state && hasRequired(state) ? toMapping(state) : null;
  const mappingKey = JSON.stringify(mapping);

  // Preview: the first records as the import would read them, after the picks settle.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mappingKey stands for the mapping
  useEffect(() => {
    if (!sample || !mapping) return setPreview(null);
    let current = true;
    const timer = setTimeout(async () => {
      const res = await previewAction({ mapping, records: sample.records });
      if (!current) return;
      if (res.ok) {
        setPreview(res.data);
        setPreviewError(null);
      } else setPreviewError(errorText(res));
    }, 500);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [sample, mappingKey]);

  const setField = (field: XmlMappedField, patch: Partial<FieldState>) =>
    setState((s) => (s ? { ...s, fields: { ...s.fields, [field]: { ...s.fields[field], ...patch } } } : s));
  const setTranslation = (i: number, patch: Partial<TranslationState>) =>
    setState((s) => (s ? { ...s, translations: s.translations.map((x, j) => (j === i ? { ...x, ...patch } : x)) } : s));

  const dryRun = () =>
    start(async () => {
      if (!sample || !mapping) return;
      const res = await dryRunAction({ mapping, records: sample.records, ...(connectionId ? { connectionId } : {}) });
      if (res.ok) {
        setReport(res.data);
        setError(null);
      } else setError(errorText(res));
    });

  const save = () =>
    start(async () => {
      if (!mapping || !name.trim()) return;
      const res = await saveProfileAction({ name: name.trim(), mapping });
      if (!res.ok) return setError(errorText(res));
      const qs = new URLSearchParams({ connector: 'xml-mapped', profile: res.data.id });
      // The address without its query (an access key often lives there) and without a login: never in history or logs.
      if (source?.kind === 'url') {
        try {
          const u = new URL(source.url);
          qs.set('url', `${u.origin}${u.pathname}`);
        } catch {
          // not a URL the form could use anyway
        }
      }
      router.push(`/imports/new?${qs}`);
    });

  const importSheet = () =>
    start(async () => {
      if (!mapping || !name.trim() || !sample?.sheet) return;
      const res = await startSheetImportAction({
        fileId: sample.sheet.fileId,
        name: name.trim(),
        mapping,
        ...(connectionId ? { connectionId } : {}),
      });
      if (!res.ok) return setError(errorText(res));
      router.push(`/imports/${res.data.connectionId}`);
    });

  const paths = sample?.paths ?? [];
  const byPath = new Map<string, MapperPathDto>(paths.map((p) => [p.path, p]));
  const sampleLine = (path: string) => {
    const p = byPath.get(path);
    return p ? `${p.samples.join(' · ')}${p.repeated ? ` (${t('repeats')})` : ''}` : '';
  };

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-4" aria-labelledby={`${ids}-sample`}>
        <h2 id={`${ids}-sample`} className="text-lg font-medium">
          {t('step1')}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t('sampleHint', { mb: String(MAPPER_SAMPLE.maxBytes / 1024 / 1024) })}
        </p>
        <p className="text-sm text-muted-foreground">
          {t('sheetHint', {
            mb: String(SHEET_UPLOAD_MAX_BYTES / 1024 / 1024),
            rows: String(SHEET_MAX_ROWS),
            columns: String(SHEET_MAX_COLUMNS),
          })}
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${ids}-file`}>{t('upload')}</Label>
            <input
              id={`${ids}-file`}
              ref={fileInput}
              type="file"
              accept=".xml,.csv,.xlsx,text/xml,application/xml,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="text-sm"
            />
            <Button
              type="button"
              variant="outline"
              disabled={!file || busy}
              onClick={() => file && read({ kind: 'file', file })}
            >
              {t('readFile')}
            </Button>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${ids}-url`}>{t('fromUrl')}</Label>
            <Input
              id={`${ids}-url`}
              type="url"
              value={url}
              maxLength={2048}
              placeholder="https://feeds.example.com/export.xml"
              onChange={(e) => setUrl(e.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              disabled={!url.trim() || busy}
              onClick={() => read({ kind: 'url', url: url.trim() })}
            >
              {t('readUrl')}
            </Button>
          </div>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive" data-testid="mapper-error">
            {error}
          </p>
        ) : null}
      </section>

      {sample && state ? (
        <>
          <section className="flex flex-col gap-3" aria-labelledby={`${ids}-record`}>
            <h2 id={`${ids}-record`} className="text-lg font-medium">
              {sample.sheet ? t('step2Sheet') : t('step2')}
            </h2>
            <p className="text-sm text-muted-foreground" data-testid="sample-summary">
              {sample.sheet
                ? t('detectedSheet', { count: String(sample.recordCount), columns: String(sample.paths.length) })
                : t('detected', { element: sample.recordElement, count: String(sample.recordCount) })}
              {sample.truncated ? ` ${t('truncated')}` : ''}
            </p>
            <div className="flex max-w-sm flex-col gap-2" hidden={Boolean(sample.sheet)}>
              <Label htmlFor={`${ids}-record-element`}>{t('recordElement')}</Label>
              <select
                id={`${ids}-record-element`}
                className={SELECT}
                value={sample.recordElement}
                disabled={busy}
                onChange={(e) => source && read(source, e.target.value)}
              >
                {[...new Set([sample.recordElement, ...sample.candidates.map((c) => c.name)])].map((n) => (
                  <option key={n} value={n}>
                    {n}{' '}
                    {sample.candidates.find((c) => c.name === n)
                      ? `(×${sample.candidates.find((c) => c.name === n)?.count})`
                      : ''}
                  </option>
                ))}
              </select>
            </div>
          </section>

          <section className="flex flex-col gap-4" aria-labelledby={`${ids}-fields`}>
            <h2 id={`${ids}-fields`} className="text-lg font-medium">
              {t('step3')}
            </h2>
            <p className="text-sm text-muted-foreground">{t('fieldsHint')}</p>
            <div className="flex max-w-sm flex-col gap-2">
              <Label htmlFor={`${ids}-decimal`}>{t('decimalSeparator')}</Label>
              <select
                id={`${ids}-decimal`}
                className={SELECT}
                value={state.decimalSeparator}
                onChange={(e) =>
                  setState({ ...state, decimalSeparator: e.target.value === 'comma' ? 'comma' : 'point' })
                }
              >
                <option value="point">{t('decimalPoint')}</option>
                <option value="comma">{t('decimalComma')}</option>
              </select>
            </div>
            <ul className="flex flex-col gap-4" data-testid="mapper-fields">
              {XML_MAPPED_FIELDS.map((field) => {
                const f = state.fields[field];
                const enumValues = (XML_MAPPED_ENUM_FIELDS as Record<string, readonly string[]>)[field];
                return (
                  <li key={field} className="grid gap-2 rounded-md border p-3 sm:grid-cols-[14rem_1fr]">
                    <Label htmlFor={`${ids}-f-${field}`}>
                      {t(`fields.${field}`)}
                      {REQUIRED.includes(field) ? <span aria-hidden="true"> *</span> : null}
                    </Label>
                    <div className="flex flex-col gap-2">
                      <select
                        id={`${ids}-f-${field}`}
                        className={SELECT}
                        value={f.source}
                        onChange={(e) => setField(field, { source: e.target.value })}
                      >
                        <option value="">{t('notMapped')}</option>
                        <option value={CONSTANT}>{t('constant')}</option>
                        {paths.map((p) => (
                          <option key={p.path} value={p.path}>
                            {p.path}
                          </option>
                        ))}
                      </select>
                      {f.source === CONSTANT ? (
                        <Input
                          aria-label={t('constantFor', { field: t(`fields.${field}`) })}
                          value={f.constant}
                          maxLength={200}
                          onChange={(e) => setField(field, { constant: e.target.value })}
                        />
                      ) : f.source ? (
                        <p className="text-xs text-muted-foreground" data-testid={`values-${field}`}>
                          {sampleLine(f.source)}
                        </p>
                      ) : null}
                      {enumValues && f.source ? (
                        <div className="flex flex-col gap-1">
                          <Label htmlFor={`${ids}-t-${field}`} className="text-xs font-normal">
                            {t('translate', { values: enumValues.join(', ') })}
                          </Label>
                          <textarea
                            id={`${ids}-t-${field}`}
                            rows={3}
                            className="rounded-md border bg-background p-2 font-mono text-xs"
                            placeholder={`${t('translateExample')}`}
                            value={f.translate}
                            maxLength={4000}
                            onChange={(e) => setField(field, { translate: e.target.value })}
                          />
                        </div>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>

            <div className="grid gap-4 sm:grid-cols-2">
              {(['features', 'images'] as const).map((list) => (
                <div key={list} className="flex flex-col gap-2 rounded-md border p-3">
                  <Label htmlFor={`${ids}-l-${list}`}>{t(`lists.${list}`)}</Label>
                  <select
                    id={`${ids}-l-${list}`}
                    className={SELECT}
                    value={state[list].path}
                    onChange={(e) => setState({ ...state, [list]: { ...state[list], path: e.target.value } })}
                  >
                    <option value="">{t('notMapped')}</option>
                    {paths.map((p) => (
                      <option key={p.path} value={p.path}>
                        {p.path}
                      </option>
                    ))}
                  </select>
                  {state[list].path ? (
                    <p className="text-xs text-muted-foreground">{sampleLine(state[list].path)}</p>
                  ) : null}
                  <Label htmlFor={`${ids}-s-${list}`} className="text-xs font-normal">
                    {t('separator')}
                  </Label>
                  <Input
                    id={`${ids}-s-${list}`}
                    className="w-24"
                    maxLength={3}
                    value={state[list].separator}
                    onChange={(e) => setState({ ...state, [list]: { ...state[list], separator: e.target.value } })}
                  />
                </div>
              ))}
            </div>

            <div className="flex flex-col gap-2 rounded-md border p-3">
              <h3 className="text-sm font-medium">{t('translations')}</h3>
              {state.translations.map((tr, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity besides their position
                <div key={i} className="grid gap-2 sm:grid-cols-3">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor={`${ids}-tl-${i}`}>{t('locale')}</Label>
                    <select
                      id={`${ids}-tl-${i}`}
                      className={SELECT}
                      value={tr.locale}
                      onChange={(e) => setTranslation(i, { locale: e.target.value })}
                    >
                      {locales.map((l) => (
                        <option key={l} value={l}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </div>
                  {(['title', 'description'] as const).map((k) => (
                    <div key={k} className="flex flex-col gap-1">
                      <Label htmlFor={`${ids}-tt-${i}-${k}`}>{t(`text.${k}`)}</Label>
                      <select
                        id={`${ids}-tt-${i}-${k}`}
                        className={SELECT}
                        value={tr[k]}
                        onChange={(e) => setTranslation(i, { [k]: e.target.value })}
                      >
                        <option value="">{t('notMapped')}</option>
                        {paths.map((p) => (
                          <option key={p.path} value={p.path}>
                            {p.path}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              ))}
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={state.translations.length >= 10}
                  onClick={() =>
                    setState({
                      ...state,
                      translations: [
                        ...state.translations,
                        {
                          locale: locales.find((l) => !state.translations.some((x) => x.locale === l)) ?? defaultLocale,
                          title: '',
                          description: '',
                        },
                      ],
                    })
                  }
                >
                  {t('addLanguage')}
                </Button>
                {state.translations.length > 1 ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setState({ ...state, translations: state.translations.slice(0, -1) })}
                  >
                    {t('removeLanguage')}
                  </Button>
                ) : null}
              </div>
            </div>
          </section>

          <section className="flex flex-col gap-3" aria-labelledby={`${ids}-preview`}>
            <h2 id={`${ids}-preview`} className="text-lg font-medium">
              {t('step4')}
            </h2>
            {!mapping ? (
              <p className="text-sm text-muted-foreground">{t('needRequired')}</p>
            ) : previewError ? (
              <p role="alert" className="text-sm text-destructive">
                {previewError}
              </p>
            ) : preview ? (
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-left text-sm" data-testid="mapper-preview">
                  <thead className="bg-muted">
                    <tr>
                      <th className="p-2">{t('preview.ref')}</th>
                      <th className="p-2">{t('preview.what')}</th>
                      <th className="p-2">{t('preview.price')}</th>
                      <th className="p-2">{t('preview.where')}</th>
                      <th className="p-2">{t('preview.result')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {preview.items.slice(0, 6).map((item) => {
                      const l = item.listing as {
                        transactionType?: string;
                        propertyType?: string;
                        priceCents?: number | null;
                        currency?: string;
                        location?: Record<string, string>;
                        bedrooms?: number | null;
                      } | null;
                      return (
                        <tr key={item.position}>
                          <td className="p-2 font-mono text-xs">{item.ref ?? '—'}</td>
                          <td className="p-2">
                            {l
                              ? `${l.propertyType ?? ''} · ${l.transactionType ?? ''}${l.bedrooms != null ? ` · ${l.bedrooms}` : ''}`
                              : '—'}
                          </td>
                          <td className="p-2">
                            {l?.priceCents != null
                              ? `${(l.priceCents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })} ${l.currency ?? ''}`
                              : '—'}
                          </td>
                          <td className="p-2">{l ? Object.values(l.location ?? {}).join(', ') : '—'}</td>
                          <td className="p-2">
                            {item.problems[0] ? (
                              <span className="text-destructive">
                                {item.problems[0].code}
                                {item.problems[0].field ? ` (${item.problems[0].field})` : ''}
                              </span>
                            ) : (
                              t('preview.ok')
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('loading')}</p>
            )}
          </section>

          <section className="flex flex-col gap-3" aria-labelledby={`${ids}-dry`}>
            <h2 id={`${ids}-dry`} className="text-lg font-medium">
              {t('step5')}
            </h2>
            <p className="text-sm text-muted-foreground">{t('dryRunHint')}</p>
            <div>
              <Button type="button" variant="outline" disabled={!mapping || busy} onClick={dryRun}>
                {t('dryRun')}
              </Button>
            </div>
            {report ? (
              <div className="flex flex-col gap-3 rounded-md border p-3" data-testid="dry-run-report">
                <p className="text-sm">
                  {t('report.summary', {
                    total: String(report.total),
                    created: String(report.wouldCreate),
                    updated: String(report.wouldUpdate),
                    held: String(report.wouldHold),
                    refused: String(report.refused),
                  })}
                </p>
                {report.refusals.length > 0 ? (
                  <div>
                    <h3 className="text-sm font-medium">{t('report.refused')}</h3>
                    <ul className="text-sm">
                      {report.refusals.map((r) => (
                        <li key={r.position}>
                          {r.itemRef ?? `#${r.position + 1}`}: {r.problem.code}
                          {r.problem.field ? ` (${r.problem.field})` : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {report.unmatched.length > 0 ? (
                  <div>
                    <h3 className="text-sm font-medium">{t('report.unmatched')}</h3>
                    <p className="text-xs text-muted-foreground">{t('report.unmatchedHint')}</p>
                    <ul className="text-sm">
                      {report.unmatched.map((u) => (
                        <li key={`${u.kind}-${u.text}`}>
                          {t(`report.kinds.${u.kind}`)}: {u.text} (×{u.count})
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>

          <section className="flex max-w-xl flex-col gap-3" aria-labelledby={`${ids}-save`}>
            <h2 id={`${ids}-save`} className="text-lg font-medium">
              {t('step6')}
            </h2>
            <Label htmlFor={`${ids}-name`}>{t('profileName')}</Label>
            <Input id={`${ids}-name`} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            <div>
              {sample.sheet ? (
                <Button type="button" disabled={!mapping || !name.trim() || busy} onClick={importSheet}>
                  {t('importSheet')}
                </Button>
              ) : (
                <Button type="button" disabled={!mapping || !name.trim() || busy} onClick={save}>
                  {t('save')}
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">{sample.sheet ? t('importSheetHint') : t('saveHint')}</p>
          </section>
        </>
      ) : null}
    </div>
  );
}
