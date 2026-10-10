'use client';

import { Button, Input, Label } from '@inmolink/ui';
import { useActionState } from 'react';
import type { FormState } from './actions';

export interface FieldSpec {
  name: string;
  label: string;
  type?: 'text' | 'email' | 'password';
  autoComplete?: string;
  hint?: string;
}

interface Props {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  fields: FieldSpec[];
  /** Hidden inputs, e.g. the link token. */
  hidden?: Record<string, string>;
  submitLabel: string;
  /** Messages for `FormState.error` codes, translated on the server. */
  errors: Record<NonNullable<FormState['error']>, string>;
  /** Shown instead of the form once the action reports `done`. */
  doneMessage?: string;
  /** Short instruction above the fields. */
  intro?: string;
}

/** Progressive-enhancement form: works without JS (server action), shows server errors by code. */
export function AuthForm({ action, fields, hidden, submitLabel, errors, doneMessage, intro }: Props) {
  const [state, formAction, pending] = useActionState(action, {});
  if (state.done && doneMessage) {
    return (
      <p role="status" className="rounded-md bg-muted p-4 text-sm">
        {doneMessage}
      </p>
    );
  }
  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
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
        return (
          <div key={f.name} className="flex flex-col gap-2">
            <Label htmlFor={f.name}>{f.label}</Label>
            <Input
              id={f.name}
              name={f.name}
              type={f.type ?? 'text'}
              autoComplete={f.autoComplete}
              aria-invalid={invalid}
              aria-describedby={f.hint ? `${f.name}-hint` : undefined}
              required
            />
            {f.hint ? (
              <p id={`${f.name}-hint`} className="text-xs text-muted-foreground">
                {f.hint}
              </p>
            ) : null}
          </div>
        );
      })}
      <Button type="submit" disabled={pending}>
        {submitLabel}
      </Button>
    </form>
  );
}
