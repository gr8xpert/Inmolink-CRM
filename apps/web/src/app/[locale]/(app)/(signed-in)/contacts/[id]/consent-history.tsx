import type { ConsentPurpose, ConsentRecordDto, ConsentSource } from '@inmolink/contracts';

export interface ConsentHistoryLabels {
  title: string;
  empty: string;
  load: string;
  purpose: Record<ConsentPurpose, string>;
  granted: string;
  withdrawn: string;
  source: Record<ConsentSource, string>;
  byMember: string;
  impersonated: string;
  policy: (version: string) => string;
}

/**
 * A contact's consent history (S16-F5, PLAN §13 consent records): every consent given or withdrawn, newest first, with
 * where it was made, the privacy text version a form showed and whether a team member (or support on a member's
 * behalf) recorded it. Ids and times only come from the API; no client JS.
 */
export function ConsentHistory({
  items,
  labels,
  formatDate,
}: {
  /** null: the history could not be loaded. */
  items: readonly ConsentRecordDto[] | null;
  labels: ConsentHistoryLabels;
  formatDate: (d: Date) => string;
}) {
  return (
    <section aria-labelledby="consents" className="flex flex-col gap-2">
      <h2 id="consents" className="text-base font-semibold">
        {labels.title}
      </h2>
      {items === null ? (
        <p role="alert" className="text-sm text-destructive">
          {labels.load}
        </p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{labels.empty}</p>
      ) : (
        <ul className="divide-y rounded-md border text-sm" data-testid="consent-history">
          {items.map((r) => (
            <li key={r.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 p-3">
              <span className="font-medium">
                {labels.purpose[r.purpose]}: {r.granted ? labels.granted : labels.withdrawn}
              </span>
              <span className="text-muted-foreground">
                {[
                  labels.source[r.source],
                  r.actorUserId ? (r.impersonated ? labels.impersonated : labels.byMember) : null,
                  r.policyVersion ? labels.policy(r.policyVersion) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              <time dateTime={r.recordedAt} className="ml-auto text-xs text-muted-foreground">
                {formatDate(new Date(r.recordedAt))}
              </time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
