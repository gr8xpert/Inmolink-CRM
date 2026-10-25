import * as agencies from '@inmolink/core/modules/agencies';
import * as billing from '@inmolink/core/modules/billing';
import * as chat from '@inmolink/core/modules/chat';
import * as compliance from '@inmolink/core/modules/compliance';
import * as complianceWorker from '@inmolink/core/modules/compliance/worker';
import * as crm from '@inmolink/core/modules/crm';
import * as dashboard from '@inmolink/core/modules/dashboard';
import * as developments from '@inmolink/core/modules/developments';
import * as exports from '@inmolink/core/modules/exports';
import * as exportsWorker from '@inmolink/core/modules/exports/worker';
import * as identity from '@inmolink/core/modules/identity';
import * as imports from '@inmolink/core/modules/imports';
import * as matching from '@inmolink/core/modules/matching';
import * as media from '@inmolink/core/modules/media';
import * as migration from '@inmolink/core/modules/migration';
import * as mls from '@inmolink/core/modules/mls';
import * as network from '@inmolink/core/modules/network';
import * as notifications from '@inmolink/core/modules/notifications';
import * as pluginUpdates from '@inmolink/core/modules/plugin-updates';
import * as properties from '@inmolink/core/modules/properties';
import * as quality from '@inmolink/core/modules/quality';
import * as search from '@inmolink/core/modules/search';
import * as taxonomy from '@inmolink/core/modules/taxonomy';
import * as websiteApi from '@inmolink/core/modules/website-api';
import * as websites from '@inmolink/core/modules/websites';

/**
 * Every core module, imported once by the worker. Importing a module loads its events.ts, so the
 * outbox dispatcher knows each event type; a type it does not know is retried, never marked processed.
 * A new module is added here, and to `registerSubscriptions` if it subscribes (checked by a test).
 */
export const MODULES = {
  identity,
  agencies,
  billing,
  compliance,
  dashboard,
  taxonomy,
  migration,
  properties,
  media,
  quality,
  developments,
  search,
  imports,
  websites,
  'website-api': websiteApi,
  'plugin-updates': pluginUpdates,
  exports,
  crm,
  mls,
  notifications,
  chat,
  network,
  matching,
} as const;

/** Outbox subscriptions of every module. Called once at start-up. */
export function registerSubscriptions(): void {
  identity.registerIdentitySubscriptions();
  agencies.registerAgenciesSubscriptions();
  taxonomy.registerTaxonomySubscriptions();
  media.registerMediaSubscriptions();
  properties.registerPropertiesSubscriptions();
  quality.registerQualitySubscriptions();
  developments.registerDevelopmentsSubscriptions();
  search.registerSearchSubscriptions();
  imports.registerImportsSubscriptions();
  // S10-01: a started contact import queues its run.
  crm.registerCrmSubscriptions();
  // S11-01: a contact merge moves the agency's client registrations.
  mls.registerMlsSubscriptions();
  websites.registerWebsitesSubscriptions();
  websiteApi.registerWebsiteApiSubscriptions();
  // S9-03: the portal feed generator's subscriptions live behind the worker-only entry.
  exportsWorker.registerExportsSubscriptions();
  // S10-08: a requested data export queues its run (worker-only entry).
  complianceWorker.registerComplianceWorkerSubscriptions();
  // S11-04: raised notifications are pushed live and queued for the e-mail digest.
  notifications.registerNotificationsSubscriptions();
  // S11-03: sent messages are delivered live and notified; viewing threads are seated.
  chat.registerChatSubscriptions();
  // S11-05: a network post notifies matching subscriptions; a buyer request is matched against listings.
  network.registerNetworkSubscriptions();
  // S5-06: listings whose read models changed are matched against the saved searches.
  matching.registerMatchingSubscriptions();
}
