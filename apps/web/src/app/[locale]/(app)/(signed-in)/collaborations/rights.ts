import type { AgencyStatus } from '@inmolink/contracts';
import type { ShellIdentity } from '@/server/nav';

/**
 * Why a member may not register clients or answer viewings (S17-F56): `mls.registrations.write` and `mls.viewings.write` in
 * `packages/core/src/modules/mls/policy.ts`. Null when nothing stops them. Keys under `network.collaborations.blocked`.
 * Only what the screens show: the policy decides, and the API refuses everyone else. An agency status that could not be
 * read blocks nothing here, for the same reason.
 */
export type CollaborationBlock = 'CLIENT_MODE' | 'IMPERSONATING' | 'ROLE' | 'UNVERIFIED';

const MEMBER_ROLES: ReadonlySet<string> = new Set(['AGENCY_ADMIN', 'DEVELOPER_ADMIN', 'AGENT', 'DEVELOPER_AGENT']);

export function collaborationBlock(
  identity: ShellIdentity,
  agencyStatus?: AgencyStatus | null,
): CollaborationBlock | null {
  if (identity.kind !== 'member') return 'ROLE';
  if (identity.caps.clientMode) return 'CLIENT_MODE';
  if (identity.caps.impersonating) return 'IMPERSONATING';
  if (!MEMBER_ROLES.has(identity.caps.role)) return 'ROLE';
  return agencyStatus && agencyStatus !== 'VERIFIED' ? 'UNVERIFIED' : null;
}
