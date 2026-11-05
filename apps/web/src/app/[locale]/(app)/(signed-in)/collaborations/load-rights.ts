import { fetchMyAgency, type SessionRef } from '@/server/api';
import { fetchNetworkGate } from '@/server/collaborations-api';
import { loadShell } from '@/server/shell';
import { type CollaborationBlock, collaborationBlock } from './rights';

/** The block for this request: the role and mode from the shell (cached), then the agency's status and gate (two calls). */
export async function loadCollaborationBlock(session: SessionRef): Promise<CollaborationBlock | null> {
  const shell = await loadShell();
  const identity = shell?.identity ?? { kind: 'unknown' };
  const first = collaborationBlock(identity);
  if (first) return first;
  const [agency, gate] = await Promise.all([fetchMyAgency(session), fetchNetworkGate(session)]);
  return collaborationBlock(identity, {
    status: agency !== 'revoked' && agency.ok ? agency.data.status : null,
    gate: gate !== 'revoked' && gate.ok ? gate.data.state : null,
  });
}
