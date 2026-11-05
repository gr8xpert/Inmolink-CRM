'use client';

import { Button, Input, Label } from '@inmolink/ui';
import { type FormEvent, useActionState, useState, useTransition } from 'react';
import type { FormState } from './actions';
import { Turnstile } from './turnstile';

export interface FieldSpec {
  name: string;
  label: string;
  type?: 'text' | 'email' | 'password' | 'radio';
  autoComplete?: string;
  hint?: string;
  /** `radio` only: the choices; the first is preselected. */
  options?: { value: string; label: string }[];
}

/** `fieldInvalid` has a `{field}` placeholder: the per-field message under each field the action marked invalid. */
export type FormErrorMessages = Record<NonNullable<FormState['error']>, string> & { fieldInvalid?: string };

interface Props {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  fields: FieldSpec[];
  /** Hidden inputs, e.g. the link token. */
  hidden?: Record<string, string>;
  submitLabel: string;
  /** Messages for `FormState.error` codes, translated on the server. */
  errors: FormErrorMessages;
  /** Shown instead of the form once the action reports `done`. */
  doneMessage?: string;
  /** Short instruction above the fields. */
  intro?: string;
  /** The Turnstile widget. Login shows it once the action asks (S1-F5); `always` shows it from the start (signup). */
  challenge?: { siteKey: string; action: string; always?: boolean };
}

/** Progressive-enhancement form: works without JS (server action), shows server errors by code. */
export function AuthForm({ action, fields, hidden, submitLabel, errors, doneMessage, intro, challenge }: Props) {
  const [state, formAction, pending] = useActionState(action, {});
  const [, startTransition] = useTransition();
  // React clears a form posted through its `action` prop, so an error would wipe what the user typed. With JavaScript
  // the form calls the action itself and keeps its values; without it, the `action` prop still posts.
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(() => formAction(data));
  };
  // Once challenged, keep the widget: past the ceiling every attempt needs a fresh token, even after a
  // wrong password (which the action reports without `challenge`).
  const [challenged, setChallenged] = useState(false);
  if (state.challenge && !challenged) setChallenged(true);
  const fieldMessage = (f: FieldSpec) => errors.fieldInvalid?.replace('{field}', f.label);
  const describedBy = (f: FieldSpec, invalid: boolean) => {
    const ids = [f.hint ? `${f.name}-hint` : null, invalid && fieldMessage(f) ? `${f.name}-error` : null].filter(
      Boolean,
    );
    return ids.length ? ids.join(' ') : undefined;
  };
  if (state.done && doneMessage) {
    return (
      <p role="status" className="rounded-md bg-muted p-4 text-sm">
        {doneMessage}
      </p>
    );
  }
  return (
    <form action={formAction} onSubmit={submit} className="flex flex-col gap-4" noValidate>
      {intro ? <p className="text-sm text-muted-foreground">{intro}</p> : null}
      {state.error ? (
        <p
          role="alert"
          data-testid="form-error"
          className="rounded-md border border-destructive p-3 text-sm text-destructive"
        >
          {errors[state.error]}
        </p>
      ) : null}
      {Object.entries(hidden ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {fields.map((f) => {
        const invalid = state.fields?.includes(f.name) ?? false;
        if (f.type === 'radio') {
          return (
            <fieldset
              key={f.name}
              className="flex flex-col gap-2"
              aria-invalid={invalid}
              aria-describedby={invalid && fieldMessage(f) ? `${f.name}-error` : undefined}
            >
              <legend className="mb-2 text-sm font-medium">{f.label}</legend>
              {(f.options ?? []).map((o, i) => (
                <label key={o.value} className="flex items-center gap-2 text-sm">
                  <input type="radio" name={f.name} value={o.value} defaultChecked={i === 0} />
                  {o.label}
                </label>
              ))}
              {invalid ? <FieldError id={`${f.name}-error`} text={fieldMessage(f)} /> : null}
            </fieldset>
          );
        }
        return (
          <div key={f.name} className="flex flex-col gap-2">
            <Label htmlFor={f.name}>{f.label}</Label>
            <Input
              id={f.name}
              name={f.name}
              type={f.type ?? 'text'}
              autoComplete={f.autoComplete}
              aria-invalid={invalid}
              aria-describedby={describedBy(f, invalid)}
              required
            />
            {invalid ? <FieldError id={`${f.name}-error`} text={fieldMessage(f)} /> : null}
            {f.hint ? (
              <p id={`${f.name}-hint`} className="text-xs text-muted-foreground">
                {f.hint}
              </p>
            ) : null}
          </div>
        );
      })}
      {challenge && (challenge.always || challenged) ? (
        <Turnstile siteKey={challenge.siteKey} action={challenge.action} resetKey={state} />
      ) : null}
      <Button type="submit" disabled={pending}>
        {submitLabel}
      </Button>
    </form>
  );
}

function FieldError({ id, text }: { id: string; text: string | undefined }) {
  if (!text) return null;
  return (
    <p id={id} data-testid="field-error" className="text-xs text-destructive">
      {text}
    </p>
  );
}
