import type auth from '../messages/en/auth.json';
import type onboarding from '../messages/en/onboarding.json';

/**
 * Shape of the UI messages, one namespace per file in `messages/en/` (EN is the source of truth).
 * Apps declare it as next-intl's `AppConfig['Messages']` so keys are type-checked. A new namespace
 * file is added here too.
 */
export interface Messages {
  auth: typeof auth;
  onboarding: typeof onboarding;
}

export type Namespace = keyof Messages;
