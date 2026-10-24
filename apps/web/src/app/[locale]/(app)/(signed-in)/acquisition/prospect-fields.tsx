import type { ContactListItemDto, ProspectDto } from '@inmolink/contracts';
import { CRM_PROSPECT_LIMITS } from '@inmolink/contracts';
import { DEFAULT_TIME_ZONE } from '@inmolink/i18n';
import type { Option, OptionGroup } from '../listings/taxonomy';
import { localInputValue } from './dates';

const INPUT = 'h-9 w-full rounded-md border bg-background px-2 text-sm';

export interface ProspectFieldLabels {
  title: string;
  seller: string;
  noSeller: string;
  sellerHint: string;
  address: string;
  area: string;
  propertyType: string;
  location: string;
  choose: string;
  price: string;
  followUp: string;
  notes: string;
  notesHint: string;
}

function contactLabel(c: ContactListItemDto): string {
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || c.primaryEmail || c.primaryPhone || c.id;
}

/**
 * The prospect's fields, shared by the new and edit forms (plain HTML inputs posted to a server action). `notes` is
 * false when the caller may not see the confidential notes (staff impersonating): the field is left out, so a save never
 * clears them.
 */
export function ProspectFields(props: {
  labels: ProspectFieldLabels;
  value?: ProspectDto;
  sellers: ContactListItemDto[];
  propertyTypes: OptionGroup[];
  locations: Option[];
  notes: boolean;
}) {
  const { labels: l, value: v } = props;
  const sellers =
    v?.contactId && !props.sellers.some((c) => c.id === v.contactId)
      ? [
          { id: v.contactId, label: v.contactName ?? v.contactId },
          ...props.sellers.map((c) => ({ id: c.id, label: contactLabel(c) })),
        ]
      : props.sellers.map((c) => ({ id: c.id, label: contactLabel(c) }));
  return (
    <>
      <label className="flex flex-col gap-1 text-sm">
        <span>{l.title}</span>
        <input
          name="title"
          required
          maxLength={CRM_PROSPECT_LIMITS.titleChars}
          defaultValue={v?.title ?? ''}
          className={INPUT}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span>{l.seller}</span>
        <select name="contactId" defaultValue={v?.contactId ?? ''} className={INPUT} aria-describedby="seller-hint">
          <option value="">{l.noSeller}</option>
          {sellers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <span id="seller-hint" className="text-xs text-muted-foreground">
          {l.sellerHint}
        </span>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span>{l.address}</span>
        <input
          name="address"
          maxLength={CRM_PROSPECT_LIMITS.addressChars}
          defaultValue={v?.address ?? ''}
          className={INPUT}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span>{l.area}</span>
        <input name="area" maxLength={CRM_PROSPECT_LIMITS.areaChars} defaultValue={v?.area ?? ''} className={INPUT} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span>{l.propertyType}</span>
        <select name="propertyTypeId" defaultValue={v?.propertyTypeId ?? ''} className={INPUT}>
          <option value="">{l.choose}</option>
          {props.propertyTypes.map((g) => (
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
      <label className="flex flex-col gap-1 text-sm">
        <span>{l.location}</span>
        <select name="locationId" defaultValue={v?.locationId ?? ''} className={INPUT}>
          <option value="">{l.choose}</option>
          {props.locations.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span>{l.price}</span>
        <input
          name="price"
          inputMode="numeric"
          pattern="[0-9 .,]*"
          defaultValue={v?.estimatedPrice ? String(Math.round(v.estimatedPrice.amountCents / 100)) : ''}
          className={INPUT}
        />
        {v?.estimatedPrice ? <input type="hidden" name="currency" value={v.estimatedPrice.currency} /> : null}
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span>{l.followUp}</span>
        <input
          type="datetime-local"
          name="nextFollowUpAt"
          defaultValue={v?.nextFollowUpAt ? localInputValue(new Date(v.nextFollowUpAt), DEFAULT_TIME_ZONE) : ''}
          className={INPUT}
        />
      </label>
      {props.notes ? (
        <label className="flex flex-col gap-1 text-sm">
          <span>{l.notes}</span>
          <textarea
            name="confidentialNotes"
            rows={4}
            maxLength={CRM_PROSPECT_LIMITS.notesChars}
            defaultValue={v?.confidentialNotes ?? ''}
            className="w-full rounded-md border bg-background p-2 text-sm"
            aria-describedby="notes-hint"
          />
          <span id="notes-hint" className="text-xs text-muted-foreground">
            {l.notesHint}
          </span>
        </label>
      ) : null}
    </>
  );
}
