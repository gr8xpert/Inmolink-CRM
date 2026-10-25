/**
 * onboarding queries (PATTERNS §5). Takes `tx`, selects only the columns it needs.
 * Queries only `@inmolink/db/schema/onboarding` — other modules' tables fail `pnpm check:boundaries`.
 */
import type { OnboardingStep } from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import { onboardingSteps } from '@inmolink/db/schema/onboarding';
import { eq, sql } from 'drizzle-orm';

/** The agency's completed steps (≤ 5 rows, primary key `(agency_id, step)`). */
export function listSteps(tx: Tx, agencyId: string): Promise<{ step: OnboardingStep; completedAt: Date }[]> {
  return tx
    .select({ step: onboardingSteps.step, completedAt: onboardingSteps.completedAt })
    .from(onboardingSteps)
    .where(eq(onboardingSteps.agencyId, agencyId));
}

/**
 * Marks a step done. The earliest event wins: a later (or redelivered) event changes nothing, an older one delivered
 * late (out of order) moves `completed_at` and `event_id` back to it. One statement either way.
 */
export async function completeStep(
  tx: Tx,
  row: { agencyId: string; step: OnboardingStep; completedAt: Date; eventId: string },
): Promise<void> {
  await tx
    .insert(onboardingSteps)
    .values(row)
    .onConflictDoUpdate({
      target: [onboardingSteps.agencyId, onboardingSteps.step],
      set: { completedAt: sql`excluded.completed_at`, eventId: sql`excluded.event_id` },
      setWhere: sql`excluded.completed_at < ${onboardingSteps.completedAt}`,
    });
}

/**
 * Backfill upsert (S13-F26): the same earliest-wins rule as `completeStep`, many rows in one statement. Returns how
 * many rows it inserted or moved earlier: 0 on a rerun (the `setWhere` skips an unchanged or later time).
 */
export async function completeSteps(
  tx: Tx,
  rows: { agencyId: string; step: OnboardingStep; completedAt: Date; eventId: string }[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const changed = await tx
    .insert(onboardingSteps)
    .values(rows)
    .onConflictDoUpdate({
      target: [onboardingSteps.agencyId, onboardingSteps.step],
      set: { completedAt: sql`excluded.completed_at`, eventId: sql`excluded.event_id` },
      setWhere: sql`excluded.completed_at < ${onboardingSteps.completedAt}`,
    })
    .returning({ agencyId: onboardingSteps.agencyId });
  return changed.length;
}
