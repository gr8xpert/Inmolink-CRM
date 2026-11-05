import { fetchMyAgency, type SessionRef } from '@/server/api';
import { loadShell } from '@/server/shell';
import { type CollaborationBlock, collaborationBlock } from './rights';

/** The block for this request: the role and mode from the shell (cached), then the agency's status (one call). */
export async function loadCollaborationBlock(session: SessionRef): Promise<CollaborationBlock | null> {
  const shell = await loadShell();
  const identity = shell?.identity ?? { kind: 'unknown' };
  const first = collaborationBlock(identity);
  if (first) return first;
  const agency = await fetchMyAgency(session);
  return collaborationBlock(identity, agency !== 'revoked' && agency.ok ? agency.data.status : null);
}
