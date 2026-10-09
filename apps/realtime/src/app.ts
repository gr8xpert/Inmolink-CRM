import { PACKAGE_NAME as CORE } from '@inmolink/core';

/** Socket.io server for chat and notifications. Transport only — business logic lives in @inmolink/core. */
export const APP_NAME = 'realtime';

export function describeApp(): string {
  return `${APP_NAME} skeleton on ${CORE} — server bootstrap arrives in S0-08`;
}
