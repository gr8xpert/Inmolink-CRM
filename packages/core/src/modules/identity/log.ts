import { createLogger, type Logger } from '@inmolink/platform/logger';

let logger: Logger | undefined;

/** Errors an auth flow must survive (a failed-attempt audit write, S1-08); created on first use. */
export function identityLog(): Logger {
  logger ??= createLogger({ service: 'identity' });
  return logger;
}
