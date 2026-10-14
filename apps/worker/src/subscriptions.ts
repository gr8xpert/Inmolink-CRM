import * as agencies from '@inmolink/core/modules/agencies';
import * as billing from '@inmolink/core/modules/billing';
import * as compliance from '@inmolink/core/modules/compliance';
import * as dashboard from '@inmolink/core/modules/dashboard';
import * as identity from '@inmolink/core/modules/identity';
import * as migration from '@inmolink/core/modules/migration';
import * as taxonomy from '@inmolink/core/modules/taxonomy';

/**
 * Every core module, imported once by the worker. Importing a module loads its events.ts, so the
 * outbox dispatcher knows each event type; a type it does not know is retried, never marked processed.
 * A new module is added here, and to `registerSubscriptions` if it subscribes (checked by a test).
 */
export const MODULES = { identity, agencies, billing, compliance, dashboard, taxonomy, migration } as const;

/** Outbox subscriptions of every module. Called once at start-up. */
export function registerSubscriptions(): void {
  identity.registerIdentitySubscriptions();
  agencies.registerAgenciesSubscriptions();
  taxonomy.registerTaxonomySubscriptions();
}
