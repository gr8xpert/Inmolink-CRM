'use client';

import type { ContactImportDto, ContactImportPreviewDto, ContactImportUploadDto } from '@inmolink/contracts';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Link, useRouter } from '@/i18n/navigation';
import { makeT } from '../../listings/values';
import { type ImportResult, importStatusAction, previewImportAction, startImportAction } from './actions';
import {
  type ColumnFields,
  columnFieldsFrom,
  DEFAULT_IMPORT_OPTIONS,
  emptyFileReason,
  hasConsentColumn,
  hasIdentityColumn,
  IMPORT_FIELDS,
  type ImportField,
  type ImportOptions,
  setColumnField,
  toStartInput,
} from './import-state';

/**
 * The contact import screen (S17-F29): upload → confirm the columns → check the first rows → import in the background,
 * following the run until it ends. Every call goes through the upload route and the server actions; duplicates are
 * skipped and no consent is given unless the person chooses otherwise.
 */

const SELECT = 'h-9 w-full rounded-md border bg-background px-2 text-sm';
const BUTTON = 'h-9 self-start rounded-md border px-3 text-sm font-medium disabled:opacity-50';
const HINT = 'text-xs text-muted-foreground';
const POLL_MS = 2_000;
/** Status calls in a row that may fail before the screen stops following the run. */
const POLL_FAILURES = 5;

type T = ReturnType<typeof makeT>;
type UploadResult = ImportResult<ContactImportUploadDto>;

async function uploadFile(file: File): Promise<UploadResult> {
  try {
    const res = await fetch('/api/contacts/import', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    });
    return (await res.json()) as UploadResult;
  } catch {
    return { ok: false, error: 'generic' };
  }
}

const isOver = (run: ContactImportDto) => ['SUCCEEDED', 'FAILED', 'EXPIRED'].includes(run.status);

const sessionGone = () => window.location.assign('/session/expired');

/** A refusal in words: the file's reason when there is one, then the error code, then the generic message. */
function describe(t: T, res: { error: string; reason?: string }): string {
  const reason = res.reason ? t(`import.fileErrors.${res.reason}`) : null;
  if (reason && reason !== `import.fileErrors.${res.reason}`) return reason;
  const known = t(`errors.${res.error}`);
  return known === `errors.${res.error}` ? t('errors.generic') : known;
}

