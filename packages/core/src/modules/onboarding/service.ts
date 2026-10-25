/**
 * onboarding use cases (S13-04, PLAN §7 M21; PATTERNS §7). The checklist is a projection of the agency's real events
 * (`./subscriptions`): members read the steps of their role, staff read every step of an agency. Nothing here writes —
 * a step is never ticked by hand.
 */
import {
  type MemberRole,
  ONBOARDING_STEPS,
  type OnboardingChecklistDto,
  type OnboardingStep,
  type StaffOnboardingDto,
} from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import { AppError } from '@inmolink/platform/errors';
import type { Ctx, StaffCtx } from '../../context';
import * as agencies from '../agencies';
import { assertCan, assertStaffCan, stepsForRole } from './policy';
import * as repo from './repo';

type Progress = Omit<OnboardingChecklistDto, 'role'>;

async function checklist(tx: Tx, agencyId: string, steps: readonly OnboardingStep[]): Promise<Progress> {
  const done = new Map((await repo.listSteps(tx, agencyId)).map((r) => [r.step, r.completedAt]));
  const items = steps.map((step) => ({ step, completedAt: done.get(step)?.toISOString() ?? null }));
  return { steps: items, completed: items.filter((s) => s.completedAt).length, total: items.length };
}

/** `GET /v1/onboarding`: the caller's checklist — the steps of their role, done or to do. One query. */
export async function getChecklist(ctx: Ctx): Promise<OnboardingChecklistDto> {
  assertCan(ctx, 'onboarding.read');
  const role = (ctx.actor.kind === 'user' ? ctx.actor.role : '') as MemberRole;
  return { role, ...(await checklist(ctx.tx, ctx.tenant.agencyId, stepsForRole(role))) };
}

/**
 * `GET /v1/staff/agencies/:agencyId/onboarding` (staff console tenant page): every step of the agency; NOT_FOUND for an
 * agency that does not exist. Two queries.
 */
export async function getStaffOnboarding(ctx: StaffCtx, input: { agencyId: string }): Promise<StaffOnboardingDto> {
  assertStaffCan(ctx, 'staff.onboarding.read');
  if (!(await agencies.agencyNames(ctx, [input.agencyId])).has(input.agencyId)) {
    throw new AppError('NOT_FOUND', { entity: 'agency' });
  }
  return { agencyId: input.agencyId, ...(await checklist(ctx.tx, input.agencyId, ONBOARDING_STEPS)) };
}
