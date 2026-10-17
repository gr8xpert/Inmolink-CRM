'use client';

import type { DevelopmentDocumentDto } from '@inmolink/contracts';
import { DEVELOPMENT_DOCUMENT_KINDS, DEVELOPMENT_DOCUMENT_MAX_BYTES } from '@inmolink/contracts/values';
import { Button } from '@inmolink/ui';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState } from 'react';
import { makeT } from '../../listings/values';
import { type DevResult, deleteDocumentAction, openDocumentAction, updateDocumentAction } from '../actions';

type Kind = (typeof DEVELOPMENT_DOCUMENT_KINDS)[number];

interface Props {
  developmentId: string;
  initial: DevelopmentDocumentDto[];
  /** Another agency's development: its shared documents, opened only. */
  readOnly: boolean;
  messages: Record<string, unknown>;
}

const SELECT = 'h-8 rounded-md border bg-background px-2 text-sm disabled:opacity-60';
const MAX_MB = String(DEVELOPMENT_DOCUMENT_MAX_BYTES / 1024 / 1024);

/** Sends one PDF as the raw body (XHR, for upload progress) to the web route that relays it to the API. */
function sendPdf(
  developmentId: string,
  file: File,
  options: { kind: Kind; shared: boolean },
  onProgress: (p: number) => void,
) {
  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const xhr = new XMLHttpRequest();
    const qs = new URLSearchParams({ kind: options.kind, shared: String(options.shared) });
    xhr.open('POST', `/api/developments/${encodeURIComponent(developmentId)}/documents?${qs}`);
    xhr.setRequestHeader('content-type', 'application/pdf');
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText) as { ok: boolean; error?: string };
        resolve(body.ok ? { ok: true } : { ok: false, error: body.error ?? 'generic' });
      } catch {
        resolve({ ok: false, error: 'generic' });
      }
    };
    xhr.onerror = () => resolve({ ok: false, error: 'generic' });
    xhr.send(file);
  });
}

/**
 * Development documents (S4-F4): brochures, plans, price lists and legal files (PDF). The owner uploads them
 * with a kind and chooses which ones collaborating agencies may read; another agency sees the shared ones and
 * opens them. Uploads show their progress; the server checks the real type (a renamed file is refused) and the
 * size. Opening one asks for a short signed download URL. After a change the page refreshes, so the price
 * lists can name a new document as their source. Presentation only: every call goes through `../actions` or
 * the upload route.
 */
