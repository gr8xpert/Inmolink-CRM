'use client';

import { Button, Input, Label } from '@inmolink/ui';
import { useActionState, useState } from 'react';
import type { ClientModeError, ClientModeFormState } from '@/app/[locale]/(app)/(signed-in)/client-mode/state';

type Action = (prev: ClientModeFormState, form: FormData) => Promise<ClientModeFormState>;

export interface ClientModeLabels {
  start: string;
  intro: string;
  pin: string;
  confirm: string;
  submit: string;
  cancel: string;
  banner: string;
  exitPin: string;
  exit: string;
  errors: Record<ClientModeError, string>;
}

const PIN_INPUT = {
  type: 'password',
  inputMode: 'numeric',
  autoComplete: 'off',
  pattern: '[0-9]*',
  maxLength: 12,
  required: true,
} as const;

function ErrorLine({ error, labels }: { error?: ClientModeError; labels: ClientModeLabels }) {
  return error ? (
    <p role="alert" className="text-sm text-destructive">
      {labels.errors[error]}
    </p>
  ) : null;
}

/**
 * "Show to a client" (S12-06): opens a small form for the PIN that will end Client Mode. Server action; the server
 * decides everything (the API strips what a client must not see) — nothing here hides data.
 */
export function ClientModeStart({ action, labels }: { action: Action; labels: ClientModeLabels }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(action, {});
  if (!open && !state.error) {
    return (
      <Button type="button" variant="outline" size="sm" className="w-full" onClick={() => setOpen(true)}>
        {labels.start}
      </Button>
    );
  }
  return (
    <form action={formAction} className="flex flex-col gap-2" data-testid="client-mode-start">
      <p className="text-xs text-muted-foreground">{labels.intro}</p>
      <div className="flex flex-col gap-1">
        <Label htmlFor="client-mode-pin">{labels.pin}</Label>
        <Input id="client-mode-pin" name="pin" {...PIN_INPUT} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="client-mode-confirm">{labels.confirm}</Label>
        <Input id="client-mode-confirm" name="confirm" {...PIN_INPUT} />
      </div>
      <ErrorLine error={state.error} labels={labels} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {labels.submit}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          {labels.cancel}
        </Button>
      </div>
    </form>
  );
}

/** The Client Mode banner (S12-06), with the PIN form that ends it. */
export function ClientModeBanner({ action, labels }: { action: Action; labels: ClientModeLabels }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <section
      aria-label={labels.banner}
      className="flex flex-wrap items-center gap-3 border-b border-amber-300 bg-amber-100 px-4 py-2 text-sm text-amber-950"
      data-testid="client-mode-banner"
    >
      <p className="font-medium">{labels.banner}</p>
      <form action={formAction} className="ml-auto flex flex-wrap items-center gap-2">
        <Label htmlFor="client-mode-exit-pin" className="sr-only">
          {labels.exitPin}
        </Label>
        <Input
          id="client-mode-exit-pin"
          name="pin"
          placeholder={labels.exitPin}
          className="h-8 w-28 bg-white"
          {...PIN_INPUT}
        />
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          {labels.exit}
        </Button>
        <ErrorLine error={state.error} labels={labels} />
      </form>
    </section>
  );
}
