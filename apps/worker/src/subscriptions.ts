import * as agencies from '@inmolink/core/modules/agencies';
import * as billing from '@inmolink/core/modules/billing';
import * as identity from '@inmolink/core/modules/identity';

/**
 * Every core module, imported once by the worker. Importing a module loads its events.ts, so the
 * outbox dispatcher knows each event type; a type it does not know is retried, never marked processed.
 * A new module is added here, and to `registerSubscriptions` if it subscribes (checked by a test).
 */
export const MODULES = { identity, agencies, billing } as const;

/** Outbox subscriptions of every module. Called once at start-up. */
export function registerSubscriptions(): void {
  identity.registerIdentitySubscriptions();
  agencies.registerAgenciesSubscriptions();
}
