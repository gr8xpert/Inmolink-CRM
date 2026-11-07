import type { CreateTaskBody, TaskDto } from '@inmolink/contracts';
import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';
import * as crm from '../crm';
import * as repo from './deals-repo';
import { assertCan } from './policy';

/**
 * R2-04b, the deal room's tasks: a deal's to-dos are the agency's own CRM tasks linked to its copy of the deal (S10-05:
 * due date, assignee, the e-mail reminder) — not a second task system. They are private to the agency, like any task:
 * the other party never sees them. Listing is `GET /v1/crm/tasks?dealId=` (`tasks_deal_idx`); editing, completing and
 * deleting are the task routes'.
 *
 * `POST /v1/mls/deals/:id/tasks`: a task about a deal the caller's agency is party to (`mls.deals.read` to see the deal,
 * `crm.tasks.write` to write the task), on an open or a closed deal (an invoice to chase after completion). The task's
 * own subjects (contact, lead, listing) are checked by crm as for any task. `Idempotency-Key` as `POST /v1/crm/tasks`.
 */
export async function createDealTask(
  ctx: Ctx,
  dealId: string,
  input: CreateTaskBody,
  opts: { idempotencyKey?: string } = {},
): Promise<{ task: TaskDto; replayed: boolean }> {
  assertCan(ctx, 'mls.deals.read');
  const deal = await repo.dealOf(ctx.tx, ctx.tenant.agencyId, dealId);
  if (!deal) throw new AppError('DEAL_NOT_FOUND');
  return crm.createTask(ctx, input, { ...opts, dealId: deal.id });
}
