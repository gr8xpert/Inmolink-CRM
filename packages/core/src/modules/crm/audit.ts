import type { Ctx } from '../../context';
import * as compliance from '../compliance';

/**
 * crm's audit trail (S11-F2, PLAN §12). crm writes its rows through `compliance.audit` in the transaction of the
 * change, like every module: compliance's public API (`index.ts`) does not reach crm — only its worker entry does
 * (the data export run) — so there is no import cycle.
 *
 * - Credentials and bulk changes: the ICS feed URL (issued / rotated / revoked), contact merges and bulk imports —
 *   always, with the acting user (and the impersonating staff member, when there is one).
 * - Reads under impersonation: the API's `staff.impersonation.request` log line traces every impersonated request,
 *   but logs are not the audit log (retention, tenant visibility). Each list / get of client data made by staff
 *   impersonating a member also writes one `crm.clientData.read` row: ids, the resource, the page size and the list's
 *   filter enums (`assigned`: me / unassigned / a member id; `stage`) only. Covered: contacts (list, get, lookup,
 *   notes), contact imports, leads (list, get, stage history), the pipeline (board, stage column), activities, the
 *   calendar (list, get), prospects (list, follow-ups, board, stage column, get) and tasks (list, get). Not covered:
 *   lead introductions (other agencies' leads about the caller's listings — who introduced, never the client).
 *   A member's own reads write nothing (one branch, no query).
 */

export type ClientDataResource =
  | 'contacts'
  | 'contactNotes'
  | 'contactImports'
  | 'leads'
  | 'activities'
  | 'calendar'
  | 'prospects'
  | 'tasks'
  | 'pipeline'
  | 'stageHistory';

/** Records a read of client data when `ctx` is impersonated; a no-op otherwise (`compliance.auditImpersonatedRead`). */
export async function auditImpersonatedRead(
  ctx: Ctx,
  resource: ClientDataResource,
  read: {
    target?: compliance.AuditTarget;
    count?: number;
    parentId?: string;
    /** The list's filter enums / ids as the caller sent them (never free text). */
    filter?: { assigned?: string | undefined; stage?: string | undefined };
  },
): Promise<void> {
  await compliance.auditImpersonatedRead(ctx, 'crm.clientData.read', resource, read);
}
