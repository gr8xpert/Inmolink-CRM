'use server';

import { UpdateAgencySettingsBody } from '@inmolink/contracts';
import { auth } from '@/auth';
import { saveAgencySettings, sessionRef } from '@/server/api';
import { parseHundredths, type SettingsValues, settingsValues } from './values';

/**
 * Agency settings form action (S1-06, transport only): read the form, validate with the contract, then
 * `PUT /v1/agency/settings`. Error values are i18n keys under `agency.errors`.
 */
export interface SettingsState {
  error?: 'invalidInput' | 'conflict' | 'forbidden' | 'generic';
  fields?: string[];
  done?: boolean;
  /** The saved version, so a second save in the same page does not conflict. */
  version?: number;
  /**
   * What the form shows next: the saved settings, or what was submitted when the save was refused.
   * React resets an action form after every submission; the form remounts with these as defaults.
   */
  values?: SettingsValues;
  revoked?: boolean;
  submission?: number;
}

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

function valuesOf(form: FormData): SettingsValues {
  const commissionType = text(form, 'commissionType');
  return {
    commissionType: commissionType === 'FIXED' ? 'FIXED' : 'PCT',
    commissionPercent: text(form, 'commissionPercent'),
    commissionAmount: text(form, 'commissionAmount'),
    commissionCurrency: text(form, 'commissionCurrency').toUpperCase(),
    commissionIncludesVat: form.get('commissionIncludesVat') === 'on',
    splitPercent: text(form, 'splitPercent'),
    registrationValidityDays: text(form, 'registrationValidityDays'),
    viewingResponseDays: text(form, 'viewingResponseDays'),
    enabledLocales: form.getAll('enabledLocales').filter((v): v is string => typeof v === 'string'),
    referencePrefix: text(form, 'referencePrefix'),
    showPoweredBy: form.get('showPoweredBy') === 'on',
    emailSenderName: text(form, 'emailSenderName'),
    pinMinLength: text(form, 'pinMinLength'),
    pinMaxAttempts: text(form, 'pinMaxAttempts'),
  };
}

const hundredths = parseHundredths;

function bodyOf(version: number, v: SettingsValues): unknown {
  const commission =
    v.commissionType === 'PCT'
      ? { type: 'PCT', basisPoints: hundredths(v.commissionPercent), includesVat: v.commissionIncludesVat }
      : {
          type: 'FIXED',
          amount: { amountCents: hundredths(v.commissionAmount), currency: v.commissionCurrency },
          includesVat: v.commissionIncludesVat,
        };
  return {
    version,
    defaultCommission: commission,
    defaultSplitBp: hundredths(v.splitPercent),
    registrationValidityDays: Number(v.registrationValidityDays),
    viewingResponseDays: Number(v.viewingResponseDays),
    enabledLocales: v.enabledLocales,
    whiteLabel: {
      referencePrefix: v.referencePrefix || null,
      showPoweredBy: v.showPoweredBy,
      emailSenderName: v.emailSenderName || null,
    },
    clientMode: { pinMinLength: Number(v.pinMinLength), pinMaxAttempts: Number(v.pinMaxAttempts) },
  };
}

const ERRORS: Record<string, NonNullable<SettingsState['error']>> = {
  VERSION_CONFLICT: 'conflict',
  FORBIDDEN: 'forbidden',
  VALIDATION_FAILED: 'invalidInput',
};

export async function saveSettingsAction(prev: SettingsState, form: FormData): Promise<SettingsState> {
  const session = await auth();
  if (!session?.user?.id) return { revoked: true };
  const submission = (prev.submission ?? 0) + 1;
  const values = valuesOf(form);
  const version = prev.version ?? Number(text(form, 'version'));
  const parsed = UpdateAgencySettingsBody.safeParse(bodyOf(version, values));
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))];
    return { version, error: 'invalidInput', fields, values, submission };
  }
  const res = await saveAgencySettings(sessionRef(session.user), parsed.data);
  if (res === 'revoked') return { revoked: true };
  if (res.ok) return { done: true, version: res.data.version, values: settingsValues(res.data), submission };
  return { version, error: ERRORS[res.error?.code ?? ''] ?? 'generic', values, submission };
}
