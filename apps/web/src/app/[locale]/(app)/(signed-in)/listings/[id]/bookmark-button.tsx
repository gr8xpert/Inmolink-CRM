'use client';

import type { BookmarkFolderDto, ListingBookmarkDto } from '@inmolink/contracts';
import { Button, Input, Label } from '@inmolink/ui';
import { type FormEvent, useState, useTransition } from 'react';
import { Link } from '@/i18n/navigation';
import {
  createBookmarkAction,
  createFolderAction,
  deleteBookmarkAction,
  type EditorResult,
  listingBookmarksAction,
} from '../actions';
import { makeT } from '../values';

export interface BookmarkButtonProps {
  listingId: string;
  messages: Record<string, unknown>;
}

/**
 * Save the listing into the member's bookmark folders (S3-09): a panel that loads the folders on first open,
 * one checkbox per folder (checking saves with the note, unchecking removes) and a new-folder field.
 */
export function BookmarkButton({ listingId, messages }: BookmarkButtonProps) {
  const t = makeT(messages);
  const [open, setOpen] = useState(false);
  const [folders, setFolders] = useState<BookmarkFolderDto[] | null>(null);
  const [saved, setSaved] = useState<ListingBookmarkDto[]>([]);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const fail = (res: Extract<EditorResult<unknown>, { ok: false }>) => {
    const key = `bookmarks.errors.${res.code}`;
    const text = t(key);
    setError(text === key ? t('bookmarks.errors.generic') : text);
  };

  const toggleOpen = () => {
    const next = !open;
    setOpen(next);
    if (next && folders === null) {
      startTransition(async () => {
        const res = await listingBookmarksAction(listingId);
        if (!res.ok) return fail(res);
        setFolders(res.data.folders.items);
        setSaved(res.data.bookmarks.items);
      });
    }
  };

  const toggleFolder = (folder: BookmarkFolderDto) => {
    setError(null);
    const existing = saved.find((b) => b.folderId === folder.id);
    startTransition(async () => {
      if (existing) {
        const res = await deleteBookmarkAction(existing.id);
        if (!res.ok && res.code !== 'BOOKMARK_NOT_FOUND') return fail(res);
        setSaved((s) => s.filter((b) => b.id !== existing.id));
        return;
      }
      const res = await createBookmarkAction({ folderId: folder.id, listingId, note: note.trim() || null });
      if (!res.ok) return fail(res);
      setSaved((s) => [...s, { id: res.data.id, folderId: folder.id, note: res.data.note }]);
    });
  };

  const addFolder = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const name = String(new FormData(form).get('name') ?? '').trim();
    if (!name) return;
    setError(null);
    startTransition(async () => {
      const res = await createFolderAction({ name });
      if (!res.ok) return fail(res);
      setFolders((f) => [...(f ?? []), res.data].sort((a, b) => a.name.localeCompare(b.name)));
      form.reset();
    });
  };

  return (
    <div className="relative">
      <Button type="button" variant="outline" size="sm" aria-expanded={open} onClick={toggleOpen}>
        {saved.length > 0 ? t('bookmarks.saved', { count: String(saved.length) }) : t('bookmarks.button')}
      </Button>
      {open ? (
        <div className="absolute right-0 z-20 mt-2 flex w-80 flex-col gap-3 rounded-md border bg-background p-4 shadow-md">
          <div className="flex flex-col gap-1">
            <Label htmlFor="bookmark-note">{t('bookmarks.noteFor')}</Label>
            <Input
              id="bookmark-note"
              value={note}
              maxLength={1000}
              placeholder={t('bookmarks.notePlaceholder')}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <fieldset className="flex max-h-60 flex-col gap-1 overflow-y-auto" disabled={pending}>
            <legend className="mb-1 text-sm font-medium">{t('bookmarks.saveIn')}</legend>
            {folders === null ? (
              <div className="h-8 animate-pulse rounded bg-muted" />
            ) : folders.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('bookmarks.noFolders')}</p>
            ) : (
              folders.map((f) => (
                <label key={f.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={saved.some((b) => b.folderId === f.id)}
                    onChange={() => toggleFolder(f)}
                  />
                  {f.name}
                </label>
              ))
            )}
          </fieldset>
          <form onSubmit={addFolder} className="flex gap-2">
            <Input
              name="name"
              maxLength={60}
              aria-label={t('bookmarks.folderName')}
              placeholder={t('bookmarks.newFolder')}
            />
            <Button type="submit" size="sm" disabled={pending}>
              {t('bookmarks.create')}
            </Button>
          </form>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Link href="/bookmarks" className="text-sm underline-offset-4 hover:underline">
            {t('bookmarks.manage')}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
