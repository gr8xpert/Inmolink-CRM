import { InventoryPolicy, type SiteDto, WebsiteMode } from '@inmolink/contracts';
import { Button, Input, Label } from '@inmolink/ui';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import type { Option, OptionGroup } from '../listings/taxonomy';
import { createSiteAction, updateSiteAction } from './actions';

/**
 * The create / edit form of a website (S7-01). A plain server-rendered form (works without JavaScript): name, how it
 * runs, domains, the inventory policy (the custom selection is used only with the CUSTOM policy), reference prefix,
 * languages and contact overrides.
 */
const SELECT = 'rounded-md border bg-background px-2 py-1 text-sm';
const euros = (cents: number | undefined) => (cents === undefined ? '' : String(Math.round(cents / 100)));
/** Basis points as a percentage without trailing zeros (`300` → `3`, `350` → `3.5`). */
const percent = (bp: number | undefined) => (bp === undefined ? '' : String(bp / 100));
const CONTACT_FIELDS = [
  { key: 'name', label: 'form.contactName', type: 'text' },
  { key: 'email', label: 'form.contactEmail', type: 'email' },
  { key: 'phone', label: 'form.contactPhone', type: 'tel' },
  { key: 'whatsapp', label: 'form.contactWhatsapp', type: 'tel' },
] as const;

export async function SiteForm({
  site,
  locations,
  propertyTypes,
  defaultLocales,
}: {
  site?: SiteDto;
  locations: Option[];
  propertyTypes: OptionGroup[];
  defaultLocales: string[];
}) {
  const t = await getTranslations('websites');
  const f = site?.inventoryFilters;
  const locs = new Set(f?.locationIds ?? []);
  const types = new Set(f?.propertyTypeIds ?? []);
  return (
    <form action={site ? updateSiteAction : createSiteAction} className="flex max-w-2xl flex-col gap-5">
      {site ? (
        <>
          <input type="hidden" name="siteId" value={site.id} />
          <input type="hidden" name="version" value={site.version} />
        </>
      ) : null}
      <div className="flex flex-col gap-2">
        <Label htmlFor="site-name">{t('form.name')}</Label>
        <Input id="site-name" name="name" maxLength={80} required defaultValue={site?.name ?? ''} />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="site-mode">{t('form.mode')}</Label>
        <select id="site-mode" name="mode" defaultValue={site?.mode ?? 'WP_PLUGIN'} className={SELECT}>
          {WebsiteMode.options.map((m) => (
            <option key={m} value={m}>
              {t(`modes.${m}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="site-domains">{t('form.domains')}</Label>
        <textarea
          id="site-domains"
          name="domains"
          rows={2}
          defaultValue={site?.domains.join('\n') ?? ''}
          aria-describedby="site-domains-hint"
          className={SELECT}
        />
        <p id="site-domains-hint" className="text-xs text-muted-foreground">
          {t('form.domainsHint')}
        </p>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">{t('form.policy')}</legend>
        {InventoryPolicy.options.map((p) => (
          <label key={p} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="inventoryPolicy"
              value={p}
              defaultChecked={(site?.inventoryPolicy ?? 'OWN_ONLY') === p}
            />
            {t(`policies.${p}`)}
          </label>
        ))}
        <p className="text-xs text-muted-foreground">{t('form.policyHint')}</p>
      </fieldset>
      <fieldset className="flex flex-col gap-3 rounded-md border p-4" data-testid="site-custom">
        <legend className="px-1 text-sm font-medium">{t('form.custom')}</legend>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="includeOwn" defaultChecked={f?.includeOwn ?? true} />
            {t('form.includeOwn')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="includeNetwork" defaultChecked={f?.includeNetwork ?? false} />
            {t('form.includeNetwork')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="newBuilds" defaultChecked={f?.newBuilds ?? true} />
            {t('form.newBuilds')}
          </label>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="site-locations">{t('form.locations')}</Label>
          <select
            id="site-locations"
            name="locationIds"
            multiple
            size={6}
            defaultValue={[...locs]}
            aria-describedby="site-any-hint"
            className={SELECT}
          >
            {locations.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="site-types">{t('form.types')}</Label>
          <select
            id="site-types"
            name="propertyTypeIds"
            multiple
            size={6}
            defaultValue={[...types]}
            aria-describedby="site-any-hint"
            className={SELECT}
          >
            {propertyTypes.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <p id="site-any-hint" className="text-xs text-muted-foreground">
            {t('form.anyHint')}
          </p>
        </div>
        <div className="flex flex-wrap gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="site-price-min">{t('form.priceMin')}</Label>
            <Input
              id="site-price-min"
              name="priceMin"
              inputMode="numeric"
              defaultValue={euros(f?.priceMinCents)}
              aria-describedby="site-price-hint"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="site-price-max">{t('form.priceMax')}</Label>
            <Input
              id="site-price-max"
              name="priceMax"
              inputMode="numeric"
              defaultValue={euros(f?.priceMaxCents)}
              aria-describedby="site-price-hint"
            />
          </div>
        </div>
        <p id="site-price-hint" className="text-xs text-muted-foreground">
          {t('form.priceHint')}
        </p>
        <div className="flex flex-col gap-2">
          <Label htmlFor="site-min-commission">{t('form.minCommission')}</Label>
          <Input
            id="site-min-commission"
            name="minCommission"
            inputMode="decimal"
            defaultValue={percent(f?.minCommissionBp)}
            aria-describedby="site-min-commission-hint"
            className="max-w-32"
          />
          <p id="site-min-commission-hint" className="text-xs text-muted-foreground">
            {t('form.minCommissionHint')}
          </p>
        </div>
      </fieldset>
      <div className="flex flex-col gap-2">
        <Label htmlFor="site-prefix">{t('form.prefix')}</Label>
        <Input
          id="site-prefix"
          name="referencePrefix"
          maxLength={6}
          defaultValue={site?.referencePrefix ?? ''}
          aria-describedby="site-prefix-hint"
          className="max-w-32"
        />
        <p id="site-prefix-hint" className="text-xs text-muted-foreground">
          {t('form.prefixHint')}
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="site-locales">{t('form.locales')}</Label>
        <Input
          id="site-locales"
          name="locales"
          required
          defaultValue={(site?.locales ?? defaultLocales).join(', ')}
          aria-describedby="site-locales-hint"
        />
        <p id="site-locales-hint" className="text-xs text-muted-foreground">
          {t('form.localesHint')}
        </p>
      </div>
      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium">{t('form.contact')}</legend>
        <p className="text-xs text-muted-foreground">{t('form.contactHint')}</p>
        {CONTACT_FIELDS.map((c) => (
          <div key={c.key} className="flex flex-col gap-2">
            <Label htmlFor={`site-contact-${c.key}`}>{t(c.label)}</Label>
            <Input
              id={`site-contact-${c.key}`}
              name={`contact.${c.key}`}
              type={c.type}
              defaultValue={site?.contact?.[c.key] ?? ''}
            />
          </div>
        ))}
      </fieldset>
      <div className="flex items-center gap-4">
        <Button type="submit">{site ? t('form.save') : t('form.create')}</Button>
        <Link href="/websites" className="text-sm underline-offset-4 hover:underline">
          {t('form.back')}
        </Link>
      </div>
    </form>
  );
}