export default function DocumentsPanel({ developmentId, initial, readOnly, messages }: Props) {
  const t = makeT(messages);
  const router = useRouter();
  const ids = useId();
  const [items, setItems] = useState(initial);
  const [kind, setKind] = useState<Kind>('BROCHURE');
  const [shared, setShared] = useState(false);
  const [progress, setProgress] = useState<{ name: string; loaded: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const errorText = (code: string) => {
    const k = `documents.errors.${code}`;
    const text = t(k, { max: MAX_MB });
    return text === k ? t('documents.errors.generic') : text;
  };
  const fail = (res: Extract<DevResult<unknown>, { ok: false }>) => {
    if (res.revoked) window.location.reload();
    else setError(res.code);
  };

  const upload = async (files: File[]) => {
    setError(null);
    for (const file of files) {
      if (file.size > DEVELOPMENT_DOCUMENT_MAX_BYTES) {
        setError('PAYLOAD_TOO_LARGE');
        continue;
      }
      setProgress({ name: file.name, loaded: 0 });
      const res = await sendPdf(developmentId, file, { kind, shared }, (loaded) =>
        setProgress({ name: file.name, loaded }),
      );
      if (!res.ok) {
        if (res.error === 'revoked') return window.location.reload();
        setError(res.error ?? 'generic');
      }
    }
    setProgress(null);
    router.refresh();
  };

  const open = async (doc: DevelopmentDocumentDto) => {
    const res = await openDocumentAction(developmentId, doc.id);
    if (res.ok) window.open(res.data.url, '_blank', 'noopener');
    else fail(res);
  };

  const change = async (doc: DevelopmentDocumentDto, patch: { kind?: Kind; shared?: boolean }) => {
    setError(null);
    const res = await updateDocumentAction(developmentId, doc.id, patch);
    if (!res.ok) return fail(res);
    setItems((all) => all.map((d) => (d.id === doc.id ? res.data : d)));
    router.refresh();
  };

  const remove = async (doc: DevelopmentDocumentDto) => {
    setError(null);
    const res = await deleteDocumentAction(developmentId, doc.id);
    if (!res.ok) return fail(res);
    setItems(res.data.items);
    router.refresh();
  };

  // The server's list wins after a refresh (an upload added rows this state does not have yet).
  const [seen, setSeen] = useState(initial);
  if (seen !== initial) {
    setSeen(initial);
    setItems(initial);
  }

  return (
    <section aria-labelledby={`${ids}-h`} className="flex flex-col gap-3 rounded-md border p-4" id="section-documents">
      <div>
        <h2 id={`${ids}-h`} className="text-base font-semibold">
          {t('documents.title')}
        </h2>
        <p className="text-sm text-muted-foreground">
          {readOnly ? t('documents.readOnlyIntro') : t('documents.intro')}
        </p>
      </div>
      {readOnly ? null : (
        <div className="flex flex-wrap items-center gap-3">
          <select
            className={SELECT}
            aria-label={t('documents.kindForUpload')}
            value={kind}
            onChange={(e) => setKind(e.target.value as Kind)}
          >
            {DEVELOPMENT_DOCUMENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`documents.kinds.${k}`)}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
            {t('documents.sharedForUpload')}
          </label>
          <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={progress !== null}>
            {t('documents.choose')}
          </Button>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept="application/pdf,.pdf"
            aria-label={t('documents.input')}
            className="sr-only"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              void upload(files);
            }}
          />
          <span className="text-xs text-muted-foreground">{t('documents.hint', { max: MAX_MB })}</span>
        </div>
      )}
      {progress ? (
        <div className="flex flex-col gap-1" data-testid="documents-progress">
          <progress className="h-2 w-full" max={1} value={progress.loaded} aria-label={t('documents.progressLabel')} />
          <span className="text-xs">
            {progress.name} · {Math.round(progress.loaded * 100)} %
          </span>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive" data-testid="documents-error">
          {errorText(error)}
        </p>
      ) : null}
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('documents.empty')}</p>
      ) : (
        <ul className="flex flex-col divide-y text-sm" data-testid="documents-list">
          {items.map((d) => (
            <li
              key={d.id}
              className="flex flex-wrap items-center justify-between gap-2 py-1"
              data-testid="document-item"
            >
              <span className="min-w-0 truncate">
                {d.fileName}{' '}
                <span className="text-xs text-muted-foreground">
                  ({readOnly ? `${t(`documents.kinds.${d.kind}`)} · ` : ''}
                  {Math.ceil(d.sizeBytes / 1024)} KB)
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-2">
                {readOnly ? null : (
                  <>
                    <select
                      className={SELECT}
                      aria-label={t('documents.kindOf', { name: d.fileName })}
                      value={d.kind}
                      onChange={(e) => void change(d, { kind: e.target.value as Kind })}
                    >
                      {DEVELOPMENT_DOCUMENT_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {t(`documents.kinds.${k}`)}
                        </option>
                      ))}
                    </select>
                    <label className="flex items-center gap-1 text-xs">
                      <input
                        type="checkbox"
                        aria-label={t('documents.sharedOf', { name: d.fileName })}
                        checked={d.shared}
                        onChange={(e) => void change(d, { shared: e.target.checked })}
                      />
                      {t('documents.shared')}
                    </label>
                  </>
                )}
                <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => void open(d)}>
                  {t('documents.open')}
                </Button>
                {readOnly ? null : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs text-destructive"
                    aria-label={`${t('documents.remove')}: ${d.fileName}`}
                    onClick={() => void remove(d)}
                  >
                    {t('documents.remove')}
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
