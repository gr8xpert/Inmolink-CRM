'use client';

import { useActionState } from 'react';
import { Link } from '@/i18n/navigation';
import { editEventAction } from './actions';
import { EventFields, type EventFieldsLabels } from './event-fields';
import type { EditEventState, EventFormValues } from './event-values';

/** Edits one event in place (S17-F42): a small client island; a refusal returns what was typed and keeps it. */
export function EventEditForm(props: {
  id: string;
  version: number;
  initial: EventFormValues;
  labels: EventFieldsLabels & { save: string; cancel: string };
  errors: Record<string, string>;
  hidden: { view: string; week: string; scope: string };
  closeHref: string;
}) {
  const [state, action, pending] = useActionState<EditEventState, FormData>(editEventAction, {});
  const values = state.values ?? props.initial;
  return (
    <form action={action} className="flex flex-wrap items-end gap-3 text-sm" data-testid="calendar-edit-form">
      <input type="hidden" name="id" value={props.id} />
      <input type="hidden" name="version" value={props.version} />
      <input type="hidden" name="view" value={props.hidden.view} />
      <input type="hidden" name="week" value={props.hidden.week} />
      <input type="hidden" name="scope" value={props.hidden.scope} />
      {state.error ? (
        <p role="alert" className="w-full text-sm text-destructive">
          {props.errors[state.error] ?? props.errors.generic}
        </p>
      ) : null}
      <EventFields labels={props.labels} values={values} />
      <button type="submit" disabled={pending} className="h-9 rounded-md border px-3 font-medium">
        {props.labels.save}
      </button>
      <Link href={props.closeHref} className="h-9 content-center text-sm underline-offset-4 hover:underline">
        {props.labels.cancel}
      </Link>
    </form>
  );
}
