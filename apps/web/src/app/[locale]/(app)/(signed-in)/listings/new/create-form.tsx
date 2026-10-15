'use client';

import { Button, Label } from '@inmolink/ui';
import { useActionState, useEffect } from 'react';
import { type CreateState, createListingAction } from '../actions';
import type { Option, OptionGroup } from '../taxonomy';

interface Props {
  propertyTypes: OptionGroup[];
  locations: Option[];
  transactionTypes: Option[];
  /** Labels translated on the server (no catalogs in the client bundle). */
  labels: Record<'transactionType' | 'propertyTypeId' | 'locationId' | 'choose' | 'submit' | 'fieldInvalid', string>;
  errors: Record<string, string> & { generic: string };
  loginHref: string;
}

const SELECT = 'h-9 rounded-md border bg-background px-3 text-sm';

/** Progressive enhancement: a plain form posting to a server action, which opens the editor. */
export function CreateListingForm(props: Props) {
  const [state, formAction, pending] = useActionState<CreateState, FormData>(createListingAction, {});
  useEffect(() => {
    if (state.revoked) window.location.assign(props.loginHref);
  }, [state.revoked, props.loginHref]);
  const invalid = (f: string) => state.fields?.includes(f) ?? false;
  const l = props.labels;

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {state.code ? (
        <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">
          {props.errors[state.code] ?? props.errors.generic}
        </p>
      ) : null}
      <div className="flex flex-col gap-2">
        <Label htmlFor="transactionType">{l.transactionType}</Label>
        <select id="transactionType" name="transactionType" defaultValue="SALE" className={SELECT}>
          {props.transactionTypes.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="propertyTypeId">{l.propertyTypeId}</Label>
        <select
          id="propertyTypeId"
          name="propertyTypeId"
          defaultValue=""
          required
          aria-invalid={invalid('propertyTypeId')}
          aria-describedby={invalid('propertyTypeId') ? 'propertyTypeId-error' : undefined}
          className={SELECT}
        >
          <option value="">{l.choose}</option>
          {props.propertyTypes.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {invalid('propertyTypeId') ? (
          <p id="propertyTypeId-error" className="text-xs text-destructive">
            {l.fieldInvalid}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="locationId">{l.locationId}</Label>
        <select
          id="locationId"
          name="locationId"
          defaultValue=""
          required
          aria-invalid={invalid('locationId')}
          aria-describedby={invalid('locationId') ? 'locationId-error' : undefined}
          className={SELECT}
        >
          <option value="">{l.choose}</option>
          {props.locations.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        {invalid('locationId') ? (
          <p id="locationId-error" className="text-xs text-destructive">
            {l.fieldInvalid}
          </p>
        ) : null}
      </div>
      <Button type="submit" disabled={pending}>
        {l.submit}
      </Button>
    </form>
  );
}
