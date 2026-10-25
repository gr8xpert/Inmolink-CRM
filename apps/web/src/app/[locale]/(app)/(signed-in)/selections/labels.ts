import { SELECTION_ERRORS } from './errors';
import type { ShareLabels } from './share-links';

/** The strings the client form island needs, resolved on the server (the dashboard ships no catalogs to the client). */
export function shareLabels(t: (key: string) => string): ShareLabels {
  return {
    title: t('share.title'),
    once: t('share.once'),
    link: t('share.link'),
    open: t('share.open'),
    whatsapp: t('share.whatsapp'),
    email: t('share.email'),
  };
}

export function errorLabels(t: (key: string) => string): Record<string, string> {
  return Object.fromEntries([...SELECTION_ERRORS, 'generic'].map((c) => [c, t(`errors.${c}`)]));
}
