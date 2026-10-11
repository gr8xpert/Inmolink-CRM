import type auth from '../messages/en/auth.json';
import type onboarding from '../messages/en/onboarding.json';
import type security from '../messages/en/security.json';
import type staff from '../messages/en/staff.json';
import type team from '../messages/en/team.json';
import type verification from '../messages/en/verification.json';

/**
 * Shape of the UI messages, one namespace per file in `messages/en/` (EN is the source of truth).
 * Apps declare it as next-intl's `AppConfig['Messages']` so keys are type-checked. A new namespace
 * file is added here too.
 */
export interface Messages {
  auth: typeof auth;
  onboarding: typeof onboarding;
  security: typeof security;
  staff: typeof staff;
  team: typeof team;
  verification: typeof verification;
}

export type Namespace = keyof Messages;
