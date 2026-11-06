import {
  CLIENT_PROFILE_FREQUENCIES,
  CLIENT_PROFILE_LIMITS,
  CLIENT_PROFILE_MODES,
  type ClientProfileDto,
  TRANSACTION_TYPES,
} from '@inmolink/contracts';
import { EmptyState } from '@inmolink/ui';
import { Link } from '@/i18n/navigation';
import type { ListingTaxonomy } from '../../listings/taxonomy';
import { profileFormValues } from './profile-form';

/**
 * A contact's client profiles (R2-02d, PLAN §7 M9): the list (criteria as chips, mode and frequency, edit, delete, a
 * link to its matches) and one form that creates a profile or edits the one opened (`?profile=<id>`, at its version;
 * a version conflict reopens it at the latest one). Server-rendered, no client JS; every rule is the API's.
 */

type Translate = (key: string, values?: Record<string, string | number>) => string;
type FormAction = string | ((form: FormData) => void | Promise<void>);

export interface ClientProfilesProps {
  contactId: string;
  /** Null: the list could not be loaded. */
  profiles: ClientProfileDto[] | null;
  /** The profile the form edits (else it creates one). */
  editing: ClientProfileDto | null;
  /** The edit form reopened after a version conflict. */
  conflict: boolean;
  /** The profile whose deletion is asked to be confirmed (`?confirmDelete=<id>`). */
  confirmDelete?: string | null;
  tax: ListingTaxonomy;
  /** `contacts.profiles` messages. */
  t: Translate;
  euros: (cents: number) => string;
  actions: { save: FormAction; delete: FormAction };
}

const FIELD = 'h-9 rounded-md border bg-background px-2';

