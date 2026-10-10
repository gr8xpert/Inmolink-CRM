import type { Messages } from '@inmolink/i18n';

// Type-checked message keys for `useTranslations` / `getTranslations`.
declare module 'next-intl' {
  interface AppConfig {
    Messages: Messages;
  }
}
