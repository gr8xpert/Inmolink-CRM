'use client';

import { useActionState } from 'react';
import { Link } from '@/i18n/navigation';
import { mergeContactAction } from './actions';
import { type FindResult, findContactsFormAction } from './find-action';

export interface FinderLabels {
  title: string;
  input: string;
  submit: string;
  none: string;
  invalid: string;
  error: string;
  noName: string;
  /** The merge button (merge mode). */
  merge: string;
}

/**
 * The find-by-e-mail-or-phone box as a small client island (S11-F14): the form posts to a server action
 * (`useActionState`), so what was typed never appears in a URL. `link` mode lists matches as links to the contact;
 * `merge` mode offers to merge each match (not the contact itself) into contact `id` at `version`.
 */
export function ContactFinder(props: {
  labels: FinderLabels;
  mode: { kind: 'link' } | { kind: 'merge'; id: string; version: number };
}) {
  const [state, action, pending] = useActionState<FindResult, FormData>(findContactsFormAction, {
    status: 'idle',
    items: [],
  });
  const l = props.labels;
  const { mode } = props;
  const items = state.items.filter((c) => mode.kind !== 'merge' || c.id !== mode.id);
  return (
    <div className="flex flex-col gap-2 text-sm">
      <form action={action} className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-60 flex-1 flex-col gap-1">
          <span>{l.title}</span>
          <input
            name="find"
            type="search"
            required
            maxLength={254}
            autoComplete="off"
            placeholder={l.input}
            className="h-9 rounded-md border bg-background px-2"
          />
        </label>
        <button type="submit" disabled={pending} className="h-9 rounded-md border px-3 font-medium">
          {l.submit}
        </button>
      </form>
      {state.status === 'invalid' ? (
        <p role="alert" className="text-destructive">
          {l.invalid}
        </p>
      ) : state.status === 'error' ? (
        <p role="alert" className="text-destructive">
          {l.error}
        </p>
      ) : state.status === 'none' || (state.status === 'found' && items.length === 0) ? (
        <p className="text-muted-foreground">{l.none}</p>
      ) : null}
      {items.length > 0 ? (
        <ul className="divide-y rounded-md border" data-testid="found-contacts">
          {items.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 p-3">
              <span className="min-w-48 flex-1">
                {mode.kind === 'link' ? (
                  <Link href={`/contacts/${c.id}`} className="font-medium underline-offset-4 hover:underline">
                    {c.name ?? l.noName}
                  </Link>
                ) : (
                  (c.name ?? l.noName)
                )}
                <span className="block text-xs text-muted-foreground">{c.detail}</span>
              </span>
              {mode.kind === 'merge' ? (
                <form action={mergeContactAction}>
                  <input type="hidden" name="id" value={mode.id} />
                  <input type="hidden" name="duplicateId" value={c.id} />
                  <input type="hidden" name="version" value={mode.version} />
                  <button type="submit" className="h-8 rounded-md border px-3">
                    {l.merge}
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
