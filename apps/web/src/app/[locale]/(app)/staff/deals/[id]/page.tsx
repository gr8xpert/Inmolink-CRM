import { DEAL_STAGES, STAFF_OPERATION_ROLES } from '@inmolink/contracts';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { fetchStaffDeal, fetchStaffDisputesOfDeal } from '@/server/deals-api';
import { requireStaff } from '@/server/staff';
import { ActionButton } from '../../../(signed-in)/collaborations/action-button';
import { isUuid } from '../../../(signed-in)/deals/query';
import { mediateDealAction, resolveDealDisputeAction } from '../actions';

const SECTION = 'flex flex-col gap-3 rounded-md border p-4';
const FIELD = 'h-9 rounded-md border bg-background px-2';
const MEDIATORS: ReadonlySet<string> = new Set(STAFF_OPERATION_ROLES);

/**
 * Staff mediation of a deal (R2-04c): the deal with both parties — stage, price, terms snapshot, commission, handshake,
 * fall-through, the last mediation — and both parties' disputes of it. Data ops and super admins set the stage (any way,
 * also out of a closed one) and / or the price with a reason both parties see, and resolve a dispute with a note the
 * raising agency reads; both audited. Staff do not read the deal's documents (STATUS Decisions R2-04c): evidence comes
 * through the parties' support tickets. Non-staff get a 404; the forms show only to the roles the API lets mediate.
 */
