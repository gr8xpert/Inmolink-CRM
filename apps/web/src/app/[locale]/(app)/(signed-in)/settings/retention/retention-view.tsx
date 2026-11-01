import type { RetentionSettingsDto } from '@inmolink/contracts';

/**
 * What the retention page shows (S16-F5): the period in force now and, inside the grace window of a shortened period
 * (or one newly turned on), the new period and the date it starts to apply. Pure: the page passes the API's answer
 * and the clock.
 */
export interface RetentionView {
  /** The period in force now, in months; null = off (contacts are kept until erased by hand). */
  inForce: number | null;
  /** A shortened period waiting for its grace window to end; null when nothing is pending. */
  pending: { months: number | null; effectiveAt: Date } | null;
}

export function retentionView(dto: RetentionSettingsDto, now: Date): RetentionView {
  const effectiveAt = new Date(dto.effectiveAt);
  if (effectiveAt.getTime() > now.getTime()) {
    return { inForce: dto.previousMonths, pending: { months: dto.inactiveContactMonths, effectiveAt } };
  }
  return { inForce: dto.inactiveContactMonths, pending: null };
}

export interface RetentionNoticeLabels {
  inForce: (months: number) => string;
  inForceOff: string;
  pending: (months: number | null, date: string) => string;
  graceHint: string;
}

/** The period in force and the pending one with its effective date (no client JS). */
export function RetentionNotice({
  view,
  labels,
  formatDate,
}: {
  view: RetentionView;
  labels: RetentionNoticeLabels;
  formatDate: (d: Date) => string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-md border p-3 text-sm" data-testid="retention-notice">
      <p>{view.inForce === null ? labels.inForceOff : labels.inForce(view.inForce)}</p>
      {view.pending ? (
        <p role="status" className="font-medium" data-testid="retention-pending">
          {labels.pending(view.pending.months, formatDate(view.pending.effectiveAt))}
        </p>
      ) : null}
      {view.pending ? <p className="text-xs text-muted-foreground">{labels.graceHint}</p> : null}
    </div>
  );
}
