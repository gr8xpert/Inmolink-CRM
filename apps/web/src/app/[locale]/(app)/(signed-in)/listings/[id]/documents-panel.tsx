'use client';

import { LISTING_DOCUMENT_MAX_BYTES, type ListingDocumentDto } from '@inmolink/contracts';
import { Button } from '@inmolink/ui';
import { useEffect, useRef, useState } from 'react';
import { deleteDocumentAction, listDocumentsAction, openDocumentAction } from '../actions';
import { makeT } from '../values';

export interface DocumentsPanelProps {
  listingId: string;
  readOnly: boolean;
  /** The `listings` catalog, translated on the server. */
  messages: Record<string, unknown>;
}

const MAX_MB = String(LISTING_DOCUMENT_MAX_BYTES / 1024 / 1024);

/** Sends one PDF as the raw body (XHR, for upload progress) to the web route that relays it to the API. */
function sendPdf(listingId: string, file: File, onProgress: (p: number) => void) {
  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/listings/${encodeURIComponent(listingId)}/documents`);
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
 * Listing documents (S3-F5): PDFs private to the agency (nota simple, contracts, plans). Uploads show their
 * progress; the server checks the real type (a renamed file is refused) and the size. Opening one asks for a
 * short signed download URL. Presentation only: every call goes through `../actions` or the upload route.
 */
export default function DocumentsPanel(props: DocumentsPanelProps) {
  const t = makeT(props.messages);
  const id = props.listingId;
  const [items, setItems] = useState<ListingDocumentDto[]>([]);
  const [progress, setProgress] = useState<{ name: string; loaded: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const errorText = (code: string) => {
    const k = `documents.errors.${code}`;
    const text = t(k, { max: MAX_MB });
    return text === k ? t('documents.errors.generic') : text;
  };

  const reload = async () => {
    const res = await listDocumentsAction(id);
    if (res.ok) setItems(res.data.items);
    else if (res.revoked) window.location.reload();
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once per listing
  useEffect(() => {
    void reload();
  }, [id]);

  const upload = async (files: File[]) => {
    setError(null);
    for (const file of files) {
      if (file.size > LISTING_DOCUMENT_MAX_BYTES) {
        setError('PAYLOAD_TOO_LARGE');
        continue;
      }
      setProgress({ name: file.name, loaded: 0 });
      const res = await sendPdf(id, file, (loaded) => setProgress({ name: file.name, loaded }));
      if (!res.ok) setError(res.error ?? 'generic');
    }
    setProgress(null);
    await reload();
  };

  const open = async (doc: ListingDocumentDto) => {
    const res = await openDocumentAction(id, doc.id);
    if (res.ok) window.open(res.data.url, '_blank', 'noopener');
    else setError(res.code);
  };

  const remove = async (doc: ListingDocumentDto) => {
    const res = await deleteDocumentAction(id, doc.id);
    if (res.ok) setItems(res.data.items);
    else setError(res.code);
  };

  return (
    <fieldset id="section-documents" className="flex flex-col gap-3 rounded-md border p-4">
      <legend className="px-1 text-sm font-semibold">{t('documents.title')}</legend>
      <p className="text-sm text-muted-foreground">{t('documents.intro')}</p>
      {props.readOnly ? null : (
        <div className="flex flex-wrap items-center gap-2">
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
            <li key={d.id} className="flex items-center justify-between gap-2 py-1" data-testid="document-item">
              <span className="truncate">
                {d.fileName} <span className="text-xs text-muted-foreground">({Math.ceil(d.sizeBytes / 1024)} KB)</span>
              </span>
              <span className="flex gap-1">
                <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => void open(d)}>
                  {t('documents.open')}
                </Button>
                {props.readOnly ? null : (
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
    </fieldset>
  );
}