export default function ImportPanel({
  messages,
  contactTypes,
}: {
  messages: Record<string, unknown>;
  contactTypes: readonly string[];
}) {
  const t = useMemo(() => makeT(messages), [messages]);
  const router = useRouter();
  const [upload, setUpload] = useState<ContactImportUploadDto | null>(null);
  const [fields, setFields] = useState<ColumnFields>([]);
  const [options, setOptions] = useState<ImportOptions>(DEFAULT_IMPORT_OPTIONS);
  const [preview, setPreview] = useState<ContactImportPreviewDto | null>(null);
  const [stale, setStale] = useState(false);
  const [runState, setRunState] = useState<ContactImportDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lost, setLost] = useState(false);
  const [busy, setBusy] = useState<'check' | 'start' | null>(null);
  const [pending, startTransition] = useTransition();
  /** Moves with every change of the columns or options: an answer for an older choice is dropped. */
  const generation = useRef(0);

  const importId = upload?.id;
  const following = runState !== null && !isOver(runState) && !lost;
  useEffect(() => {
    if (!importId || !following) return;
    let failures = 0;
    const timer = setInterval(async () => {
      const res = await importStatusAction(importId).catch(() => null);
      if (res?.ok) {
        failures = 0;
        setError(null);
        setRunState(res.data);
        if (isOver(res.data)) router.refresh();
        return;
      }
      failures += 1;
      if (failures >= POLL_FAILURES) {
        setLost(true);
        router.refresh();
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [importId, following, router]);

  const problem = (res: { error: string; reason?: string }) => describe(t, res);

  /** Any change of the columns or the options makes the check out of date. */
  const changed = () => {
    generation.current += 1;
    if (preview) setStale(true);
    setPreview(null);
    setError(null);
  };
  const setOption = <K extends keyof ImportOptions>(key: K, value: ImportOptions[K]) => {
    changed();
    setOptions((o) => ({ ...o, [key]: value }));
  };
  const reset = () => {
    generation.current += 1;
    setLost(false);
    setUpload(null);
    setFields([]);
    setOptions(DEFAULT_IMPORT_OPTIONS);
    setPreview(null);
    setStale(false);
    setRunState(null);
    setError(null);
  };

  const chooseFile = (file: File | undefined) => {
    if (!file) return;
    setError(null);
    // S17-F37: a file with no bytes has no rows either; the upload route would answer 411 (no length), so say it here.
    const empty = emptyFileReason(file);
    if (empty) return setError(t(`import.fileErrors.${empty}`));
    startTransition(async () => {
      const res = await uploadFile(file);
      if (!res.ok) {
        if (res.error === 'revoked') return sessionGone();
        setError(problem(res));
        return;
      }
      setUpload(res.data);
      setFields(columnFieldsFrom(res.data.suggested, res.data.headers.length));
    });
  };

  const check = () => {
    if (!upload) return;
    const asked = generation.current;
    setError(null);
    setBusy('check');
    startTransition(async () => {
      const res = await previewImportAction(upload.id, toStartInput(fields, options)).catch(() => null);
      setBusy(null);
      if (asked !== generation.current) return;
      if (!res) {
        setError(t('errors.generic'));
        return;
      }
      if (!res.ok) {
        setError(problem(res));
        return;
      }
      setPreview(res.data);
      setStale(false);
    });
  };

  const start = () => {
    if (!upload) return;
    setError(null);
    setBusy('start');
    startTransition(async () => {
      const res = await startImportAction(upload.id, toStartInput(fields, options)).catch(() => null);
      setBusy(null);
      if (!res) {
        setError(t('errors.generic'));
        return;
      }
      if (!res.ok) {
        setError(problem(res));
        return;
      }
      setRunState(res.data);
      router.refresh();
    });
  };

  const alert = error ? (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  ) : null;

  if (runState) return <RunReport run={runState} lost={lost} t={t} alert={alert} onAnother={reset} />;

  if (!upload) {
    return (
      <section className="flex flex-col gap-2 text-sm">
        <label className="flex flex-col gap-1">
          <span className="font-medium">{t('import.upload')}</span>
          <input
            type="file"
            accept=".csv,.xlsx,text/csv"
            disabled={pending}
            data-testid="contact-import-file"
            onChange={(e) => {
              chooseFile(e.target.files?.[0]);
              // so the same file, corrected, can be chosen again after a refusal
              e.target.value = '';
            }}
          />
        </label>
        {pending ? <p role="status">{t('import.uploading')}</p> : null}
        {alert}
      </section>
    );
  }

  const canCheck = hasIdentityColumn(fields);
  return (
    <div className="flex flex-col gap-6 text-sm">
      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">{t('import.mapping')}</h2>
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-left" data-testid="contact-import-columns">
            <thead className="border-b text-muted-foreground">
              <tr>
                <th className="p-2 font-medium">{t('import.column')}</th>
                <th className="p-2 font-medium">{t('import.firstValues')}</th>
                <th className="p-2 font-medium">{t('import.goesTo')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {upload.headers.map((header, column) => {
                const name = header || t('import.untitled', { number: String(column + 1) });
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: columns are positions, and two can share a name
                  <tr key={column}>
                    <td className="p-2 font-medium">{name}</td>
                    <td className="max-w-64 truncate p-2 text-muted-foreground">
                      {upload.rows
                        .map((r) => r[column] ?? '')
                        .filter(Boolean)
                        .slice(0, 3)
                        .join(' · ')}
                    </td>
                    <td className="p-2">
                      <select
                        aria-label={`${t('import.goesTo')}: ${name}`}
                        value={fields[column] ?? ''}
                        className={SELECT}
                        onChange={(e) => {
                          changed();
                          setFields((f) => setColumnField(f, column, e.target.value as ImportField | ''));
                        }}
                      >
                        <option value="">{t('import.ignore')}</option>
                        {IMPORT_FIELDS.map((f) => (
                          <option key={f} value={f}>
                            {t(`import.mapFields.${f}`)}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className={HINT}>{t('import.consentWarning')}</p>
        {hasConsentColumn(fields) ? null : (
          <p data-testid="contact-import-no-consent">{t('import.consentColumnNone')}</p>
        )}
        {canCheck ? null : <p className="text-destructive">{t('import.needIdentity')}</p>}
      </section>

      <section className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 font-medium">{t('import.onDuplicate')}</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="onDuplicate"
              checked={options.onDuplicate === 'SKIP'}
              onChange={() => setOption('onDuplicate', 'SKIP')}
            />
            {t('import.SKIP')}
          </label>
          <span className={HINT}>{t('import.skipHint')}</span>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="onDuplicate"
              checked={options.onDuplicate === 'MERGE'}
              onChange={() => setOption('onDuplicate', 'MERGE')}
            />
            {t('import.MERGE')}
          </label>
          <span className={HINT}>{t('import.mergeHint')}</span>
        </fieldset>

        <fieldset className="flex flex-wrap gap-4">
          <legend className="mb-1 font-medium">{t('import.defaultTypes')}</legend>
          {contactTypes.map((type) => (
            <label key={type} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={options.defaultTypes.includes(type)}
                onChange={(e) =>
                  setOption(
                    'defaultTypes',
                    e.target.checked ? [...options.defaultTypes, type] : options.defaultTypes.filter((v) => v !== type),
                  )
                }
              />
              {t(`types.${type}`)}
            </label>
          ))}
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span>{t('import.tags')}</span>
            <input
              value={options.tags}
              maxLength={260}
              className="h-9 rounded-md border bg-background px-2"
              onChange={(e) => setOption('tags', e.target.value)}
            />
            <span className={HINT}>{t('import.tagsHint')}</span>
          </label>
          <label className="flex flex-col gap-1">
            <span>{t('import.phoneCountry')}</span>
            <input
              value={options.phoneCountry}
              maxLength={2}
              className="h-9 w-20 rounded-md border bg-background px-2 uppercase"
              onChange={(e) => setOption('phoneCountry', e.target.value)}
            />
            <span className={HINT}>{t('import.phoneCountryHint')}</span>
          </label>
        </div>
      </section>

      {stale ? <p role="status">{t('import.previewStale')}</p> : null}
      {alert}
      <div className="flex flex-wrap items-center gap-4">
        <button type="button" disabled={pending || !canCheck} className={BUTTON} onClick={check}>
          {busy === 'check' ? t('import.previewing') : t('import.previewButton')}
        </button>
        <button type="button" disabled={pending} className="text-sm underline-offset-4 hover:underline" onClick={reset}>
          {t('import.chooseAnother')}
        </button>
      </div>

      {preview ? (
        <>
          <PreviewTable preview={preview} t={t} />
          <button
            type="button"
            disabled={pending}
            className={BUTTON}
            data-testid="contact-import-start"
            onClick={start}
          >
            {busy === 'start' ? t('import.starting') : t('import.start')}
          </button>
        </>
      ) : null}
    </div>
  );
}

function PreviewTable({ preview, t }: { preview: ContactImportPreviewDto; t: T }) {
  const count = (status: string) => String(preview.rows.filter((r) => r.status === status).length);
  // problems first: they are what the person came to see
  const rows = [...preview.rows].sort(
    (a, b) => Number(a.status === 'NEW') - Number(b.status === 'NEW') || a.row - b.row,
  );
  return (
    <section className="flex flex-col gap-2" data-testid="contact-import-preview">
      <h2 className="text-base font-semibold">{t('import.previewTitle')}</h2>
      {preview.unchecked ? <p data-testid="contact-import-unchecked">{t('import.previewUnchecked')}</p> : null}
      <p>
        {t('import.previewSummary', {
          new: count('NEW'),
          existing: count('EXISTING'),
          repeated: count('REPEATED'),
          invalid: count('INVALID'),
        })}
      </p>
      <p>{t('import.previewConsent', { count: String(preview.rows.filter((r) => r.consentMarketing).length) })}</p>
      {preview.more ? <p>{t('import.previewMore', { count: String(preview.rows.length) })}</p> : null}
      <div className="max-h-96 overflow-auto rounded-md border">
        <table className="w-full text-left">
          <thead className="border-b text-muted-foreground">
            <tr>
              <th className="p-2 font-medium">{t('import.previewColumns.row')}</th>
              <th className="p-2 font-medium">{t('import.previewColumns.name')}</th>
              <th className="p-2 font-medium">{t('import.previewColumns.email')}</th>
              <th className="p-2 font-medium">{t('import.previewColumns.phone')}</th>
              <th className="p-2 font-medium">{t('import.previewColumns.marketing')}</th>
              <th className="p-2 font-medium">{t('import.previewColumns.result')}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((r) => (
              <tr key={r.row}>
                <td className="p-2">{r.row}</td>
                <td className="p-2">{r.name ?? ''}</td>
                <td className="p-2">{r.email ?? ''}</td>
                <td className="p-2">{r.phone ?? ''}</td>
                <td className="p-2">
                  {r.status === 'INVALID' ? '' : r.consentMarketing ? t('import.yes') : t('import.no')}
                </td>
                <td className={`p-2 ${r.status === 'INVALID' ? 'text-destructive' : ''}`}>
                  {r.code ? t(`import.rowErrors.${r.code}`) : t(`import.previewStatus.${r.status}`)}
                  {r.doNotContact ? ` · ${t('fields.doNotContact')}` : ''}
                  {r.contactId ? (
                    <>
                      {' · '}
                      <Link href={`/contacts/${r.contactId}`} className="underline-offset-4 hover:underline">
                        {t('import.openContact')}
                      </Link>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The run's outcome message: a known code in plain words, any other reader code as "this file cannot be read". */
function failureText(code: string | null, t: T): string {
  if (!code) return t('errors.generic');
  const failure = t(`import.failure.${code}`);
  if (failure !== `import.failure.${code}`) return failure;
  const file = t(`import.fileErrors.${code}`);
  return file !== `import.fileErrors.${code}` ? file : t('errors.CONTACT_IMPORT_FILE_INVALID');
}

function RunReport(props: {
  run: ContactImportDto;
  lost: boolean;
  t: T;
  alert: React.ReactNode;
  onAnother: () => void;
}) {
  const { run, t, lost } = props;
  const over = isOver(run);
  return (
    <section className="flex flex-col gap-3 text-sm" data-testid="contact-import-run">
      <p role="status" className="font-medium">
        {run.status === 'SUCCEEDED'
          ? t('import.finished')
          : over
            ? t('import.failed')
            : lost
              ? t('import.lost')
              : t('import.running')}
      </p>
      {run.status === 'FAILED' ? <p className="text-destructive">{failureText(run.errorCode, t)}</p> : null}
      <p>
        {t('import.counts', {
          created: String(run.createdCount),
          merged: String(run.mergedCount),
          skipped: String(run.skippedCount),
          invalid: String(run.invalidCount),
        })}
      </p>
      {run.status === 'FAILED' && run.createdCount + run.mergedCount > 0 ? <p>{t('import.partial')}</p> : null}
      {props.alert}
      {run.errors.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h2 className="font-medium">{t('import.rowErrorsTitle')}</h2>
          {run.invalidCount > run.errors.length ? (
            <p className={HINT}>{t('import.moreErrors', { count: String(run.errors.length) })}</p>
          ) : null}
          <ul className="max-h-64 divide-y overflow-auto rounded-md border">
            {run.errors.map((e) => (
              <li key={`${e.row}-${e.code}`} className="flex gap-3 p-2">
                <span className="font-medium">{t('import.row', { row: String(e.row) })}</span>
                <span>{t(`import.rowErrors.${e.code}`)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {over || lost ? (
        <button type="button" className={BUTTON} onClick={props.onAnother}>
          {t('import.another')}
        </button>
      ) : null}
    </section>
  );
}
