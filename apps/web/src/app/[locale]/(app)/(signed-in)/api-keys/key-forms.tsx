'use client';

import { Button, Input, Label } from '@inmolink/ui';
import { useActionState } from 'react';
import type { IssuedKeyState, KeyError } from './actions';

type Action = (prev: IssuedKeyState, form: FormData) => Promise<IssuedKeyState>;

export interface IssuedKeyLabels {
  title: string;
  intro: string;
  done: string;
  doneHref: string;
}

/** The whole key, shown once after create or rotate. Leaving the page drops it for good. */
function IssuedKey({ state, labels }: { state: IssuedKeyState; labels: IssuedKeyLabels }) {
  return (
    <div className="flex flex-col gap-3 rounded-md border p-3" data-testid="issued-api-key" role="status">
      <h3 className="font-semibold">{labels.title}</h3>
      {state.name ? <p className="text-sm">{state.name}</p> : null}
      <p className="text-sm text-muted-foreground">{labels.intro}</p>
      <code className="break-all rounded-md bg-muted p-3 font-mono text-sm">{state.secret}</code>
      <a href={labels.doneHref} className="text-sm font-medium underline-offset-4 hover:underline">
        {labels.done}
      </a>
    </div>
  );
}

function ErrorLine({ error, errors }: { error?: KeyError; errors: Record<KeyError, string> }) {
  return error ? (
    <p role="alert" data-testid="form-error" className="text-sm text-destructive">
      {errors[error]}
    </p>
  ) : null;
}

export interface CreateKeyLabels {
  name: string;
  kind: string;
  kinds: Record<'SECRET' | 'PUBLISHABLE', string>;
  scopes: string;
  scopeNames: Record<string, string>;
  origins: string;
  originsHint: string;
  submit: string;
}

/** Create a key. Works without JavaScript (server action); the key is shown once in place of the form. */
export function CreateKeyForm(props: {
  action: Action;
  scopes: readonly string[];
  labels: CreateKeyLabels;
  issued: IssuedKeyLabels;
  errors: Record<KeyError, string>;
}) {
  const [state, formAction, pending] = useActionState(props.action, {});
  if (state.secret) return <IssuedKey state={state} labels={props.issued} />;
  const l = props.labels;
  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <ErrorLine error={state.error} errors={props.errors} />
      <div className="flex flex-col gap-2">
        <Label htmlFor="key-name">{l.name}</Label>
        <Input id="key-name" name="name" maxLength={80} required autoComplete="off" />
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">{l.kind}</legend>
        {(['SECRET', 'PUBLISHABLE'] as const).map((k) => (
          <label key={k} className="flex items-center gap-2 text-sm">
            <input type="radio" name="kind" value={k} defaultChecked={k === 'SECRET'} />
            {l.kinds[k]}
          </label>
        ))}
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">{l.scopes}</legend>
        {props.scopes.map((s) => (
          <label key={s} className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="scopes" value={s} defaultChecked={s === 'listings:read'} />
            {l.scopeNames[s] ?? s}
          </label>
        ))}
      </fieldset>
      <div className="flex flex-col gap-2">
        <Label htmlFor="key-origins">{l.origins}</Label>
        <textarea
          id="key-origins"
          name="allowedOrigins"
          rows={3}
          className="rounded-md border bg-background p-2 font-mono text-sm"
          placeholder="https://www.example.com"
          aria-describedby="key-origins-hint"
        />
        <p id="key-origins-hint" className="text-xs text-muted-foreground">
          {l.originsHint}
        </p>
      </div>
      <Button type="submit" disabled={pending}>
        {l.submit}
      </Button>
    </form>
  );
}

/** Rotate one key: the new key is shown once in place of the button. */
export function RotateKeyForm(props: {
  action: Action;
  keyId: string;
  label: string;
  issued: IssuedKeyLabels;
  errors: Record<KeyError, string>;
}) {
  const [state, formAction, pending] = useActionState(props.action, {});
  if (state.secret) return <IssuedKey state={state} labels={props.issued} />;
  return (
    <form action={formAction} className="flex flex-col gap-1">
      <input type="hidden" name="keyId" value={props.keyId} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {props.label}
      </Button>
      <ErrorLine error={state.error} errors={props.errors} />
    </form>
  );
}
