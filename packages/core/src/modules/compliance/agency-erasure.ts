import { withSystem } from '@inmolink/db';
import * as chat from '../chat';
import * as crm from '../crm';
import * as identity from '../identity';
import * as imports from '../imports';
import * as matching from '../matching';
import * as media from '../media';
import * as mls from '../mls';
import * as notifications from '../notifications';
import * as presentations from '../presentations';
import * as properties from '../properties';
import * as websites from '../websites';
import { expireErasedExports } from './gdpr';
import { auditSystem } from './service';

/**
 * Agency erasure (S16-04, PLAN §13 offboarding: the agency's personal data goes; deal and audit rows stay with ids only)
 * — the steps of the `ERASE_AGENCY` staff operation (`admin.configureAgencyEraser` binds `eraseAgencyData` at worker
 * boot; worker-only: it reaches into every module that holds client or member text). The operation re-checks the
 * agency is still suspended before every step (admin) and keeps this file's `AgencyErasureState` in its cursor, so a
 * step resumes where the last one stopped, and the counts add up across every step.
 *
 * Phases, in order; each call is bounded and answers `more` until its phase is done:
 *
 * 1. `imports` — feed connections removed (credentials, URLs, run history), then the uploaded sheets under
 *    `imports/sheets/<agency>/` deleted (`imports.eraseAgencyImports` → `deleteAgencySheets`, S7-F1 / S8-F4).
 * 2. `contacts` — open contacts erased, `crm.SYSTEM_ERASE_BATCH` per call (crm's erasure, actor system), and for the
 *    batch the after-commit work run inline, not left to queued jobs: crm's `eraseContactsData` (activity bodies,
 *    website leads, listing sellers, notifications), mls's registration tombstones, presentations' selections —
 *    S16-F5: set-based, each step one call for the whole batch (no per-contact loop).
 * 3. `crmText` — what crm still holds outside contact rows (tasks, events, prospects, activities, leads, notes).
 * 4. `websiteLeads` — every website lead, promoted or not. 5. `registrations` — every client registration.
 * 6. `selections`. 7. `listings` — S16-F5: every live listing soft-deleted with its `properties.listing.deleted`
 * (network, websites, read models and the index drop it). 8. `listingPurge` — the soft-deleted listings purged for
 * good (children cascade, photos recounted), then the agency's `documents/` objects. 9. `chat` — the agency's message
 * copies, then its threads and participants (S16-F5: deleted, not only untitled). 9b. `dealDocuments` (R2-04b) — the
 * member and file names of its uploads to deals, on both parties' copies (the rows and PDFs stay as the deal's
 * evidence). 9c. `dealDisputes` (R2-04c) — the reasons and staff notes of its deal disputes (the rows stay).
 * 10. `savedSearches`.
 * 11. `notifications` — every notification and preference. 12. `contactImports` — files and the
 * `crm/contact-imports/<agency>/` prefix. 13. `exports` — every data export. 14. `memberProfiles` (S15-F10) — the
 * members' published portal profiles (names, phones, e-mails they published), then their photo uploads
 * (`member-photos/<agency>/`, private) and public copies (`portal/member-photos/<agency>/`, media).
 *
 * Then `compliance.agency.erased` is audited with the totals of all steps. Kept: deals (leads: ids, stages), audit
 * rows, billing, the agency row, its members' accounts and memberships (platform accounts, Inmolink's as controller —
 * PLAN §13 — erased on the person's request through identity; S16-F5 ASSUMPTION in STATUS).
 */

export const AGENCY_ERASURE_PHASES = [
  'imports',
  'contacts',
  'crmText',
  'websiteLeads',
  'registrations',
  'selections',
  'listings',
  'listingPurge',
  'chat',
  'dealDocuments',
  'dealDisputes',
  'savedSearches',
  'notifications',
  'contactImports',
  'exports',
  'memberProfiles',
] as const;
type Phase = (typeof AGENCY_ERASURE_PHASES)[number];

export type AgencyErasureCounts = Record<Phase, number>;

export interface AgencyErasureState {
  phase: Phase | 'done';
  /** The keyset position of the phase that walks one (`crmText`, `registrations`). */
  after: string | null;
  counts: AgencyErasureCounts;
}

const emptyCounts = (): AgencyErasureCounts =>
  Object.fromEntries(AGENCY_ERASURE_PHASES.map((p) => [p, 0])) as AgencyErasureCounts;

function stateOf(raw: unknown): AgencyErasureState {
  const s = raw as Partial<AgencyErasureState> | null | undefined;
  const phase = s?.phase && (s.phase === 'done' || AGENCY_ERASURE_PHASES.includes(s.phase)) ? s.phase : 'imports';
  return { phase, after: s?.after ?? null, counts: { ...emptyCounts(), ...(s?.counts ?? {}) } };
}

