import { PACKAGE_NAME as CORE } from '@inmolink/core';

/** BullMQ processors, one entry per pool. Transport only — business logic lives in @inmolink/core. */
export const APP_NAME = 'worker';

export function describeApp(): string {
  return `${APP_NAME} skeleton on ${CORE} — server bootstrap arrives in S0-08`;
}
