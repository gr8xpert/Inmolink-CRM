'use client';

import { Button, Input, Label } from '@inmolink/ui';
import { type ReactNode, useActionState, useEffect } from 'react';
import { type SettingsState, saveSettingsAction } from './actions';
import type { SettingsValues } from './values';

export interface SettingsLabels {
  commission: {
    title: string;
    type: string;
    types: Record<SettingsValues['commissionType'], string>;
    percent: string;
    amount: string;
    currency: string;
    currencyPlaceholder: string;
    includesVat: string;
  };
  registrationValidityDays: string;
  viewingResponseDays: string;
  enabledLocales: string;
  whiteLabel: { title: string; referencePrefix: string; showPoweredBy: string; emailSenderName: string };
  clientMode: { title: string; intro: string; pinMinLength: string; pinMaxAttempts: string };
  submit: string;
}

interface Props {
  version: number;
  values: SettingsValues;
  /** Labels translated on the server (no catalogs in the client bundle). */
  labels: SettingsLabels;
  locales: { value: string; label: string }[];
  errors: Record<NonNullable<SettingsState['error']>, string>;
  savedMessage: string;
  loginHref: string;
}

function Field(props: { id: string; label: string; invalid: boolean; children: (aria: object) => ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={props.id}>{props.label}</Label>
      {props.children({ id: props.id, name: props.id, 'aria-invalid': props.invalid })}
    </div>
  );
}

/** Agency settings (S1-06). Progressive enhancement: a plain form posting to a server action. */
export function SettingsForm(props: Props) {
  const [state, formAction, pending] = useActionState(saveSettingsAction, { version: props.version });
  useEffect(() => {
    if (state.revoked) window.location.assign(props.loginHref);
  }, [state.revoked, props.loginHref]);
  const invalid = (...paths: string[]) => paths.some((p) => state.fields?.some((f) => f.startsWith(p)) ?? false);
  const v = state.values ?? props.values;
  const l = props.labels;

  return (
    <form key={state.submission ?? 0} action={formAction} className="flex flex-col gap-6" noValidate>
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

      <fieldset className="flex flex-col gap-3 rounded-md border p-4">
        <legend className="px-1 text-sm font-medium">{l.commission.title}</legend>
        <Field id="commissionType" label={l.commission.type} invalid={invalid('defaultCommission')}>
          {(aria) => (
            <select
              {...aria}
              defaultValue={v.commissionType}
              className="h-9 rounded-md border bg-background px-3 text-sm"
            >
              {(['NONE', 'PCT', 'FIXED'] as const).map((t) => (
                <option key={t} value={t}>
                  {l.commission.types[t]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field id="commissionPercent" label={l.commission.percent} invalid={invalid('defaultCommission.basisPoints')}>
            {(aria) => <Input {...aria} inputMode="decimal" defaultValue={v.commissionPercent} />}
          </Field>
          <Field
            id="commissionAmount"
            label={l.commission.amount}
            invalid={invalid('defaultCommission.amount.amountCents')}
          >
            {(aria) => <Input {...aria} inputMode="decimal" defaultValue={v.commissionAmount} />}
          </Field>
          <Field
            id="commissionCurrency"
            label={l.commission.currency}
            invalid={invalid('defaultCommission.amount.currency')}
          >
            {(aria) => (
              <Input
                {...aria}
                maxLength={3}
                placeholder={l.commission.currencyPlaceholder}
                defaultValue={v.commissionCurrency}
              />
            )}
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="commissionIncludesVat" defaultChecked={v.commissionIncludesVat} />
          {l.commission.includesVat}
        </label>
      </fieldset>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          id="registrationValidityDays"
          label={l.registrationValidityDays}
          invalid={invalid('registrationValidityDays')}
        >
          {(aria) => <Input {...aria} type="number" min={1} max={1095} defaultValue={v.registrationValidityDays} />}
        </Field>
        <Field id="viewingResponseDays" label={l.viewingResponseDays} invalid={invalid('viewingResponseDays')}>
          {(aria) => <Input {...aria} type="number" min={1} max={30} defaultValue={v.viewingResponseDays} />}
        </Field>
      </div>

      <fieldset className="flex flex-col gap-2" aria-invalid={invalid('enabledLocales')}>
        <legend className="mb-2 text-sm font-medium">{l.enabledLocales}</legend>
        <div className="grid grid-cols-2 gap-2">
          {props.locales.map((loc) => (
            <label key={loc.value} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="enabledLocales"
                value={loc.value}
                defaultChecked={v.enabledLocales.includes(loc.value)}
              />
              {loc.label}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-3 rounded-md border p-4">
        <legend className="px-1 text-sm font-medium">{l.whiteLabel.title}</legend>
        <Field
          id="referencePrefix"
          label={l.whiteLabel.referencePrefix}
          invalid={invalid('whiteLabel.referencePrefix')}
        >
          {(aria) => <Input {...aria} maxLength={6} defaultValue={v.referencePrefix} />}
        </Field>
        <Field
          id="emailSenderName"
          label={l.whiteLabel.emailSenderName}
          invalid={invalid('whiteLabel.emailSenderName')}
        >
          {(aria) => <Input {...aria} maxLength={80} defaultValue={v.emailSenderName} />}
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="showPoweredBy" defaultChecked={v.showPoweredBy} />
          {l.whiteLabel.showPoweredBy}
        </label>
      </fieldset>

      <fieldset className="flex flex-col gap-3 rounded-md border p-4">
        <legend className="px-1 text-sm font-medium">{l.clientMode.title}</legend>
        <p className="text-xs text-muted-foreground">{l.clientMode.intro}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field id="pinMinLength" label={l.clientMode.pinMinLength} invalid={invalid('clientMode.pinMinLength')}>
            {(aria) => <Input {...aria} type="number" min={4} max={8} defaultValue={v.pinMinLength} />}
          </Field>
          <Field id="pinMaxAttempts" label={l.clientMode.pinMaxAttempts} invalid={invalid('clientMode.pinMaxAttempts')}>
            {(aria) => <Input {...aria} type="number" min={3} max={10} defaultValue={v.pinMaxAttempts} />}
          </Field>
        </div>
      </fieldset>

      <Button type="submit" disabled={pending}>
        {l.submit}
      </Button>
    </form>
  );
}
