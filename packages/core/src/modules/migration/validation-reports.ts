/**
 * Staff use cases of the validation reports (S14-03, PLAN §7 M20 staff console, §14 step 6): `(ctx: StaffCtx, input) →
 * DTO`. Every active staff role reads; nothing is written here (the validation script records the reports). Reads run
 * as `app_staff` (registry `staffRead`).
 */
import type {
  MigrationValidationDto,
  MigrationValidationListQuery,
  MigrationValidationPage,
  MigrationValidationSummaryDto,
} from '@inmolink/contracts';
import { AppError } from '@inmolink/platform/errors';
import type { StaffCtx } from '../../context';
import { decodeCursor, toPage } from '../../pagination';
import { assertStaffCan } from './policy';
import * as vrepo from './validation-repo';

const rate = (n: number, of: number) => (of === 0 ? 0 : n / of);

function toSummary(r: vrepo.ReportSummaryRow): MigrationValidationSummaryDto {
  return {
    id: r.id,
    legacyAgencyId: r.legacyAgencyId,
    agencyId: r.targetAgencyId,
    status: r.status,
    legacyRows: r.legacyRows,
    unexplained: r.unexplained,
    rate: rate(r.unexplained, r.legacyRows),
    sampleDiffs: r.sampleDiffs,
    urlFailures: r.urlFailures,
    createdAt: r.createdAt.toISOString(),
  };
}

/** `GET /v1/staff/migration/validations`: each legacy agency's latest report, newest first (keyset). */
export async function listValidationReports(
  ctx: StaffCtx,
  q: MigrationValidationListQuery,
): Promise<MigrationValidationPage> {
  assertStaffCan(ctx, 'staff.migration.readValidation');
  const rows = await vrepo.listLatest(ctx.tx, { limit: q.limit, cursor: decodeCursor(q.cursor), status: q.status });
  return toPage(rows, q.limit, (r) => ({ at: r.createdAt, id: r.id }), toSummary);
}

/** `GET /v1/staff/migration/validations/:id`: the drill-down (counts, images, sampled diffs, URL checks). */
export async function getValidationReport(ctx: StaffCtx, id: string): Promise<MigrationValidationDto> {
  assertStaffCan(ctx, 'staff.migration.readValidation');
  const row = await vrepo.getReport(ctx.tx, id);
  if (!row) throw new AppError('NOT_FOUND', { id });
  return { ...toSummary(row), report: row.report };
}
