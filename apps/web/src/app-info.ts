import { PACKAGE_NAME as UI } from '@inmolink/ui';

/** Next.js dashboard (agency, agent, developer, staff console). Thin UI — business logic lives in @inmolink/core behind the API. */
export const APP_NAME = 'web';

export function describeApp(): string {
  return `${APP_NAME} skeleton on ${UI} — layout arrives in S0-08`;
}
