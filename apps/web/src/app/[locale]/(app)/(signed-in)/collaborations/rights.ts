import type { AgencyStatus, GiveToGetState } from '@inmolink/contracts';
import type { ShellIdentity } from '@/server/nav';

/**
 * Why a member may not start a collaboration (S17-F56): `mls.registrations.write` and `mls.viewings.write` in
 * `packages/core/src/modules/mls/policy.ts`, then the give-to-get gate. Null when nothing stops them. Keys under
 * `network.collaborations.blocked`. The API has no single answer for this, so the screens that link to a registration
 * (network, listing and development pages) read it here; a viewing's own answers come from `allowedActions`, and `LOCKED`
 * leaves those open. Only what the screens show: the API refuses everyone else, so a status that could not be read blocks
 * nothing here.
 */
export type CollaborationBlock = 'CLIENT_MODE' | 'IMPERSONATING' | 'ROLE' | 'UNVERIFIED' | 'LOCKED';

const MEMBER_ROLES: ReadonlySet<string> = new Set(['AGENCY_ADMIN', 'DEVELOPER_ADMIN', 'AGENT', 'DEVELOPER_AGENT']);

export function collaborationBlock(
  identity: ShellIdentity,
  agency: { status?: AgencyStatus | null | undefined; gate?: GiveToGetState | null | undefined } = {},
): CollaborationBlock | null {
  if (identity.kind !== 'member') return 'ROLE';
  if (identity.caps.clientMode) return 'CLIENT_MODE';
  if (identity.caps.impersonating) return 'IMPERSONATING';
  if (!MEMBER_ROLES.has(identity.caps.role)) return 'ROLE';
  if (agency.status && agency.status !== 'VERIFIED') return 'UNVERIFIED';
  return agency.gate === 'LOCKED' ? 'LOCKED' : null;
}
