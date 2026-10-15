/**
 * Saved listing views (S3-07, PATTERNS §7): a member's named filters, sort and columns for the listing list.
 * Private to the member (other members of the agency never see them); at most `LISTING_VIEWS_MAX` each.
 */
import {
  LISTING_VIEWS_MAX,
  type ListingColumn,
  type ListingViewBody,
  type ListingViewDto,
  type ListingViewList,
  ListingViewQuery,
} from '@inmolink/contracts';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import type { Ctx } from '../../context';
import { assertCan } from './policy';
import * as repo from './repo';
import { actorId } from './service';

function toDto(row: repo.ViewRow): ListingViewDto {
  // Written through the contract; a view whose query no longer parses (a filter was dropped) keeps its name.
  const query = ListingViewQuery.safeParse(row.query);
  return {
    id: row.id,
    name: row.name,
    query: query.success ? query.data : {},
    columns: row.columns as ListingColumn[],
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Saving a view is a write: never in Client Mode (PATTERNS §6), even though reading the list is allowed. */
function assertCanSave(ctx: Ctx): void {
  assertCan(ctx, 'listing.read');
  if (ctx.clientMode) throw new AppError('FORBIDDEN');
}

/** A second view with the same name is LISTING_VIEW_NAME_TAKEN, not a 500. */
async function withNameCheck<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const cause = (err as { cause?: { code?: string; constraint?: string } }).cause;
    if (cause?.code === '23505' && cause.constraint === 'listing_views_member_name_uq') {
      throw new AppError('LISTING_VIEW_NAME_TAKEN');
    }
    throw err;
  }
}

/** `GET /v1/listing-views`: the caller's views by name. */
export async function listListingViews(ctx: Ctx): Promise<ListingViewList> {
  assertCan(ctx, 'listing.read');
  const rows = await repo.listViews(ctx.tx, ctx.tenant.agencyId, actorId(ctx), LISTING_VIEWS_MAX);
  return { items: rows.map(toDto) };
}

/** `POST /v1/listing-views`. */
export async function createListingView(ctx: Ctx, body: ListingViewBody): Promise<ListingViewDto> {
  assertCanSave(ctx);
  const row = await withNameCheck(() =>
    repo.insertView(
      ctx.tx,
      { id: newId(), agencyId: ctx.tenant.agencyId, userId: actorId(ctx), ...body, columns: [...body.columns] },
      LISTING_VIEWS_MAX,
    ),
  );
  if (!row) throw new AppError('LISTING_VIEW_LIMIT', { max: LISTING_VIEWS_MAX });
  return toDto(row);
}

/** `PUT /v1/listing-views/:id`: replaces name, query and columns of one of the caller's views. */
export async function updateListingView(ctx: Ctx, id: string, body: ListingViewBody): Promise<ListingViewDto> {
  assertCanSave(ctx);
  const row = await withNameCheck(() =>
    repo.updateView(
      ctx.tx,
      { id, agencyId: ctx.tenant.agencyId, userId: actorId(ctx) },
      { ...body, columns: [...body.columns] },
    ),
  );
  if (!row) throw new AppError('LISTING_VIEW_NOT_FOUND');
  return toDto(row);
}

/** `DELETE /v1/listing-views/:id`. */
export async function deleteListingView(ctx: Ctx, id: string): Promise<void> {
  assertCanSave(ctx);
  const deleted = await repo.deleteView(ctx.tx, { id, agencyId: ctx.tenant.agencyId, userId: actorId(ctx) });
  if (!deleted) throw new AppError('LISTING_VIEW_NOT_FOUND');
}
