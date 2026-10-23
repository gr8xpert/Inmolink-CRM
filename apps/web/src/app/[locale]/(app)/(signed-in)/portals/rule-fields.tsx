import { type PortalSelection, PortalSelectionMode } from '@inmolink/contracts';
import { Input, Label } from '@inmolink/ui';
import { getTranslations } from 'next-intl/server';

export const SELECT = 'rounded-md border bg-background px-2 py-1 text-sm';

/** The selection rule's fields (create and edit forms): which listings go out, and the tag for TAGGED. Server component. */
export async function RuleFields({ selection, idPrefix }: { selection?: PortalSelection; idPrefix: string }) {
  const t = await getTranslations('portals');
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">{t('rule.title')}</legend>
      <p className="text-xs text-muted-foreground">{t('rule.hint')}</p>
      <Label htmlFor={`${idPrefix}-mode`}>{t('rule.mode')}</Label>
      <select id={`${idPrefix}-mode`} name="mode" defaultValue={selection?.mode ?? 'ALL_PUBLIC'} className={SELECT}>
        {PortalSelectionMode.options.map((m) => (
          <option key={m} value={m}>
            {t(`rule.modes.${m}`)}
          </option>
        ))}
      </select>
      <Label htmlFor={`${idPrefix}-tag`}>{t('rule.tag')}</Label>
      <Input
        id={`${idPrefix}-tag`}
        name="tag"
        maxLength={40}
        defaultValue={selection?.tag ?? ''}
        aria-describedby={`${idPrefix}-tag-hint`}
      />
      <p id={`${idPrefix}-tag-hint`} className="text-xs text-muted-foreground">
        {t('rule.tagHint')}
      </p>
    </fieldset>
  );
}
