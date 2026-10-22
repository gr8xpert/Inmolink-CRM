'use client';

import { Button, Input, Label } from '@inmolink/ui';
import { useActionState } from 'react';
import type { FeedError, IssuedFeedState } from './feed-state';

export interface IssuedFeedLabels {
  title: string;
  intro: string;
  kyero: string;
  generic: string;
  done: string;
  doneHref: string;
}

/**
 * Turn the XML feed on or rotate its token (S7-F8): the new URLs are shown once, in place of the button, in read-only
 * fields to copy. Leaving the page drops them for good. Works without JavaScript (server action).
 */
export function RotateFeedForm(props: {
  action: (prev: IssuedFeedState, form: FormData) => Promise<IssuedFeedState>;
  siteId: string;
  /** Made per render: a repeated submit of this form answers the same token (S7-07 `Idempotency-Key`). */
  idempotencyKey: string;
  label: string;
  hint?: string;
  issued: IssuedFeedLabels;
  errors: Record<FeedError, string>;
}) {
  const [state, formAction, pending] = useActionState(props.action, {});
  const l = props.issued;
  if (state.urls) {
    return (
      <div className="flex flex-col gap-3 rounded-md border p-3" role="status" data-testid="issued-feed-urls">
        <h3 className="font-semibold">{l.title}</h3>
        <p className="text-sm text-muted-foreground">{l.intro}</p>
        {(['kyero', 'generic'] as const).map((k) => (
          <div key={k} className="flex flex-col gap-1">
            <Label htmlFor={`feed-url-${k}`}>{l[k]}</Label>
            <Input id={`feed-url-${k}`} readOnly value={state.urls?.[k] ?? ''} className="font-mono text-xs" />
          </div>
        ))}
        <a href={l.doneHref} className="text-sm font-medium underline-offset-4 hover:underline">
          {l.done}
        </a>
      </div>
    );
  }
  return (
    <form action={formAction} className="flex flex-col gap-1">
      <input type="hidden" name="siteId" value={props.siteId} />
      <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
      <Button type="submit" variant="outline" size="sm" disabled={pending} className="self-start">
        {props.label}
      </Button>
      {props.hint ? <p className="text-xs text-muted-foreground">{props.hint}</p> : null}
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {props.errors[state.error]}
        </p>
      ) : null}
    </form>
  );
}
