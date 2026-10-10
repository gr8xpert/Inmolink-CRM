import { PACKAGE_NAME as UI } from '@inmolink/ui';

/** Next.js public portal, selections, client portal and embeds. Thin UI — business logic lives in @inmolink/core behind the API. */
export const APP_NAME = 'public';

export function describeApp(): string {
  return `${APP_NAME} skeleton on ${UI} (Tailwind + shadcn base; i18n routing in S0-11)`;
}