export function ClientProfiles({
  contactId,
  profiles,
  editing,
  conflict,
  confirmDelete = null,
  tax,
  t,
  euros,
  actions,
}: ClientProfilesProps) {
  const featureNames = new Map(tax.features.flatMap((g) => g.options.map((o) => [o.id, o.label] as const)));
  const v = profileFormValues(editing);
  const formId = editing ? `profile-form-${editing.id}` : 'profile-form-new';
  const chipsOf = (p: ClientProfileDto): string[] => {
    const range = (min: number | null, max: number | null, show: (n: number) => string) =>
      min !== null || max !== null ? `${min !== null ? show(min) : '…'} – ${max !== null ? show(max) : '…'}` : null;
    return [
      p.transactionType ? t(`transactions.${p.transactionType}`) : null,
      ...p.propertyTypeIds.map((id) => tax.typeName(id)),
      ...p.locationIds.map((id) => tax.locationName(id)),
      range(p.priceMinCents, p.priceMaxCents, euros),
      p.bedsMin !== null ? t('beds', { count: p.bedsMin }) : null,
      p.bathsMin !== null ? t('baths', { count: p.bathsMin }) : null,
      p.areaMinM2 !== null || p.areaMaxM2 !== null
        ? t('area', { min: p.areaMinM2 ?? '…', max: p.areaMaxM2 ?? '…' })
        : null,
      p.featureIds.length > 0
        ? t('mustHaves', { list: p.featureIds.map((id) => featureNames.get(id) ?? '?').join(', ') })
        : null,
    ].filter((x): x is string => Boolean(x));
  };

  return (
    <section aria-labelledby="profiles-title" id="profiles" className="flex flex-col gap-3">
      <h2 id="profiles-title" className="text-base font-semibold">
        {t('title')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      {profiles === null ? (
        <p role="alert" className="text-sm text-destructive">
          {t('loadError')}
        </p>
      ) : profiles.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t('listLabel')}>
          {profiles.map((p, i) => {
            const n = i + 1;
            const chips = chipsOf(p);
            return (
              <li
                key={p.id}
                data-testid="client-profile"
                className="flex flex-wrap items-start gap-3 rounded-md border p-3 text-sm"
              >
                <div className="flex min-w-48 flex-1 flex-col gap-1">
                  <h3 className="font-medium">{t('profileN', { n })}</h3>
                  <p className="text-muted-foreground">{chips.length > 0 ? chips.join(' · ') : t('anything')}</p>
                  <p className="text-xs text-muted-foreground">
                    {t(`modes.${p.mode}`)} · {t(`frequencies.${p.frequency}`)}
                  </p>
                  {p.wishes ? <p className="whitespace-pre-wrap">{p.wishes}</p> : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={{ pathname: '/matches', query: { profile: p.id } }}
                    aria-label={t('matchesLabel', { n })}
                    className="inline-flex h-8 items-center rounded-md border px-3"
                  >
                    {t('matches')}
                  </Link>
                  <Link
                    href={{ pathname: `/contacts/${contactId}`, query: { profile: p.id }, hash: 'profile-form' }}
                    aria-label={t('editLabel', { n })}
                    className="inline-flex h-8 items-center rounded-md border px-3"
                  >
                    {t('edit')}
                  </Link>
                  {confirmDelete !== p.id ? (
                    <Link
                      href={{
                        pathname: `/contacts/${contactId}`,
                        query: { confirmDelete: p.id },
                        hash: `delete-${p.id}`,
                      }}
                      aria-label={t('deleteLabel', { n })}
                      className="inline-flex h-8 items-center rounded-md border px-3"
                    >
                      {t('delete')}
                    </Link>
                  ) : null}
                </div>
                {/* deleting is not undone: a second, explicit step (WCAG 3.3.4) */}
                {confirmDelete === p.id ? (
                  <form
                    action={actions.delete}
                    id={`delete-${p.id}`}
                    className="flex w-full flex-wrap items-center gap-2 rounded-md bg-muted p-2"
                  >
                    <input type="hidden" name="contactId" value={contactId} />
                    <input type="hidden" name="id" value={p.id} />
                    <p role="alert">{t('confirmDelete', { n })}</p>
                    <button type="submit" className="h-8 rounded-md border bg-background px-3 font-medium">
                      {t('confirmDeleteYes')}
                    </button>
                    <Link
                      href={{ pathname: `/contacts/${contactId}`, hash: 'profiles' }}
                      className="underline-offset-4 hover:underline"
                    >
                      {t('form.cancel')}
                    </Link>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <div id="profile-form" tabIndex={-1} className="flex flex-col gap-3 rounded-md border p-4">
        <h3 id={`${formId}-title`} className="font-medium">
          {editing ? t('form.editTitle') : t('form.createTitle')}
        </h3>
        {conflict ? (
          <p id={`${formId}-conflict`} role="alert" className="text-sm text-destructive">
            {t('form.conflict')}
          </p>
        ) : null}
        {/* the key resets the uncontrolled fields when another profile (or a newer version) is opened */}
        <form
          key={`${editing?.id ?? 'new'}-${editing?.version ?? 0}`}
          action={actions.save}
          aria-labelledby={`${formId}-title`}
          aria-describedby={conflict ? `${formId}-conflict` : undefined}
          className="grid gap-3 text-sm sm:grid-cols-2"
        >
          <input type="hidden" name="contactId" value={contactId} />
          {editing ? (
            <>
              <input type="hidden" name="id" value={editing.id} />
              <input type="hidden" name="version" value={editing.version} />
            </>
          ) : null}
          <label className="flex flex-col gap-1">
            <span>{t('form.mode')}</span>
            <select name="mode" className={FIELD} defaultValue={v.mode} aria-describedby={`${formId}-mode-help`}>
              {CLIENT_PROFILE_MODES.map((m) => (
                <option key={m} value={m}>
                  {t(`modes.${m}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span>{t('form.frequency')}</span>
            <select name="frequency" className={FIELD} defaultValue={v.frequency}>
              {CLIENT_PROFILE_FREQUENCIES.map((f) => (
                <option key={f} value={f}>
                  {t(`frequencies.${f}`)}
                </option>
              ))}
            </select>
          </label>
          <p id={`${formId}-mode-help`} className="text-xs text-muted-foreground sm:col-span-2">
            {t('modeHelp')}
          </p>
          <label className="flex flex-col gap-1">
            <span>{t('form.transaction')}</span>
            <select name="transactionType" className={FIELD} defaultValue={v.transactionType}>
              <option value="">{t('form.any')}</option>
              {TRANSACTION_TYPES.map((x) => (
                <option key={x} value={x}>
                  {t(`transactions.${x}`)}
                </option>
              ))}
            </select>
          </label>
          <span className="hidden sm:block" />
          <label className="flex flex-col gap-1">
            <span>{t('form.propertyTypes')}</span>
            <select
              name="propertyTypeIds"
              multiple
              size={6}
              className="rounded-md border bg-background p-1"
              defaultValue={v.propertyTypeIds}
              aria-describedby={`${formId}-multi-help`}
            >
              {tax.propertyTypes.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span>{t('form.locations')}</span>
            <select
              name="locationIds"
              multiple
              size={6}
              className="rounded-md border bg-background p-1"
              defaultValue={v.locationIds}
              aria-describedby={`${formId}-multi-help`}
            >
              {tax.locations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <p id={`${formId}-multi-help`} className="text-xs text-muted-foreground sm:col-span-2">
            {t('form.multiHelp')}
          </p>
          {(
            [
              ['priceMin', v.priceMin],
              ['priceMax', v.priceMax],
              ['bedsMin', v.bedsMin],
              ['bathsMin', v.bathsMin],
              ['areaMin', v.areaMin],
              ['areaMax', v.areaMax],
            ] as const
          ).map(([name, value]) => (
            <label key={name} className="flex flex-col gap-1">
              <span>{t(`form.${name}`)}</span>
              <input
                name={name}
                inputMode={name.startsWith('area') ? 'decimal' : 'numeric'}
                defaultValue={value}
                className={FIELD}
              />
            </label>
          ))}
          {tax.features.length > 0 ? (
            <fieldset className="flex flex-col gap-2 sm:col-span-2">
              <legend className="mb-1">{t('form.features')}</legend>
              {tax.features.map((g) => (
                <fieldset key={g.label} className="flex flex-col gap-1">
                  <legend className="text-xs text-muted-foreground">{g.label}</legend>
                  <div className="flex flex-wrap gap-3">
                    {g.options.map((o) => (
                      <label key={o.id} className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          name="featureIds"
                          value={o.id}
                          defaultChecked={v.featureIds.includes(o.id)}
                        />
                        {o.label}
                      </label>
                    ))}
                  </div>
                </fieldset>
              ))}
            </fieldset>
          ) : null}
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span>{t('form.wishes')}</span>
            <textarea
              name="wishes"
              rows={3}
              maxLength={CLIENT_PROFILE_LIMITS.wishesChars}
              defaultValue={v.wishes}
              aria-describedby={`${formId}-wishes-help`}
              className="rounded-md border bg-background p-2"
            />
            <span id={`${formId}-wishes-help`} className="text-xs text-muted-foreground">
              {t('form.wishesHelp', { max: CLIENT_PROFILE_LIMITS.wishesChars })}
            </span>
          </label>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <button type="submit" className="h-9 rounded-md border px-3 font-medium">
              {t('form.save')}
            </button>
            {editing ? (
              <Link
                href={{ pathname: `/contacts/${contactId}`, hash: 'profiles' }}
                className="underline-offset-4 hover:underline"
              >
                {t('form.cancel')}
              </Link>
            ) : null}
          </div>
        </form>
      </div>
    </section>
  );
}
