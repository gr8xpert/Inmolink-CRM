'use server';

import { UpdateAgencyDetailsBody } from '@inmolink/contracts';
import { auth } from '@/auth';
import { saveAgencyDetails, sessionRef } from '@/server/api';

/**
 * Onboarding form action (transport only): validate with the contract — so the CIF/NIF error can
 * say whether the format or the control character is wrong — then `PUT /v1/agency/details`. Error
 * values are i18n keys under `onboarding.errors`.
 */
export interface OnboardingState {
  error?: 'invalidInput' | 'taxIdFormat' | 'taxIdControl' | 'conflict' | 'forbidden' | 'generic';
  fields?: string[];
  done?: boolean;
  /** The saved version, so a second save in the same page does not conflict. */
  version?: number;
  /** `revoked`: the session ended (password reset); the page sends the user to log in. */
  revoked?: boolean;
  /**
   * What was submitted. React resets an action form after every submission (selects and checkboxes
   * to their initial defaults): the form remounts with these as defaults, so a refused save keeps
   * what the user typed.
   */
  values?: OnboardingValues;
  /** Counts submissions: the form remounts per submission, so every field starts from `values`. */
  submission?: number;
}

export interface OnboardingValues {
  name: string;
  taxId: string;
  addressLine: string;
  city: string;
  postalCode: string;
  region: string;
  languages: string[];
}

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v : undefined;
};

export async function saveDetailsAction(prev: OnboardingState, form: FormData): Promise<OnboardingState> {
  const session = await auth();
  if (!session?.user?.id) return { revoked: true };
  const values: OnboardingValues = {
    name: text(form, 'name') ?? '',
    taxId: text(form, 'taxId') ?? '',
    addressLine: text(form, 'addressLine') ?? '',
    city: text(form, 'city') ?? '',
    postalCode: text(form, 'postalCode') ?? '',
    region: text(form, 'region') ?? '',
    languages: form.getAll('languages').filter((v): v is string => typeof v === 'string'),
  };
  const version = prev.version ?? Number(text(form, 'version'));
  const result = await save({ ...prev, version }, values, session.user);
  return { ...result, values, submission: (prev.submission ?? 0) + 1 };
}

async function save(
  prev: OnboardingState,
  values: OnboardingValues,
  user: Parameters<typeof sessionRef>[0],
): Promise<OnboardingState> {
  const parsed = UpdateAgencyDetailsBody.safeParse({ version: prev.version, ...values });
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
    const taxIssue = parsed.error.issues.find((i) => i.path[0] === 'taxId');
    const reason = (taxIssue as { params?: { reason?: string } } | undefined)?.params?.reason;
    const error = reason === 'control' ? 'taxIdControl' : reason === 'format' ? 'taxIdFormat' : 'invalidInput';
    return { ...prev, error, fields, done: false };
  }
  const res = await saveAgencyDetails(sessionRef(user), parsed.data);
  if (res === 'revoked') return { revoked: true };
  if (res.ok) return { done: true, version: res.data.version };
  const code = res.error?.code;
  if (code === 'VERSION_CONFLICT') return { ...prev, error: 'conflict', done: false };
  if (code === 'FORBIDDEN') return { ...prev, error: 'forbidden', done: false };
  if (code === 'VALIDATION_FAILED') return { ...prev, error: 'invalidInput', done: false };
  return { ...prev, error: 'generic', done: false };
}
