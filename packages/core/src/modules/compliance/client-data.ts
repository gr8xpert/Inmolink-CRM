import type { Ctx } from '../../context';
import { impersonatorOf } from '../../impersonation';
import { type AuditTarget, audit } from './service';

/**
 * Reads of client data by staff impersonating a member (S11-F2, S12-F9, PLAN §12): the API's
 * `staff.impersonation.request` log line traces every impersonated request, but logs are not the audit log (retention,
 * tenant visibility). Each list / get of client data made while impersonating writes one `<module>.clientData.read`
 * row: ids, the resource, the page size and the list's filter enums only (never free text). A member's own reads write
 * nothing (one branch, no query).
 */
export type ClientDataReadType = 'crm.clientData.read' | 'mls.clientData.read' | 'chat.clientData.read';

/** The list filters a row may record: enum values or ids as the caller sent them — never free text. */
export type ClientDataFilterKey = 'assigned' | 'stage' | 'state' | 'status' | 'kind';

export interface ClientDataRead {
  target?: AuditTarget;
  count?: number;
  parentId?: string;
  /** The list's filter enums / ids (never free text). Empty values are left out. */
  filter?: Readonly<Partial<Record<ClientDataFilterKey, string | undefined>>>;
}

/** Records a read of client data when `ctx` is impersonated; a no-op otherwise. Call it after the read succeeded. */
export async function auditImpersonatedRead(
  ctx: Ctx,
  type: ClientDataReadType,
  resource: string,
  read: ClientDataRead,
): Promise<void> {
  if (impersonatorOf(ctx) === null) return;
  const filter: Record<string, string> = {};
  for (const [k, v] of Object.entries(read.filter ?? {})) if (v) filter[k] = v;
  // The filter first: it can never overwrite what the row is about.
  await audit(ctx, type, read.target ?? null, {
    ...filter,
    resource,
    view: read.target ? 'get' : 'list',
    ...(read.count !== undefined ? { count: read.count } : {}),
    ...(read.parentId ? { parentId: read.parentId } : {}),
  });
}
