import { withTenant } from '@inmolink/db';
import * as compliance from '../compliance';
import * as repo from './repo';
import { deleteAgencySheets } from './sheet/lifecycle';

/**
 * Agency erasure, the imports side (S16-04, offboarding; S7-F1 / S8-F4): in one transaction under the agency's RLS,
 * every feed connection of the agency is removed (with its run history; credentials and feed URLs go with the rows),
 * audited `imports.connections.erased` (actor system, the count; none when there was nothing); after that commit, every uploaded sheet under
 * `imports/sheets/<agency>/` is deleted from storage (`deleteAgencySheets`, one bounded call: `more` = call again). A run
 * in flight stops at its next batch (its connection is gone). Idempotent: a rerun removes and deletes nothing more.
 */
export async function eraseAgencyImports(p: {
  agencyId: string;
  signal?: AbortSignal;
}): Promise<{ connections: number; sheets: number; more: boolean }> {
  const connections = await withTenant({ agencyId: p.agencyId }, async (tx) => {
    const n = await repo.deleteAgencyConnections(tx, p.agencyId);
    if (n > 0) {
      await compliance.auditSystem(tx, {
        type: 'imports.connections.erased',
        agencyId: p.agencyId,
        target: { type: 'agency', id: p.agencyId },
        metadata: { connections: n },
      });
    }
    return n;
  });
  // after the commit: no connection can name a file any more, so every object under the prefix goes — one bounded
  // call (S16-04 review: `deleteAgencySheets` pages at most `SHEETS.MAX_PAGES`); `more` sends the caller back
  const { deleted: sheets, more } = await deleteAgencySheets(p.agencyId, { signal: p.signal });
  return { connections, sheets, more };
}
