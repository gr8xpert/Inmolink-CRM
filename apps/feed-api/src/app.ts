import { PACKAGE_NAME as CORE } from '@inmolink/core';

/** Fastify website API (v1 shim, v2, XML feeds) — read-only, isolated. Transport only — business logic lives in @inmolink/core. */
export const APP_NAME = 'feed-api';

export function describeApp(): string {
  return `${APP_NAME} skeleton on ${CORE} — server bootstrap arrives in S0-08`;
}
