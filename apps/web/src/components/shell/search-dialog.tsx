'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';

export interface SearchDialogLabels {
  open: string;
  title: string;
  input: string;
  comingSoon: string;
  close: string;
}

/** Typing in a field (or an editable element) must never open search. */
function isEditable(target: unknown): boolean {
  const el = target as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return el.isContentEditable === true || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

/** `/` outside a field, or Ctrl+K / Cmd+K anywhere. Exported for the unit test. */
export function isSearchShortcut(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: unknown;
}): boolean {
  if (e.altKey) return false;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') return true;
  return e.key === '/' && !e.ctrlKey && !e.metaKey && !isEditable(e.target);
}

/**
 * Global search entry point (S1-10): a button in the top bar and the `/` and Ctrl/Cmd+K shortcuts open
 * a modal dialog (native `<dialog>`: focus moves in, Escape closes, focus returns to where it was).
 * Search itself arrives with listings and contacts; until then the dialog says so.
 */
export function SearchDialog({ labels }: { labels: SearchDialogLabels }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const hintId = useId();
  const inputId = useId();

  const show = useCallback(() => {
    const el = dialog.current;
    if (!el || el.open) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
    el.showModal();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isSearchShortcut(e)) return;
      e.preventDefault();
      show();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [show]);

  const onClose = () => {
    setOpen(false);
    opener.current?.focus();
  };

  return (
    <>
      <button
        type="button"
        onClick={show}
        aria-keyshortcuts="/ Control+K Meta+K"
        className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <span>{labels.open}</span>
        <span aria-hidden="true" className="hidden sm:inline">
          <kbd className="rounded border px-1.5 text-xs">/</kbd>
        </span>
      </button>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        onClose={onClose}
        className="m-auto w-[min(36rem,calc(100vw-2rem))] rounded-lg border bg-background p-0 text-foreground shadow-xl backdrop:bg-black/40"
      >
        {open ? (
          <form method="dialog" className="flex flex-col gap-3 p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 id={titleId} className="text-base font-semibold">
                {labels.title}
              </h2>
              <button
                type="submit"
                className="rounded-md px-2 py-1 text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {labels.close}
              </button>
            </div>
            <label htmlFor={inputId} className="sr-only">
              {labels.input}
            </label>
            <input
              id={inputId}
              type="search"
              autoFocus
              placeholder={labels.input}
              aria-describedby={hintId}
              className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <p id={hintId} className="text-sm text-muted-foreground">
              {labels.comingSoon}
            </p>
          </form>
        ) : null}
      </dialog>
    </>
  );
}