export default async function StaffDealPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string>>;
}) {
  const { session, me } = await requireStaff();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const [res, disputes] = await Promise.all([fetchStaffDeal(session, id), fetchStaffDisputesOfDeal(session, id)]);
  if (res === 'revoked' || disputes === 'revoked') redirect('/session/expired');
  if (!res.ok && (res.status === 403 || res.status === 404)) notFound();
  const t = await getTranslations('staff.deals');
  const format = await getFormatter();
  const q = await searchParams;
  const money = (cents: number, currency: string) =>
    format.number(cents / 100, { style: 'currency', currency, maximumFractionDigits: 2 });
  const percent = (bp: number) => format.number(bp / 10_000, { style: 'percent', maximumFractionDigits: 2 });
  const date = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const error = typeof q.error === 'string' ? q.error : null;
  const reason = typeof q.reason === 'string' ? q.reason : null;
  const errorText = (code: string) =>
    code === 'DEAL_STATE' && reason && t.has(`errors.states.${reason}` as never)
      ? t(`errors.states.${reason}` as never)
      : t.has(`errors.${code}` as never)
        ? t(`errors.${code}` as never)
        : t('errors.generic');
  const mediates = MEDIATORS.has(me.role);

  if (!res.ok) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('errors.generic')}
      </p>
    );
  }
  const d = res.data;
  const terms = d.terms.commissionFixed
    ? t('terms.fixed', { amount: money(d.terms.commissionFixed.amountCents, d.terms.commissionFixed.currency) })
    : t('terms.rate', { rate: percent(d.terms.commissionBp ?? 0) });
  const facts: [string, string][] = [
    [t('facts.owner'), d.ownerAgency.name],
    [t('facts.introducer'), d.introducerAgency.name],
    [t('facts.target'), `${t(`kinds.${d.target.kind}`)} ${d.target.id}`],
    [t('facts.stage'), `${t(`stages.${d.stage}`)} · ${date(d.stageAt)}`],
    [t('facts.price'), money(d.price.amountCents, d.price.currency)],
    [
      t('facts.terms'),
      `${terms} · ${t('terms.split', { split: percent(d.terms.splitBp) })} · ${t(d.terms.includesVat ? 'terms.vatIncluded' : 'terms.vatExcluded')} · ${date(d.terms.snapshotAt)}`,
    ],
    [t('facts.total'), money(d.commission.totalCents, d.commission.currency)],
    [t('facts.introducerShare'), money(d.commission.introducerShareCents, d.commission.currency)],
    [t('facts.ownerShare'), money(d.commission.ownerShareCents, d.commission.currency)],
    [t('facts.ownerConfirmed'), date(d.ownerConfirmedAt)],
    [t('facts.introducerConfirmed'), date(d.introducerConfirmedAt)],
    [t('facts.completed'), date(d.completedAt)],
  ];
  if (d.fellThroughAt) facts.push([t('facts.fellThrough'), `${date(d.fellThroughAt)} · ${d.fellThroughReason ?? ''}`]);
  if (d.mediatedAt) facts.push([t('facts.mediated'), `${date(d.mediatedAt)} · ${d.mediationReason ?? ''}`]);

  return (
    <div className="flex flex-col gap-4">
      <Link href="/staff/deals" className="text-sm underline-offset-4 hover:underline">
        {t('back')}
      </Link>
      <h1 className="text-xl font-semibold">{t('dealTitle', { id: d.id })}</h1>
      {q.notice === 'mediated' || q.notice === 'resolved' ? (
        <p role="status" className="text-sm">
          {t(`notices.${q.notice}`)}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorText(error)}
        </p>
      ) : null}

      <section aria-labelledby="h-deal" className={SECTION}>
        <h2 id="h-deal" className="text-base font-semibold">
          {t('sections.deal')}
        </h2>
        <dl
          className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]"
          data-testid="staff-deal"
        >
          {facts.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-muted-foreground">{t('documentsNote')}</p>
      </section>

      <section aria-labelledby="h-disputes" className={SECTION}>
        <h2 id="h-disputes" className="text-base font-semibold">
          {t('sections.disputes')}
        </h2>
        {!disputes.ok ? (
          <p role="alert" className="text-sm text-destructive">
            {t('errors.generic')}
          </p>
        ) : disputes.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noDisputes')}</p>
        ) : (
          <ul className="flex flex-col gap-3 text-sm">
            {disputes.data.items.map((x) => (
              <li key={x.id} className="flex flex-col gap-1 rounded-md bg-muted/40 p-3">
                <p className="font-medium">
                  {t('row', {
                    agency: x.agency.name,
                    party: t(`parties.${x.party}`),
                    stage: t(`statuses.${x.status}`),
                  })}
                </p>
                <p className="text-xs text-muted-foreground">{date(x.createdAt)}</p>
                <p>{x.reason}</p>
                {x.status === 'OPEN' && mediates ? (
                  <form action={resolveDealDisputeAction} className="flex flex-col gap-2">
                    <input type="hidden" name="dealId" value={d.id} />
                    <input type="hidden" name="disputeId" value={x.id} />
                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-muted-foreground">{t('resolve.note')}</span>
                      <textarea name="note" required maxLength={2000} rows={2} className="rounded-md border p-2" />
                    </label>
                    <div>
                      <ActionButton label={t('resolve.submit')} confirm={t('resolve.confirm')} />
                    </div>
                  </form>
                ) : x.resolutionNote ? (
                  <p className="text-xs">
                    {t('note')}: {x.resolutionNote} · {date(x.resolvedAt)}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {mediates ? (
        <section aria-labelledby="h-mediate" className={SECTION}>
          <h2 id="h-mediate" className="text-base font-semibold">
            {t('sections.mediate')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('mediate.intro')}</p>
          <form action={mediateDealAction} className="flex flex-col gap-3 text-sm">
            <input type="hidden" name="dealId" value={d.id} />
            <input type="hidden" name="currency" value={d.price.currency} />
            <div className="flex flex-wrap gap-3">
              <label className="flex flex-col gap-1">
                <span>{t('mediate.stage')}</span>
                <select name="stage" defaultValue="" className={FIELD}>
                  <option value="">{t('mediate.keepStage', { stage: t(`stages.${d.stage}`) })}</option>
                  {DEAL_STAGES.filter((s) => s !== d.stage).map((s) => (
                    <option key={s} value={s}>
                      {t(`stages.${s}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span>{t('mediate.price', { currency: d.price.currency })}</span>
                <input name="amount" inputMode="decimal" autoComplete="off" className={FIELD} />
              </label>
            </div>
            <label className="flex flex-col gap-1">
              <span>{t('mediate.reason')}</span>
              <textarea name="reason" required maxLength={2000} rows={3} className="rounded-md border p-2" />
            </label>
            <p className="text-xs text-muted-foreground">{t('mediate.note')}</p>
            <div>
              <ActionButton variant="default" label={t('mediate.submit')} confirm={t('mediate.confirm')} />
            </div>
          </form>
        </section>
      ) : null}
    </div>
  );
}
