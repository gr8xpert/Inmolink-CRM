import { negotiateLocale, translator, type UiLocale } from '@inmolink/i18n';
import { headers } from 'next/headers';

/** UI locale from `Accept-Language` until locale-prefixed routing lands (S0-11). */
export async function requestLocale(): Promise<UiLocale> {
  return negotiateLocale((await headers()).get('accept-language'));
}

export async function authT() {
  return translator(await requestLocale(), 'auth');
}
