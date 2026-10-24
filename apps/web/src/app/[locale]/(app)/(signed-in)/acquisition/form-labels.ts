import { getTranslations } from 'next-intl/server';
import type { ProspectFieldLabels } from './prospect-fields';

/** Error codes the acquisition pages explain (i18n keys under `acquisition.errors`); anything else is `generic`. */
const FORM_ERRORS = [
  'generic',
  'FORBIDDEN',
  'VERSION_CONFLICT',
  'VALIDATION_FAILED',
  'PROSPECT_NOT_FOUND',
  'PROSPECT_STAGE_INVALID',
  'PROSPECT_INCOMPLETE',
  'CONTACT_NOT_FOUND',
  'IDEMPOTENCY_KEY_REUSED',
  'RATE_LIMITED',
] as const;
export type FormErrorCode = (typeof FORM_ERRORS)[number];

export function formErrorCode(code: string | undefined): FormErrorCode | null {
  if (!code) return null;
  return (FORM_ERRORS as readonly string[]).includes(code) ? (code as FormErrorCode) : 'generic';
}

export async function fieldLabels(): Promise<ProspectFieldLabels> {
  const t = await getTranslations('acquisition.form');
  return {
    title: t('title'),
    seller: t('seller'),
    noSeller: t('noSeller'),
    sellerHint: t('sellerHint'),
    address: t('address'),
    area: t('area'),
    propertyType: t('propertyType'),
    location: t('location'),
    choose: t('choose'),
    price: t('price'),
    followUp: t('followUp'),
    notes: t('notes'),
    notesHint: t('notesHint'),
  };
}
