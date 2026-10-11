'use client';

import { Button, Input, Label } from '@inmolink/ui';
import { useActionState, useEffect } from 'react';
import { type OnboardingState, saveDetailsAction } from './actions';

type TextField = 'name' | 'taxId' | 'addressLine' | 'city' | 'postalCode';

interface Props {
  version: number;
  values: Record<TextField, string> & { region: string; languages: string[] };
  /** Labels translated on the server (no catalogs in the client bundle). */
  labels: Record<TextField | 'region' | 'languages' | 'submit', string> & { taxIdHint: string };
  regions: { value: string; label: string }[];
  languages: { value: string; label: string }[];
  errors: Record<NonNullable<OnboardingState['error']>, string>;
  savedMessage: string;
  loginHref: string;
}

const TEXT_FIELDS: { name: TextField; autoComplete?: string }[] = [
  { name: 'name', autoComplete: 'organization' },
  { name: 'taxId' },
  { name: 'addressLine', autoComplete: 'street-address' },
  { name: 'city', autoComplete: 'address-level2' },
  { name: 'postalCode', autoComplete: 'postal-code' },
];

/** Company details (S1-01). Progressive enhancement: a plain form posting to a server action. */
export function OnboardingForm(props: Props) {
  const [state, formAction, pending] = useActionState(saveDetailsAction, { version: props.version });
  useEffect(() => {
    if (state.revoked) window.location.assign(props.loginHref);
  }, [state.revoked, props.loginHref]);
  const invalid = (name: string) => state.fields?.includes(name) ?? false;

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="version" value={props.version} />
      {state.error ? (
        <p
          role="alert"
          data-testid="form-error"
          className="rounded-md border border-destructive p-3 text-sm text-destructive"
        >
          {props.errors[state.error]}
        </p>
      ) : null}
      {state.done ? (
        <p role="status" data-testid="form-saved" className="rounded-md bg-muted p-3 text-sm">
          {props.savedMessage}
        </p>
      ) : null}
      {TEXT_FIELDS.map((f) => (
        <div key={f.name} className="flex flex-col gap-2">
          <Label htmlFor={f.name}>{props.labels[f.name]}</Label>
          <Input
            id={f.name}
            name={f.name}
            defaultValue={props.values[f.name]}
            autoComplete={f.autoComplete}
            aria-invalid={invalid(f.name)}
            aria-describedby={f.name === 'taxId' ? 'taxId-hint' : undefined}
            required
          />
          {f.name === 'taxId' ? (
            <p id="taxId-hint" className="text-xs text-muted-foreground">
              {props.labels.taxIdHint}
            </p>
          ) : null}
        </div>
      ))}
      <div className="flex flex-col gap-2">
        <Label htmlFor="region">{props.labels.region}</Label>
        <select
          id="region"
          name="region"
          defaultValue={props.values.region}
          aria-invalid={invalid('region')}
          required
          className="h-9 rounded-md border bg-background px-3 text-sm"
        >
          <option value="" disabled>
            —
          </option>
          {props.regions.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </div>
      <fieldset className="flex flex-col gap-2" aria-invalid={invalid('languages')}>
        <legend className="mb-2 text-sm font-medium">{props.labels.languages}</legend>
        <div className="grid grid-cols-2 gap-2">
          {props.languages.map((l) => (
            <label key={l.value} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="languages"
                value={l.value}
                defaultChecked={props.values.languages.includes(l.value)}
              />
              {l.label}
            </label>
          ))}
        </div>
      </fieldset>
      <Button type="submit" disabled={pending}>
        {props.labels.submit}
      </Button>
    </form>
  );
}
