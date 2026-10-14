'use client';

import { Button, Input, Label } from '@inmolink/ui';
import { useActionState } from 'react';
import type { TwoFactorFormState } from './actions';

interface Props {
  action: (prev: TwoFactorFormState, form: FormData) => Promise<TwoFactorFormState>;
  codeLabel: string;
  submitLabel: string;
  /** Messages for `TwoFactorFormState.error` codes, translated on the server. */
  errors: Record<NonNullable<TwoFactorFormState['error']>, string>;
  /** Ask for the account password instead of a code (enrolment's fresh-password step, S1-F8). */
  password?: boolean;
  /** Offer "remember this browser" (login challenge). */
  rememberLabel?: string;
  /** After recovery codes are shown: their title, intro, and the link to go on. */
  codes?: { title: string; intro: string; continueLabel: string; continueHref: string };
  /** Shown instead of the form once the action reports `done`. */
  doneMessage?: string;
  variant?: 'default' | 'destructive';
}

/** A one-field code form (TOTP or recovery code). Works without JS (server action). */
export function CodeForm(props: Props) {
  const [state, formAction, pending] = useActionState(props.action, {});
  if (state.done && props.doneMessage) {
    return (
      <p role="status" className="rounded-md bg-muted p-3 text-sm">
        {props.doneMessage}
      </p>
    );
  }
  if (state.recoveryCodes && props.codes) {
    return (
      <div className="flex flex-col gap-3" data-testid="recovery-codes">
        <h2 className="font-semibold">{props.codes.title}</h2>
        <p className="text-sm text-muted-foreground">{props.codes.intro}</p>
        <ul className="grid grid-cols-2 gap-2 rounded-md bg-muted p-3 font-mono text-sm">
          {state.recoveryCodes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <a href={props.codes.continueHref} className="text-sm font-medium underline-offset-4 hover:underline">
          {props.codes.continueLabel}
        </a>
      </div>
    );
  }
  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {state.error ? (
        <p
          role="alert"
          data-testid="form-error"
          className="rounded-md border border-destructive p-3 text-sm text-destructive"
        >
          {props.errors[state.error]}
        </p>
      ) : null}
      <div className="flex flex-col gap-2">
        <Label htmlFor={props.password ? 'password' : 'code'}>{props.codeLabel}</Label>
        {props.password ? (
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            maxLength={1024}
            aria-invalid={state.error === 'password' || state.error === 'input'}
          />
        ) : (
          <Input
            id="code"
            name="code"
            inputMode="text"
            autoComplete="one-time-code"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={32}
            aria-invalid={state.error === 'invalid' || state.error === 'input'}
          />
        )}
      </div>
      {props.rememberLabel ? (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="remember" />
          {props.rememberLabel}
        </label>
      ) : null}
      <Button type="submit" disabled={pending} variant={props.variant ?? 'default'}>
        {props.submitLabel}
      </Button>
    </form>
  );
}
