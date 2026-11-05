import { randomUUID } from 'node:crypto';
import { getTranslations } from 'next-intl/server';
import { ActionButton } from './action-button';
import { requestViewingAction } from './actions';
import { TimeField } from './time-field';

/** "Request viewing" on an active registration (S17-F56): a new `Idempotency-Key` per render, so a retry sends one request. */
export async function RequestViewingForm(props: {
  registrationId: string;
  until: string;
  now: Date;
  timeZone: string;
  back: string;
}) {
  const t = await getTranslations('network.collaborations.request');
  return (
    <details className="basis-full">
      <summary className="w-fit cursor-pointer font-medium underline-offset-4 hover:underline">{t('cta')}</summary>
      <form action={requestViewingAction} className="mt-2 flex flex-wrap items-end gap-2">
        <input type="hidden" name="registrationId" value={props.registrationId} />
        <input type="hidden" name="idempotencyKey" value={randomUUID()} />
        <input type="hidden" name="back" value={props.back} />
        <TimeField now={props.now} until={props.until} timeZone={props.timeZone} />
        <ActionButton label={t('submit')} variant="default" />
        <p className="basis-full text-muted-foreground">{t('note')}</p>
      </form>
    </details>
  );
}
