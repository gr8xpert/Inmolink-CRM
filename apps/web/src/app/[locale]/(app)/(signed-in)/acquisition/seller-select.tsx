'use client';

import { useState, useTransition } from 'react';
import { findContactsAction } from '../contacts/find-action';

export interface SellerSelectLabels {
  seller: string;
  noSeller: string;
  hint: string;
  find: string;
  findSubmit: string;
  findNone: string;
}

/**
 * The prospect form's seller picker (S11-F14), replacing the list of the 100 newest sellers: a find box (e-mail or
 * phone, sent by a server action, never in a URL) that adds the matches to the select. It sits inside the prospect
 * form without navigating, so a search never loses unsaved edits. The select posts `contactId` with the form.
 */
export function SellerSelect(props: {
  labels: SellerSelectLabels;
  current: { id: string; label: string } | null;
  inputClass: string;
}) {
  const l = props.labels;
  const [options, setOptions] = useState<Array<{ id: string; label: string }>>(props.current ? [props.current] : []);
  const [value, setValue] = useState(props.current?.id ?? '');
  const [query, setQuery] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const search = () =>
    start(async () => {
      const res = await findContactsAction(query);
      if (res.status !== 'found') {
        setNote(l.findNone);
        return;
      }
      setNote(null);
      setOptions((prev) => [
        ...prev,
        ...res.items
          .filter((c) => !prev.some((p) => p.id === c.id))
          .map((c) => ({ id: c.id, label: c.name ?? c.detail })),
      ]);
      setValue(res.items[0]?.id ?? '');
    });

  return (
    <div className="flex flex-col gap-1 text-sm">
      <label className="flex flex-col gap-1">
        <span>{l.find}</span>
        <span className="flex gap-2">
          <input
            type="search"
            value={query}
            maxLength={254}
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                search();
              }
            }}
            className={props.inputClass}
          />
          <button
            type="button"
            disabled={pending || !query.trim()}
            onClick={search}
            className="h-9 rounded-md border px-3 font-medium"
          >
            {l.findSubmit}
          </button>
        </span>
      </label>
      {note ? <p className="text-muted-foreground">{note}</p> : null}
      <label className="flex flex-col gap-1">
        <span>{l.seller}</span>
        <select
          name="contactId"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className={props.inputClass}
          aria-describedby="seller-hint"
        >
          <option value="">{l.noSeller}</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <span id="seller-hint" className="text-xs text-muted-foreground">
          {l.hint}
        </span>
      </label>
    </div>
  );
}
