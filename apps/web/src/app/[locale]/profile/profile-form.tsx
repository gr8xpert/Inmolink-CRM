'use client';

import { Button, Input, Label } from '@inmolink/ui';
import { useActionState, useEffect } from 'react';
import { type ProfileState, type ProfileValues, saveProfileAction } from './actions';

type TextField = 'primaryColor' | 'accentColor' | 'contactEmail' | 'contactPhone' | 'websiteUrl';

interface Props {
  version: number;
  values: ProfileValues;
  /** Locales with a text block, and their translated names. */
  locales: { value: string; label: string }[];
  /** Labels translated on the server (no catalogs in the client bundle). */
  labels: Record<TextField | 'texts' | 'submit', string> & {
    tagline: Record<string, string>;
    description: Record<string, string>;
  };
  errors: Record<NonNullable<ProfileState['error']>, string>;
  savedMessage: string;
  loginHref: string;
}

const TEXT_FIELDS: { name: TextField; type?: string; autoComplete?: string; placeholder?: string }[] = [
  { name: 'primaryColor', placeholder: '#0a7cff' },
  { name: 'accentColor', placeholder: '#ff8a00' },
  { name: 'contactEmail', type: 'email', autoComplete: 'email' },
  { name: 'contactPhone', type: 'tel', autoComplete: 'tel' },
  { name: 'websiteUrl', type: 'url', autoComplete: 'url', placeholder: 'https://' },
];

/** Agency profile (S1-06): colours, contact and per-language texts. Plain form posting to a server action. */
export function ProfileForm(props: Props) {
  const [state, formAction, pending] = useActionState(saveProfileAction, { version: props.version });
  useEffect(() => {
    if (state.revoked) window.location.assign(props.loginHref);
  }, [state.revoked, props.loginHref]);
  const invalid = (name: string) => state.fields?.includes(name) ?? false;
  const values = state.values ?? props.values;

  return (
    <form key={state.submission ?? 0} action={formAction} className="flex flex-col gap-4" noValidate>
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
            type={f.type ?? 'text'}
            defaultValue={values[f.name]}
            autoComplete={f.autoComplete}
            placeholder={f.placeholder}
            aria-invalid={invalid(f.name)}
          />
        </div>
      ))}
      <fieldset className="flex flex-col gap-3" aria-invalid={invalid('translations')}>
        <legend className="mb-2 text-sm font-medium">{props.labels.texts}</legend>
        {props.locales.map((l) => (
          <div key={l.value} className="flex flex-col gap-2 rounded-md border p-3">
            <input type="hidden" name="locales" value={l.value} />
            <Label htmlFor={`tagline.${l.value}`}>{props.labels.tagline[l.value]}</Label>
            <Input
              id={`tagline.${l.value}`}
              name={`tagline.${l.value}`}
              maxLength={160}
              defaultValue={values.texts[l.value]?.tagline ?? ''}
            />
            <Label htmlFor={`description.${l.value}`}>{props.labels.description[l.value]}</Label>
            <textarea
              id={`description.${l.value}`}
              name={`description.${l.value}`}
              maxLength={5000}
              rows={4}
              defaultValue={values.texts[l.value]?.description ?? ''}
              className="rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>
        ))}
      </fieldset>
      <Button type="submit" disabled={pending}>
        {props.labels.submit}
      </Button>
    </form>
  );
}
