'use client';

import { Button, Input, Label } from '@inmolink/ui';
import { useActionState } from 'react';
import type { FeedError, IssuedCalendarFeed } from './feed-state';

export interface CalendarFeedLabels {
  button: string;
  hint?: string;
  issuedTitle: string;
  issuedIntro: string;
  url: string;
  done: string;
  doneHref: string;
  errors: Record<FeedError, string>;
}

/**
 * Get or replace the member's ICS subscription URL (S10-06): the new URL is shown once, in a read-only field to copy,
 * in place of the button. Leaving the page drops it for good. Works without JavaScript (server action).
 */
export function CalendarFeedForm(props: {
  action: (prev: IssuedCalendarFeed, form: FormData) => Promise<IssuedCalendarFeed>;
  labels: CalendarFeedLabels;
}) {
  const [state, formAction, pending] = useActionState(props.action, {});
  const l = props.labels;
  if (state.url) {
    return (
      <div className="flex flex-col gap-3 rounded-md border p-3" role="status" data-testid="issued-calendar-feed">
        <h3 className="font-semibold">{l.issuedTitle}</h3>
        <p className="text-sm text-muted-foreground">{l.issuedIntro}</p>
        <div className="flex flex-col gap-1">
          <Label htmlFor="calendar-feed-url">{l.url}</Label>
          <Input id="calendar-feed-url" readOnly value={state.url} className="font-mono text-xs" />
        </div>
        <a href={l.doneHref} className="text-sm font-medium underline-offset-4 hover:underline">
          {l.done}
        </a>
      </div>
    );
  }
  return (
    <form action={formAction} className="flex flex-col gap-1">
      <Button type="submit" variant="outline" size="sm" disabled={pending} className="self-start">
        {l.button}
      </Button>
      {l.hint ? <p className="text-xs text-muted-foreground">{l.hint}</p> : null}
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {l.errors[state.error]}
        </p>
      ) : null}
    </form>
  );
}
