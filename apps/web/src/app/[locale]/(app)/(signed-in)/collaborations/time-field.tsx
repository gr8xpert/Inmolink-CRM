import { getTranslations } from 'next-intl/server';
import { localInputValue } from '../acquisition/dates';

/**
 * A proposed viewing time (S17-F56): typed as the agency's wall clock, which the action turns into the contract's
 * date-time. The bounds are the API's: in the future, and not after the registration ends.
 */
export async function TimeField(props: { now: Date; until: string; timeZone: string }) {
  const t = await getTranslations('network.collaborations.actions');
  return (
    <label className="flex w-full max-w-72 flex-col gap-1">
      <span>{t('time', { zone: props.timeZone })}</span>
      <input
        type="datetime-local"
        name="proposedStartAt"
        required
        min={localInputValue(props.now, props.timeZone)}
        max={localInputValue(new Date(props.until), props.timeZone)}
        className="h-9 w-full rounded-md border bg-background px-2"
      />
    </label>
  );
}
