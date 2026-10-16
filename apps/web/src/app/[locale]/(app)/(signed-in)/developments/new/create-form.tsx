'use client';

import { Button, Input, Label } from '@inmolink/ui';
import { useActionState, useEffect } from 'react';
import type { Option } from '../../listings/taxonomy';
import { type CreateState, createDevelopmentAction } from '../actions';

interface Props {
  locations: Option[];
  statuses: Option[];
  /** Labels translated on the server (no catalogs in the client bundle). */
  labels: Record<'ref' | 'name' | 'status' | 'locationId' | 'choose' | 'submit' | 'fieldInvalid', string>;
  errors: Record<string, string> & { generic: string };
  loginHref: string;
}

const SELECT = 'h-9 rounded-md border bg-background px-3 text-sm';

/** Progressive enhancement: a plain form posting to a server action, which opens the development page. */
export function CreateDevelopmentForm(props: Props) {
  const [state, formAction, pending] = useActionState<CreateState, FormData>(createDevelopmentAction, {});
  useEffect(() => {
    if (state.revoked) window.location.assign(props.loginHref);
  }, [state.revoked, props.loginHref]);
  const l = props.labels;
  const fieldProps = (name: string) => {
    const bad = (state.fields?.includes(name) ?? false) || (name === 'ref' && state.code === 'DEVELOPMENT_REF_TAKEN');
    return { id: name, name, 'aria-invalid': bad, 'aria-describedby': bad ? `${name}-error` : undefined };
  };
  const error = (name: string) =>
    state.fields?.includes(name) ? (
      <p id={`${name}-error`} className="text-xs text-destructive">
        {l.fieldInvalid}
      </p>
    ) : null;

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {state.code ? (
        <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">
          {props.errors[state.code] ?? props.errors.generic}
        </p>
      ) : null}
      <div className="flex flex-col gap-2">
        <Label htmlFor="ref">{l.ref}</Label>
        <Input {...fieldProps('ref')} required maxLength={40} />
        {error('ref')}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="name">{l.name}</Label>
        <Input {...fieldProps('name')} required maxLength={160} />
        {error('name')}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="status">{l.status}</Label>
        <select {...fieldProps('status')} defaultValue="OFF_PLAN" className={SELECT}>
          {props.statuses.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="locationId">{l.locationId}</Label>
        <select {...fieldProps('locationId')} defaultValue="" required className={SELECT}>
          <option value="">{l.choose}</option>
          {props.locations.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        {error('locationId')}
      </div>
      <Button type="submit" disabled={pending}>
        {l.submit}
      </Button>
    </form>
  );
}
