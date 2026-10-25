/**
 * Tables owned by the onboarding module (PATTERNS §2). Only `packages/core/src/modules/onboarding` imports
 * this file (`pnpm check:boundaries`). Register each table in `../tenancy/registry.ts`, then run
 * `pnpm db:generate && pnpm db:migrate && pnpm db:rls`.
 *
 * S13-04 (PLAN §7 M21): the onboarding checklist's projection — one row per agency and completed step, written only by
 * the outbox subscribers (`withSystem`) from the real events of the step (listings imported, site created, invite
 * sent, listing shared, verification approved). Members read their agency's rows; staff read every agency's.
 */
import { pgEnum, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { agencies } from './agencies';

export const onboardingStepEnum = pgEnum('onboarding_step', [
  'VERIFY_AGENCY',
  'IMPORT_LISTINGS',
  'CONNECT_WEBSITE',
  'INVITE_TEAM',
  'SHARE_LISTING',
]);

/** A checklist step the agency completed: the first event that completed it wins (later ones change nothing). */
export const onboardingSteps = pgTable(
  'onboarding_steps',
  {
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    step: onboardingStepEnum('step').notNull(),
    /** When the completing event happened (its outbox `created_at`). */
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull(),
    /** The outbox event that completed it (support: "why is this ticked?"). */
    eventId: uuid('event_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.agencyId, t.step] })],
);