/** Bounded calls one step makes before it reports (each call is one batch of one phase). */
const CALLS_PER_STEP = 20;

/** One batch of one phase: rows done and whether the phase has more. */
async function runPhase(
  agencyId: string,
  state: AgencyErasureState,
  signal: AbortSignal | undefined,
): Promise<{ rows: number; more: boolean }> {
  switch (state.phase) {
    case 'imports': {
      const r = await imports.eraseAgencyImports({ agencyId, signal });
      return { rows: r.connections + r.sheets, more: r.more };
    }
    case 'contacts': {
      const r = await crm.eraseAgencyContacts({ agencyId });
      if (r.contactIds.length > 0) {
        // the batch's after-commit work, inline and set-based: the audit below must not claim what queued jobs owe
        await crm.eraseContactsData({ agencyId, contactIds: r.contactIds, agencyErasure: true });
        const contactIds = await crm.erasedContactIds({ agencyId, contactIds: r.contactIds });
        await mls.eraseContactRegistrations({ agencyId, contactIds });
        await presentations.eraseContactSelections({ agencyId, contactIds });
      }
      return { rows: r.erased, more: r.more };
    }
    case 'crmText': {
      // S17-F3: a keyset walk per table; `after` keeps its position between calls and steps
      const r = await crm.eraseAgencyCrmText({ agencyId, after: state.after });
      state.after = r.next;
      return { rows: r.rows, more: r.next !== null };
    }
    case 'websiteLeads':
      return websites.eraseAgencyLeads({ agencyId });
    case 'registrations': {
      const r = await mls.eraseAgencyRegistrations({ agencyId, after: state.after });
      state.after = r.last;
      return { rows: r.registrations, more: r.last !== null };
    }
    case 'selections': {
      const r = await presentations.eraseAgencySelections({ agencyId });
      return { rows: r.selections, more: r.more };
    }
    case 'listings':
      return properties.retireAgencyListings({ agencyId });
    case 'listingPurge': {
      const r = await media.purgeAgencyListings({ agencyId, signal });
      return { rows: r.listings, more: r.more };
    }
    case 'chat':
      return chat.eraseAgencyChat({ agencyId });
    case 'dealDocuments':
      return mls.eraseAgencyDealDocuments({ agencyId });
    case 'dealDisputes':
      return mls.eraseAgencyDealDisputes({ agencyId });
    case 'savedSearches':
      return matching.deleteAgencySavedSearches({ agencyId });
    case 'notifications':
      return notifications.deleteAgencyNotifications({ agencyId });
    case 'contactImports': {
      const r = await crm.purgeAgencyContactImports({ agencyId, signal });
      return { rows: r.files, more: r.more };
    }
    case 'exports': {
      const r = await expireErasedExports({ agencyId, scope: 'ALL' });
      return { rows: r.files, more: false };
    }
    case 'memberProfiles': {
      const r = await identity.eraseAgencyPublicProfiles({ agencyId, signal });
      return { rows: r.profiles + r.objects, more: r.more };
    }
    case 'done':
      return { rows: 0, more: false };
  }
}

/**
 * One step of an agency's erasure: from `state` (the operation's cursor; absent on the first step) up to
 * `CALLS_PER_STEP` bounded calls, each preceded by `assertSuspended` (S16-F5 review: the operation re-checks the
 * agency is still suspended before every destructive batch, not only per step). Answers the new state and whether everything is done — the last step audits
 * `compliance.agency.erased` with the totals across all steps.
 */
export async function eraseAgencyData(
  agencyId: string,
  opts: { signal?: AbortSignal; state?: unknown; assertSuspended?: () => Promise<void> } = {},
): Promise<{ finished: boolean; state: AgencyErasureState }> {
  const state = stateOf(opts.state);
  for (let calls = 0; calls < CALLS_PER_STEP && state.phase !== 'done'; calls++) {
    if (opts.signal?.aborted) return { finished: false, state };
    // S16-F5 review: a reinstated agency is never erased further, not even by the rest of this step
    await opts.assertSuspended?.();
    const r = await runPhase(agencyId, state, opts.signal);
    state.counts[state.phase] += r.rows;
    if (!r.more) {
      const i = AGENCY_ERASURE_PHASES.indexOf(state.phase);
      state.phase = AGENCY_ERASURE_PHASES[i + 1] ?? 'done';
      state.after = null;
    }
  }
  if (state.phase !== 'done') return { finished: false, state };
  await withSystem('compliance.eraseAgencyData', (tx) =>
    auditSystem(tx, {
      type: 'compliance.agency.erased',
      agencyId,
      target: { type: 'agency', id: agencyId },
      metadata: { ...state.counts },
    }),
  );
  return { finished: true, state };
}
