'use client';

import type { BookmarkFolderDto } from '@inmolink/contracts';
import { Button, Input } from '@inmolink/ui';
import { type FormEvent, useState, useTransition } from 'react';
import { useRouter } from '@/i18n/navigation';
import { createFolderAction, deleteFolderAction, renameFolderAction } from '../listings/actions';
import { makeT } from '../listings/values';

/** New folder, and rename or delete the open one (S3-09); the server page re-renders after each change. */
export function FolderControls(props: { current: BookmarkFolderDto | null; messages: Record<string, unknown> }) {
  const t = makeT(props.messages);
  const router = useRouter();
  const { current } = props;
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const fail = (code: string) => {
    const key = `bookmarks.errors.${code}`;
    const text = t(key);
    setError(text === key ? t('bookmarks.errors.generic') : text);
  };
  const nameOf = (form: HTMLFormElement) => String(new FormData(form).get('name') ?? '').trim();

  const create = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const name = nameOf(form);
    if (!name) return;
    setError(null);
    startTransition(async () => {
      const res = await createFolderAction({ name });
      if (!res.ok) return fail(res.code);
      form.reset();
      router.push(`/bookmarks?folder=${res.data.id}`);
    });
  };

  const rename = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!current) return;
    const name = nameOf(e.currentTarget);
    if (!name) return;
    setError(null);
    startTransition(async () => {
      const res = await renameFolderAction(current.id, { name });
      if (!res.ok) return fail(res.code);
      setRenaming(false);
      router.refresh();
    });
  };

  const remove = () => {
    if (!current || !window.confirm(t('bookmarks.deleteFolderConfirm', { count: String(current.count) }))) return;
    setError(null);
    startTransition(async () => {
      const res = await deleteFolderAction(current.id);
      if (!res.ok && res.code !== 'BOOKMARK_FOLDER_NOT_FOUND') return fail(res.code);
      router.push('/bookmarks');
    });
  };

  return (
    <div className="flex flex-col gap-3 border-t pt-3">
      <form onSubmit={create} className="flex gap-2">
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
      {current ? (
        renaming ? (
          <form onSubmit={rename} className="flex gap-2">
            <Input name="name" maxLength={60} defaultValue={current.name} aria-label={t('bookmarks.folderName')} />
            <Button type="submit" size="sm" disabled={pending}>
              {t('bookmarks.save')}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setRenaming(false)}>
              {t('bookmarks.cancel')}
            </Button>
          </form>
        ) : (
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setRenaming(true)} disabled={pending}>
              {t('bookmarks.rename')}
            </Button>
            <Button type="button" variant="destructive" size="sm" onClick={remove} disabled={pending}>
              {t('bookmarks.deleteFolder')}
            </Button>
          </div>
        )
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
