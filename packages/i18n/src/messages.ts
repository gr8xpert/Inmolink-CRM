import type agency from '../messages/en/agency.json';
import type apiKeys from '../messages/en/api-keys.json';
import type auth from '../messages/en/auth.json';
import type developments from '../messages/en/developments.json';
import type listings from '../messages/en/listings.json';
import type network from '../messages/en/network.json';
import type onboarding from '../messages/en/onboarding.json';
import type security from '../messages/en/security.json';
import type shell from '../messages/en/shell.json';
import type staff from '../messages/en/staff.json';
import type staffAccess from '../messages/en/staff-access.json';
import type team from '../messages/en/team.json';
import type verification from '../messages/en/verification.json';

/**
 * Shape of the UI messages, one namespace per file in `messages/en/` (EN is the source of truth).
 * Apps declare it as next-intl's `AppConfig['Messages']` so keys are type-checked. A new namespace
 * file is added here too.
 */
export interface Messages {
  agency: typeof agency;
  'api-keys': typeof apiKeys;
  auth: typeof auth;
  developments: typeof developments;
  listings: typeof listings;
  network: typeof network;
  onboarding: typeof onboarding;
  security: typeof security;
  shell: typeof shell;
  'staff-access': typeof staffAccess;
  staff: typeof staff;
  team: typeof team;
  verification: typeof verification;
}

export type Namespace = keyof Messages;
