'use client';

import {
  LISTING_ROOM_TYPES,
  type ListingMediaDto,
  type ListingMediaList,
  MEDIA_MAX_BYTES,
  MEDIA_PER_LISTING_MAX,
  type MediaCheckResult,
} from '@inmolink/contracts';
import { Button } from '@inmolink/ui';
import { type DragEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  addVideoAction,
  checkMediaAction,
  detachMediaAction,
  type EditorResult,
  registerMediaAction,
  reorderMediaAction,
  updateMediaAction,
} from '../actions';
import { makeT } from '../values';
import { notifyListingChanged } from './listing-events';
import {
  batches,
  mapLimit,
  moveItem,
  PUT_ATTEMPTS,
  PUT_CONCURRENCY,
  partition,
  putHeaders,
  putOutcome,
  refusalOf,
  retryDelayMs,
  type UploadType,
  uploadTypeOf,
} from './media-upload';

type Status =
  | 'queued'
  | 'hashing'
  | 'checking'
  | 'uploading'
  | 'registering'
  | 'done'
  | 'stored'
  | 'skipped'
  | 'duplicate'
  | 'failed';
const FINAL: ReadonlySet<Status> = new Set(['done', 'stored', 'skipped', 'duplicate', 'failed']);

interface Entry {
  key: number;
  file: File;
  status: Status;
  /** Upload progress, 0…1. */
  loaded: number;
  /** Why it failed: a `reasons.*` key or an API error code. */
  reason?: string;
  sha256?: string;
}

export interface MediaManagerProps {
  listingId: string;
  initial: ListingMediaDto[];
  readOnly: boolean;
  /** The `listings` catalog, translated on the server. */
  messages: Record<string, unknown>;
}

const SELECT = 'h-8 w-full rounded-md border bg-background px-2 text-xs disabled:opacity-60';
const MAX_MB = String(Math.round(MEDIA_MAX_BYTES / 1024 / 1024));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Hashes files in a small pool of Web Workers (SHA-256, lowercase hex); null for a file that failed. */
async function hashFiles(files: File[], onHashed: (i: number, sha256: string | null) => void): Promise<void> {
  const size = Math.max(1, Math.min(4, files.length, (navigator.hardwareConcurrency || 2) - 1));
  const workers = Array.from({ length: size }, () => new Worker(new URL('./hash.worker.ts', import.meta.url)));
  try {
    let next = 0;
    await Promise.all(
      workers.map(async (worker) => {
        while (next < files.length) {
          const i = next++;
          const sha = await new Promise<string | null>((resolve) => {
            worker.onmessage = (e: MessageEvent<{ sha256?: string }>) => resolve(e.data.sha256 ?? null);
            worker.onerror = () => resolve(null);
            worker.postMessage({ id: i, file: files[i] });
          });
          onHashed(i, sha);
        }
      }),
    );
  } finally {
    for (const w of workers) w.terminate();
  }
}

/** One signed PUT straight to object storage, with upload progress; resolves the HTTP status (0: network). */
function putFile(url: string, headers: Record<string, string>, file: File, onProgress: (p: number) => void) {
  return new Promise<number>((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(putHeaders(headers))) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => resolve(xhr.status);
    xhr.onerror = () => resolve(0);
    xhr.ontimeout = () => resolve(0);
    xhr.send(file);
  });
}

/**
 * The media manager (S3-06): drag-and-drop mass upload — files are hashed in Web Workers, files the listing has
 * already (or chosen twice) are skipped without a request, `check` answers which the platform stores already
 * (no upload), the rest go straight to storage in parallel with retries and progress, then `register` attaches
 * them in order. Then reorder (drag or arrows), cover, kind (photo or floor plan), room type and alt text; every
 * change is saved at once, one at a time, and the server's answer is what the grid shows.
 */
