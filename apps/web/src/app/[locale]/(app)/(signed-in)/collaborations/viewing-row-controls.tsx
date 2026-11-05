import type { ViewingRequestDto } from '@inmolink/contracts';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { ActionButton } from './action-button';
import {
  acceptViewingAction,
  cancelViewingAction,
  declineViewingAction,
  recordOutcomeAction,
  rescheduleViewingAction,
} from './actions';
import { TimeField } from './time-field';
import { viewingControls } from './viewing-controls';

const SUMMARY = 'w-fit cursor-pointer font-medium underline-offset-4 hover:underline';

/**
 * A viewing row's answers (S17-F56): the actions this side may take in this state, and a sentence for what it may not. All
 * plain forms to server actions. The owner's copy of the row has no client, so nothing here can show one.
 */
export async function ViewingRowControls(props: {
  viewing: ViewingRequestDto;
  now: Date;
  blocked: boolean;
  mayBind: boolean;
  timeZone: string;
  /** The page's filters, kept across the action. */
  back: string;
}) {
  const t = await getTranslations('network.collaborations');
  const v = props.viewing;
  const { actions, hints } = viewingControls(v, props);
  const has = (a: (typeof actions)[number]) => actions.includes(a);
  const fields = (
    <>
      <input type="hidden" name="id" value={v.id} />
      <input type="hidden" name="back" value={props.back} />
    </>
  );
  const bindsTerms = v.side === 'OWNER' && !v.terms.accepted;
  return (
    <div className="flex flex-col gap-2">
      {has('ACCEPT') && bindsTerms ? <p className="text-muted-foreground">{t('actions.acceptNote')}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        {has('ACCEPT') ? (
          <form action={acceptViewingAction}>
            {fields}
            <ActionButton label={t('actions.accept')} variant="default" />
          </form>
        ) : null}
        {has('DECLINE') ? (
          <form action={declineViewingAction}>
            {fields}
            <ActionButton label={t('actions.decline')} confirm={t('actions.declineConfirm')} />
          </form>
        ) : null}
        {has('OUTCOME') ? (
          <form action={recordOutcomeAction} className="flex flex-wrap items-center gap-2">
            {fields}
            <span>{t('actions.outcome')}</span>
            <ActionButton label={t('outcomes.ATTENDED')} name="outcome" value="ATTENDED" />
            <ActionButton label={t('outcomes.NO_SHOW')} name="outcome" value="NO_SHOW" />
          </form>
        ) : null}
        {has('CANCEL') ? (
          <form action={cancelViewingAction}>
            {fields}
            <ActionButton label={t('actions.cancel')} confirm={t('actions.cancelConfirm')} />
          </form>
        ) : null}
        <Link
          href={`/collaborations/viewings/${v.id}/terms`}
          className="px-1 font-medium underline-offset-4 hover:underline"
        >
          {t('actions.terms')}
        </Link>
        {v.side === 'INTRODUCER' && v.contactId ? (
          <Link href={`/contacts/${v.contactId}`} className="px-1 font-medium underline-offset-4 hover:underline">
            {t('actions.client')}
          </Link>
        ) : null}
      </div>
      {has('RESCHEDULE') ? (
        <details>
          <summary className={SUMMARY}>{t('actions.reschedule')}</summary>
          <form action={rescheduleViewingAction} className="mt-2 flex flex-wrap items-end gap-2">
            {fields}
            <TimeField now={props.now} until={v.terms.validUntil} timeZone={props.timeZone} />
            <ActionButton label={t('actions.rescheduleSubmit')} />
            {bindsTerms ? <p className="basis-full text-muted-foreground">{t('actions.rescheduleNote')}</p> : null}
          </form>
        </details>
      ) : null}
      {hints.map((h) => (
        <p key={h} className="text-muted-foreground">
          {t(`hints.${h}`)}
        </p>
      ))}
    </div>
  );
}
