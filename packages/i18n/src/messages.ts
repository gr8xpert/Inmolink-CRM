import type acquisition from '../messages/en/acquisition.json';
import type agency from '../messages/en/agency.json';
import type apiKeys from '../messages/en/api-keys.json';
import type auth from '../messages/en/auth.json';
import type billing from '../messages/en/billing.json'; // S13-01
import type calendar from '../messages/en/calendar.json';
import type chat from '../messages/en/chat.json';
import type contacts from '../messages/en/contacts.json';
import type dataExport from '../messages/en/data-export.json';
import type developments from '../messages/en/developments.json';
import type documents from '../messages/en/documents.json'; // S12-05
import type embed from '../messages/en/embed.json';
import type imports from '../messages/en/imports.json';
import type leads from '../messages/en/leads.json';
import type listings from '../messages/en/listings.json';
import type network from '../messages/en/network.json';
import type notifications from '../messages/en/notifications.json';
import type onboarding from '../messages/en/onboarding.json';
import type portals from '../messages/en/portals.json';
import type security from '../messages/en/security.json';
import type shell from '../messages/en/shell.json';
import type social from '../messages/en/social.json';
import type staff from '../messages/en/staff.json';
import type staffAccess from '../messages/en/staff-access.json';
import type tasks from '../messages/en/tasks.json';
import type team from '../messages/en/team.json';
import type verification from '../messages/en/verification.json';
import type websites from '../messages/en/websites.json';
import type widget from '../messages/en/widget.json';

/**
 * Shape of the UI messages, one namespace per file in `messages/en/` (EN is the source of truth).
 * Apps declare it as next-intl's `AppConfig['Messages']` so keys are type-checked. A new namespace
 * file is added here too.
 */
export interface Messages {
  acquisition: typeof acquisition;
  agency: typeof agency;
  'api-keys': typeof apiKeys;
  auth: typeof auth;
  billing: typeof billing; // S13-01
  calendar: typeof calendar;
  chat: typeof chat;
  contacts: typeof contacts;
  'data-export': typeof dataExport;
  developments: typeof developments;
  documents: typeof documents; // S12-05
  embed: typeof embed;
  imports: typeof imports;
  leads: typeof leads;
  listings: typeof listings;
  network: typeof network;
  notifications: typeof notifications;
  onboarding: typeof onboarding;
  portals: typeof portals;
  security: typeof security;
  shell: typeof shell;
  'staff-access': typeof staffAccess;
  staff: typeof staff;
  tasks: typeof tasks;
  team: typeof team;
  verification: typeof verification;
  social: typeof social;
  websites: typeof websites;
  widget: typeof widget;
}

export type Namespace = keyof Messages;
