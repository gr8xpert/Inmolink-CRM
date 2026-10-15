'use client';

import { Button, Input } from '@inmolink/ui';
import { type FormEvent, useState, useTransition } from 'react';
import { Link, useRouter } from '@/i18n/navigation';
import { deleteBookmarkAction, updateBookmarkAction } from '../listings/actions';
import { makeT } from '../listings/values';

/** A bookmark as the page formatted it: `facts` are ready-made cells; empty when unavailable. */
export interface BookmarkView {
  id: string;
  listingId: string;
  note: string | null;
  available: boolean;
  ref: string | null;
  own: boolean;
  facts: string[];
  saved: string;
}

/** One saved listing (S3-09): its facts or "no longer available", the note (edited in place) and remove. */
export function BookmarkItem({ bookmark, messages }: { bookmark: BookmarkView; messages: Record<string, unknown> }) {
  const t = makeT(messages);
  const router = useRouter();
  const [note, setNote] = useState(bookmark.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const fail = (code: string) => {
    const key = `bookmarks.errors.${code}`;
    const text = t(key);
    setError(text === key ? t('bookmarks.errors.generic') : text);
  };

  const saveNote = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await updateBookmarkAction(bookmark.id, { note: note.trim() || null });
      if (!res.ok) return fail(res.code);
      setNote(res.data.note ?? '');
    });
  };

  const remove = () => {
    setError(null);
    startTransition(async () => {
      const res = await deleteBookmarkAction(bookmark.id);
      if (!res.ok && res.code !== 'BOOKMARK_NOT_FOUND') return fail(res.code);
      router.refresh();
    });
  };

  return (
    <li className="flex flex-col gap-2 rounded-md border p-3" aria-busy={pending}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        {bookmark.available ? (
          <div className="flex flex-col">
            <Link href={`/listings/${bookmark.listingId}`} className="font-medium underline-offset-4 hover:underline">
              {bookmark.ref}
            </Link>
            <span className="text-sm text-muted-foreground">{bookmark.facts.join(' · ')}</span>
          </div>
        ) : (
          <div className="flex flex-col">
            <span className="font-medium text-muted-foreground">{t('bookmarks.unavailable')}</span>
            <span className="text-sm text-muted-foreground">{t('bookmarks.unavailableHint')}</span>
          </div>
        )}
        <div className="flex items-center gap-2">
          {bookmark.available ? (
            <span className="rounded bg-muted px-2 py-0.5 text-xs">
              {bookmark.own ? t('bookmarks.own') : t('bookmarks.network')}
            </span>
          ) : null}
          <span className="text-xs text-muted-foreground">{bookmark.saved}</span>
          <Button type="button" variant="ghost" size="sm" onClick={remove} disabled={pending}>
            {t('bookmarks.remove')}
          </Button>
        </div>
      </div>
      <form onSubmit={saveNote} className="flex gap-2">
        <Input
          value={note}
          maxLength={1000}
          aria-label={t('bookmarks.note')}
          placeholder={t('bookmarks.notePlaceholder')}
          onChange={(e) => setNote(e.target.value)}
        />
        <Button type="submit" variant="outline" size="sm" disabled={pending || note === (bookmark.note ?? '')}>
          {t('bookmarks.save')}
        </Button>
      </form>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </li>
  );
}
