import { PACKAGE_NAME as CORE } from '@inmolink/core';

/** Fastify dashboard API. Transport only — business logic lives in @inmolink/core. */
export const APP_NAME = 'api';

export function describeApp(): string {
  return `${APP_NAME} skeleton on ${CORE} — server bootstrap arrives in S0-08`;
}
