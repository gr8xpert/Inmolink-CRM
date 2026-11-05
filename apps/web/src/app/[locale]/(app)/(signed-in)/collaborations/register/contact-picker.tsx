'use client';

import { useActionState } from 'react';
import { type FindResult, type FoundContact, findContactsFormAction } from '../../contacts/find-action';

export interface PickerLabels {
  find: string;
  findPlaceholder: string;
  findSubmit: string;
  none: string;
  invalid: string;
  error: string;
  noName: string;
  choose: string;
  found: string;
  recent: string;
  noRecent: string;
  recentFailed: string;
}

function Options(props: { title: string; formId: string; items: FoundContact[]; noName: string }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-muted-foreground">{props.title}</p>
      <ul className="divide-y rounded-md border">
        {props.items.map((c) => (
          <li key={c.id}>
            <label className="flex cursor-pointer items-start gap-2 p-3">
              <input type="radio" name="contactId" value={c.id} form={props.formId} required className="mt-1" />
              <span className="min-w-0 flex-1 break-words">
                <span className="font-medium">{c.name ?? props.noName}</span>
                {c.detail ? <span className="block text-xs text-muted-foreground">{c.detail}</span> : null}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The client of a registration (S17-F56): the member's newest contacts, and "find by e-mail or phone" for any other. The
 * find box is its own form to a server action (S11-F14: what was typed never reaches a URL); the radios belong to the
 * registration form by its id. The API offers no search by name, so this is an exact lookup, not a typeahead.
 */
export function ContactPicker(props: {
  formId: string;
  recent: FoundContact[];
  /** The contacts could not be loaded: not the same as having none. */
  recentFailed: boolean;
  labels: PickerLabels;
}) {
  const [state, action, pending] = useActionState<FindResult, FormData>(findContactsFormAction, {
    status: 'idle',
    items: [],
  });
  const l = props.labels;
  const found = new Set(state.items.map((c) => c.id));
  const recent = props.recent.filter((c) => !found.has(c.id));
  return (
    <div className="flex flex-col gap-3 text-sm">
      <form action={action} className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 basis-56 flex-col gap-1">
          <span>{l.find}</span>
          <input
            name="find"
            type="search"
            required
            maxLength={254}
            autoComplete="off"
            placeholder={l.findPlaceholder}
            className="h-9 w-full rounded-md border bg-background px-2"
          />
        </label>
        <button type="submit" disabled={pending} className="h-9 rounded-md border px-3 font-medium">
          {l.findSubmit}
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
      ) : state.status === 'none' ? (
        <p role="status" className="text-muted-foreground">
          {l.none}
        </p>
      ) : null}
      <fieldset className="flex min-w-0 flex-col gap-3">
        <legend className="mb-1 font-medium">{l.choose}</legend>
        {state.items.length > 0 ? (
          <Options title={l.found} formId={props.formId} items={state.items} noName={l.noName} />
        ) : null}
        {recent.length > 0 ? (
          <Options title={l.recent} formId={props.formId} items={recent} noName={l.noName} />
        ) : props.recentFailed ? (
          <p role="alert" className="text-destructive">
            {l.recentFailed}
          </p>
        ) : state.items.length === 0 ? (
          <p className="text-muted-foreground">{l.noRecent}</p>
        ) : null}
      </fieldset>
    </div>
  );
}
