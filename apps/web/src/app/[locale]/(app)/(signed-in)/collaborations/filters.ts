import {
  REGISTRATION_TARGET_KINDS,
  type RegistrationTargetKind,
  VIEWING_STATUSES,
  type ViewingStatus,
} from '@inmolink/contracts';

export type SectionKey = 'outRegistrations' | 'inRegistrations' | 'outViewings' | 'inViewings';

export interface CollaborationFilters {
  direction: 'OUT' | 'IN' | undefined;
  type: 'REGISTRATION' | 'VIEWING' | undefined;
  /** The raw state choice: `ACTIVE` (registrations) or a viewing status (`EXPIRED` fits both). */
  state: string | undefined;
  kind: RegistrationTargetKind | undefined;
  from: string | undefined;
  to: string | undefined;
  cursor: string | undefined;
  /** The registrations' state filter, derived from `state`. */
  regState: 'ACTIVE' | 'EXPIRED' | undefined;
  /** The viewing requests' status filter, derived from `state`. */
  viewStatus: ViewingStatus | undefined;
}

const CURSOR = /^[A-Za-z0-9_-]{1,400}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Search params of the page, narrowed to what the API accepts; anything else is ignored. */
export function parseCollaborationParams(p: Record<string, string | undefined>): CollaborationFilters {
  const direction = p.direction === 'OUT' || p.direction === 'IN' ? p.direction : undefined;
  const type = p.type === 'REGISTRATION' || p.type === 'VIEWING' ? p.type : undefined;
  const isViewing = (VIEWING_STATUSES as readonly string[]).includes(p.state ?? '');
  const state = p.state === 'ACTIVE' || isViewing ? p.state : undefined;
  const kind = (REGISTRATION_TARGET_KINDS as readonly string[]).includes(p.kind ?? '')
    ? (p.kind as RegistrationTargetKind)
    : undefined;
  const day = (v: string | undefined) => (v && DAY.test(v) && !Number.isNaN(Date.parse(v)) ? v : undefined);
  return {
    direction,
    type,
    state,
    kind,
    from: day(p.from),
    to: day(p.to),
    cursor: p.cursor && CURSOR.test(p.cursor) ? p.cursor : undefined,
    regState: state === 'ACTIVE' || state === 'EXPIRED' ? state : undefined,
    viewStatus: isViewing ? (state as ViewingStatus) : undefined,
  };
}

/**
 * The lists to load for the filters, in display order. A state that only one kind of item has (`ACTIVE` for
 * registrations, `REQUESTED`… for viewings) leaves the other kind out.
 */
export function sectionsFor(f: CollaborationFilters): SectionKey[] {
  const out: SectionKey[] = [];
  const registrations =
    f.type !== 'VIEWING' && (f.state === undefined || f.state === 'ACTIVE' || f.state === 'EXPIRED');
  const viewings = f.type !== 'REGISTRATION' && f.state !== 'ACTIVE';
  if (f.direction !== 'IN') {
    if (registrations) out.push('outRegistrations');
    if (viewings) out.push('outViewings');
  }
  if (f.direction !== 'OUT') {
    if (registrations) out.push('inRegistrations');
    if (viewings) out.push('inViewings');
  }
  return out;
}