export default function MediaManager(props: MediaManagerProps) {
  const t = makeT(props.messages);
  const id = props.listingId;
  const [items, setItems] = useState<ListingMediaDto[]>(props.initial);
  const [queue, setQueue] = useState<Entry[]>([]);
  const [running, setRunning] = useState(false);
  /** Changes sent and not answered yet; `saved` once one was answered. */
  const [pending, setPending] = useState(0);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alts, setAlts] = useState<Record<string, string>>({});
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [over, setOver] = useState(false);
  const [videoUrl, setVideoUrl] = useState('');

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const nextKey = useRef(0);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  /** Local previews of files uploaded in this visit, until the worker's own preview exists. */
  const previews = useRef(new Map<string, string>());
  const inputRef = useRef<HTMLInputElement>(null);

  // Every saved media change may move the quality score (S3-08): tell the page (not on the first render).
  const shown = useRef(items);
  useEffect(() => {
    if (shown.current === items) return;
    shown.current = items;
    notifyListingChanged(id);
  }, [id, items]);

  useEffect(() => {
    const urls = previews.current;
    return () => {
      for (const u of urls.values()) URL.revokeObjectURL(u);
    };
  }, []);

  const patchEntries = useCallback((keys: number[], patch: Partial<Entry>) => {
    const set = new Set(keys);
    setQueue((q) => q.map((e) => (set.has(e.key) ? { ...e, ...patch } : e)));
  }, []);

  const errorText = (code: string) => {
    const msg = t(`errors.${code}`);
    return msg === `errors.${code}` ? t('errors.generic') : msg;
  };

  /** A mutation, after the ones before it: the server's list answers it. */
  const mutate = useCallback((call: () => Promise<EditorResult<ListingMediaList>>, revert?: ListingMediaDto[]) => {
    setPending((n) => n + 1);
    const run = chain.current.then(async () => {
      try {
        const res = await call();
        if (res.ok) {
          setItems(res.data.items);
          setError(null);
          setSaved(true);
        } else {
          if (res.revoked) window.location.reload();
          if (revert) setItems(revert);
          setError(res.code);
          setSaved(false);
        }
      } finally {
        setPending((n) => n - 1);
      }
    });
    chain.current = run.catch(() => {});
    return run;
  }, []);

  /** Uploads one batch (≤ 100 hashed files) and attaches it; returns the entries' outcomes. */
  const uploadBatch = useCallback(
    async (batch: (Entry & { sha256: string; type: UploadType })[]) => {
      const keys = batch.map((e) => e.key);
      patchEntries(keys, { status: 'checking' });
      const checked: EditorResult<MediaCheckResult> = await checkMediaAction({
        files: batch.map((e) => ({ sha256: e.sha256, sizeBytes: e.file.size, contentType: e.type })),
      });
      if (!checked.ok) {
        patchEntries(keys, { status: 'failed', reason: checked.code });
        return;
      }
      const answers = new Map(checked.data.files.map((f) => [f.sha256, f]));
      const stored = new Set<number>();
      const ready = await mapLimit(batch, PUT_CONCURRENCY, async (e) => {
        const answer = answers.get(e.sha256);
        if (!answer?.upload) {
          stored.add(e.key);
          return true;
        }
        patchEntries([e.key], { status: 'uploading', loaded: 0 });
        for (let attempt = 1; attempt <= PUT_ATTEMPTS; attempt++) {
          if (attempt > 1) await sleep(retryDelayMs(attempt));
          const status = await putFile(answer.upload.url, answer.upload.headers, e.file, (p) =>
            patchEntries([e.key], { loaded: p }),
          );
          const outcome = putOutcome(status);
          if (outcome === 'done') return true;
          if (outcome === 'fail') break;
        }
        patchEntries([e.key], { status: 'failed', reason: 'NETWORK' });
        return false;
      });
      const toRegister = batch.filter((_, i) => ready[i]);
      if (toRegister.length === 0) return;
      patchEntries(
        toRegister.map((e) => e.key),
        { status: 'registering' },
      );
      const register = (files: typeof toRegister) =>
        registerMediaAction({ listingId: id, files: files.map((e) => ({ sha256: e.sha256 })) });
      const finish = (e: Entry, res: EditorResult<ListingMediaList>) => {
        if (res.ok) {
          setItems(res.data.items);
          if (!stored.has(e.key) && e.sha256 && !previews.current.has(e.sha256)) {
            previews.current.set(e.sha256, URL.createObjectURL(e.file));
          }
          patchEntries([e.key], { status: stored.has(e.key) ? 'stored' : 'done', loaded: 1 });
        } else patchEntries([e.key], { status: 'failed', reason: res.code });
      };
      const all = await register(toRegister);
      if (all.ok || toRegister.length === 1) {
        for (const e of toRegister) finish(e, all);
        return;
      }
      // One refused file (not an image after all, upload expired) refuses the batch: find it file by file.
      for (const e of toRegister) finish(e, await register([e]));
    },
    [id, patchEntries],
  );

  const run = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setRunning(true);
      setError(null);
      const entries: Entry[] = files.map((file) => {
        const refusal = refusalOf(file);
        return {
          key: nextKey.current++,
          file,
          status: refusal ? 'failed' : 'hashing',
          loaded: 0,
          ...(refusal ? { reason: `reasons.${refusal}` } : {}),
        };
      });
      setQueue((q) => (q.length > 0 && q.every((e) => FINAL.has(e.status)) ? entries : [...q, ...entries]));
      try {
        const accepted = entries.filter((e) => e.status !== 'failed');
        const hashed: (Entry & { sha256: string; type: UploadType })[] = [];
        const shas: (string | null)[] = new Array(accepted.length).fill(null);
        await hashFiles(
          accepted.map((e) => e.file),
          (i, sha) => {
            shas[i] = sha;
            const entry = accepted[i] as Entry;
            if (sha === null) patchEntries([entry.key], { status: 'failed', reason: 'generic' });
            else patchEntries([entry.key], { status: 'queued', sha256: sha });
          },
        );
        accepted.forEach((e, i) => {
          const sha = shas[i];
          if (sha) hashed.push({ ...e, sha256: sha, type: uploadTypeOf(e.file) as UploadType });
        });

        // Duplicates are skipped at once: on the listing already, or the same bytes chosen twice.
        const plan = partition(hashed, new Set(itemsRef.current.flatMap((m) => (m.sha256 ? [m.sha256] : []))));
        patchEntries(
          plan.skipped.map((e) => e.key),
          { status: 'skipped' },
        );
        patchEntries(
          plan.duplicates.map((e) => e.key),
          { status: 'duplicate' },
        );
        const room = Math.max(0, MEDIA_PER_LISTING_MAX - itemsRef.current.length);
        patchEntries(
          plan.send.slice(room).map((e) => e.key),
          { status: 'failed', reason: 'reasons.limit' },
        );
        for (const batch of batches(plan.send.slice(0, room))) await uploadBatch(batch);
      } finally {
        setRunning(false);
      }
    },
    [patchEntries, uploadBatch],
  );

  const retryFailed = () => {
    const failed = queue.filter((e) => e.status === 'failed' && !e.reason?.startsWith('reasons.'));
    setQueue((q) => q.filter((e) => !failed.includes(e)));
    void run(failed.map((e) => e.file));
  };

  // --- editing --------------------------------------------------------------------------------------------

  const reorder = (from: number, to: number) => {
    const before = itemsRef.current;
    const moved = moveItem(before, from, to);
    if (moved === before || moved.every((m, i) => m.id === before[i]?.id)) return;
    setItems(moved.map((m, i) => ({ ...m, position: i })));
    void mutate(() => reorderMediaAction(id, { ids: moved.map((m) => m.id) }), before);
  };
  const update = (mediaId: string, body: Record<string, unknown>) =>
    void mutate(() => updateMediaAction(id, mediaId, body));
  const remove = (mediaId: string) => void mutate(() => detachMediaAction(id, mediaId));
  const saveAlt = (m: ListingMediaDto) => {
    const draft = alts[m.id];
    if (draft === undefined || draft.trim() === (m.altText ?? '')) return;
    update(m.id, { altText: draft.trim() === '' ? null : draft.trim() });
  };

  const onDropFiles = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (props.readOnly || dragFrom !== null) return;
    void run(Array.from(e.dataTransfer.files));
  };

  const finished = queue.filter((e) => FINAL.has(e.status)).length;
  const count = (s: Status[]) => queue.filter((e) => s.includes(e.status)).length;
  const uploaded = count(['done', 'stored']);

  return (
    <fieldset id="section-media" className="flex flex-col gap-4 rounded-md border p-4">
      <legend className="px-1 text-sm font-semibold">{t('media.title')}</legend>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <span>{t('media.count', { count: String(items.length), limit: String(MEDIA_PER_LISTING_MAX) })}</span>
        <span role="status" aria-live="polite" data-testid="media-save-status" data-pending={pending}>
          {pending > 0 ? t('media.saving') : saved ? t('media.saved') : ''}
        </span>
      </div>

      {props.readOnly ? null : (
        <>
          <p className="text-sm text-muted-foreground">{t('media.intro')}</p>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: the drop area; the file input and button inside are the keyboard path */}
          <div
            data-testid="media-dropzone"
            onDragOver={(e) => {
              if (dragFrom !== null) return;
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={onDropFiles}
            className={`flex flex-col items-center gap-2 rounded-md border-2 border-dashed p-6 text-center text-sm ${
              over ? 'border-primary bg-accent' : ''
            }`}
          >
            <span>{t('media.drop')}</span>
            <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
              {t('media.choose')}
            </Button>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
              aria-label={t('media.input')}
              className="sr-only"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = '';
                void run(files);
              }}
            />
            <span className="text-xs text-muted-foreground">
              {t('media.hint', { max: MAX_MB, limit: String(MEDIA_PER_LISTING_MAX) })}
            </span>
          </div>
          <form
            className="flex flex-wrap items-end gap-2"
            data-testid="media-video-form"
            onSubmit={(e) => {
              e.preventDefault();
              const url = videoUrl.trim();
              if (!url) return;
              void mutate(() => addVideoAction(id, { url })).then(() => setVideoUrl(''));
            }}
          >
            <label className="flex min-w-64 flex-1 flex-col gap-0.5 text-sm">
              {t('media.video.label')}
              <input
                type="url"
                inputMode="url"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                placeholder="https://www.youtube.com/watch?v=…"
                maxLength={500}
                value={videoUrl}
                onChange={(e) => setVideoUrl(e.target.value)}
              />
            </label>
            <Button type="submit" size="sm" variant="outline" disabled={videoUrl.trim() === ''}>
              {t('media.video.add')}
            </Button>
            <span className="w-full text-xs text-muted-foreground">{t('media.video.hint')}</span>
          </form>
        </>
      )}

      {queue.length > 0 ? (
        <div className="flex flex-col gap-2" data-testid="media-queue">
          <progress className="h-2 w-full" max={queue.length} value={finished} aria-label={t('media.progressLabel')} />
          <p className="text-sm" data-testid="media-progress">
            {t('media.progress', { done: String(uploaded), total: String(queue.length) })}
          </p>
          {!running ? (
            <p className="text-sm text-muted-foreground" data-testid="media-summary">
              {t('media.summary', {
                uploaded: String(uploaded),
                skipped: String(count(['skipped', 'duplicate'])),
                failed: String(count(['failed'])),
              })}
            </p>
          ) : null}
          <ul className="max-h-48 overflow-y-auto text-xs">
            {queue.map((e) => (
              <li key={e.key} className="flex justify-between gap-2 border-b py-1" data-status={e.status}>
                <span className="truncate">{e.file.name}</span>
                <span className={e.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>
                  {e.status === 'uploading'
                    ? `${t('media.status.uploading')} ${Math.round(e.loaded * 100)} %`
                    : t(`media.status.${e.status}`)}
                  {e.reason
                    ? ` · ${e.reason.startsWith('reasons.') ? t(`media.${e.reason}`, { max: MAX_MB, limit: String(MEDIA_PER_LISTING_MAX) }) : errorText(e.reason)}`
                    : ''}
                </span>
              </li>
            ))}
          </ul>
          {!running ? (
            <div className="flex gap-2">
              {queue.some((e) => e.status === 'failed' && !e.reason?.startsWith('reasons.')) ? (
                <Button size="sm" onClick={retryFailed}>
                  {t('media.retryFailed')}
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" onClick={() => setQueue([])}>
                {t('media.clear')}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive" data-testid="media-error">
          {errorText(error)}
        </p>
      ) : null}

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('media.empty')}</p>
      ) : (
        <>
          {props.readOnly ? null : <p className="text-xs text-muted-foreground">{t('media.dragHint')}</p>}
          <ol className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4" data-testid="media-grid">
            {items.map((m, i) => {
              const src = m.thumbUrl ?? (m.sha256 ? previews.current.get(m.sha256) : undefined) ?? null;
              const isVideo = m.kind === 'VIDEO';
              const label = t('media.item', { n: String(i + 1) });
              return (
                <li
                  key={m.id}
                  data-testid="media-item"
                  data-media-id={m.id}
                  aria-label={label}
                  draggable={!props.readOnly}
                  onDragStart={(e) => {
                    setDragFrom(i);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', m.id);
                  }}
                  onDragEnd={() => setDragFrom(null)}
                  onDragOver={(e) => {
                    if (dragFrom !== null) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragFrom !== null) reorder(dragFrom, i);
                    setDragFrom(null);
                  }}
                  className={`flex flex-col gap-1 rounded-md border p-2 ${dragFrom === i ? 'opacity-50' : ''}`}
                >
                  <div className="relative aspect-[4/3] overflow-hidden rounded bg-muted">
                    {isVideo && m.video ? (
                      <a
                        href={m.video.embedUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        data-testid="media-video"
                        data-provider={m.video.provider}
                        className="flex h-full flex-col items-center justify-center gap-1 text-sm underline"
                      >
                        <span aria-hidden="true" className="text-2xl">
                          ▶
                        </span>
                        {t(`media.video.providers.${m.video.provider}`)}
                      </a>
                    ) : src ? (
                      // biome-ignore lint/performance/noImgElement: a 320 px variant or a local preview, already sized
                      <img
                        src={src}
                        alt={m.altText ?? ''}
                        width={320}
                        height={240}
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span className="flex h-full items-center justify-center p-2 text-center text-xs text-muted-foreground">
                        {t('media.processing')}
                      </span>
                    )}
                    <span className="absolute left-1 top-1 rounded bg-background/80 px-1 text-xs">{i + 1}</span>
                    {m.isCover ? (
                      <span
                        className="absolute right-1 top-1 rounded bg-primary px-1 text-xs text-primary-foreground"
                        data-testid="media-cover"
                      >
                        {t('media.cover')}
                      </span>
                    ) : null}
                  </div>
                  {props.readOnly ? (
                    <span className="text-xs">{t(`media.kinds.${m.kind}`)}</span>
                  ) : (
                    <>
                      <div className="flex flex-wrap gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-xs"
                          disabled={i === 0}
                          aria-label={`${t('media.earlier')}: ${label}`}
                          onClick={() => reorder(i, i - 1)}
                        >
                          ←
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-xs"
                          disabled={i === items.length - 1}
                          aria-label={`${t('media.later')}: ${label}`}
                          onClick={() => reorder(i, i + 1)}
                        >
                          →
                        </Button>
                        {m.kind === 'IMAGE' && !m.isCover && !isVideo ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-xs"
                            aria-label={`${t('media.makeCover')}: ${label}`}
                            onClick={() => update(m.id, { cover: true })}
                          >
                            {t('media.makeCover')}
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs text-destructive"
                          aria-label={`${t('media.remove')}: ${label}`}
                          onClick={() => remove(m.id)}
                        >
                          {t('media.remove')}
                        </Button>
                      </div>
                      {isVideo ? null : (
                        <>
                          <label className="flex flex-col gap-0.5 text-xs">
                            {t('media.kind')}
                            <select
                              className={SELECT}
                              value={m.kind}
                              onChange={(e) => update(m.id, { kind: e.target.value })}
                            >
                              {(['IMAGE', 'FLOOR_PLAN'] as const).map((k) => (
                                <option key={k} value={k}>
                                  {t(`media.kinds.${k}`)}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="flex flex-col gap-0.5 text-xs">
                            {t('media.roomType')}
                            <select
                              className={SELECT}
                              value={m.roomType ?? ''}
                              onChange={(e) =>
                                update(m.id, { roomType: e.target.value === '' ? null : e.target.value })
                              }
                            >
                              <option value="">{t('media.noRoom')}</option>
                              {LISTING_ROOM_TYPES.map((r) => (
                                <option key={r} value={r}>
                                  {t(`media.rooms.${r}`)}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="flex flex-col gap-0.5 text-xs">
                            {t('media.altText')}
                            <input
                              className="h-8 w-full rounded-md border bg-background px-2 text-xs"
                              maxLength={300}
                              title={t('media.altHint')}
                              value={alts[m.id] ?? m.altText ?? ''}
                              onChange={(e) => setAlts((a) => ({ ...a, [m.id]: e.target.value }))}
                              onBlur={() => saveAlt(m)}
                            />
                          </label>
                        </>
                      )}
                    </>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </fieldset>
  );
}
