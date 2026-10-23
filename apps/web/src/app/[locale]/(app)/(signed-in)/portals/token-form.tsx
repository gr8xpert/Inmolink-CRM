'use client';

import { Button, Input, Label } from '@inmolink/ui';
import { type ReactNode, useActionState } from 'react';
import type { IssuedTokenState, PortalError } from './portal-state';

export interface IssuedTokenLabels {
  title: string;
  intro: string;
  token: string;
  done: string;
}

/**
 * A form whose answer is a new feed token (create a connection, rotate a token): the token is shown once, in a
 * read-only field to copy, in place of the form. Leaving the page drops it for good. Works without JavaScript
 * (server action). `children` are the form's fields (rendered on the server).
 */
export function IssueTokenForm(props: {
  action: (prev: IssuedTokenState, form: FormData) => Promise<IssuedTokenState>;
  /** The connections page (locale-prefixed path): the "done" link goes to `<doneBase>/<connection id>`. */
  doneBase: string;
  submit: string;
  issued: IssuedTokenLabels;
  errors: Record<PortalError, string>;
  children?: ReactNode;
}) {
  const [state, formAction, pending] = useActionState(props.action, {});
  if (state.token) {
    return (
      <div className="flex flex-col gap-3 rounded-md border p-3" role="status" data-testid="issued-portal-token">
        <h3 className="font-semibold">{props.issued.title}</h3>
        <p className="text-sm text-muted-foreground">{props.issued.intro}</p>
        <div className="flex flex-col gap-1">
          <Label htmlFor="portal-token">{props.issued.token}</Label>
          <Input id="portal-token" readOnly value={state.token} className="font-mono text-xs" />
        </div>
        <a
          href={`${props.doneBase}/${state.connectionId}`}
          className="text-sm font-medium underline-offset-4 hover:underline"
        >
          {props.issued.done}
        </a>
      </div>
    );
  }
  return (
    <form action={formAction} className="flex flex-col gap-3">
      {props.children}
      <Button type="submit" variant="outline" size="sm" disabled={pending} className="self-start">
        {props.submit}
      </Button>
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {props.errors[state.error]}
        </p>
      ) : null}
    </form>
  );
}
