import type { ProspectDto } from '@inmolink/contracts';
import { CRM_PROSPECT_LIMITS } from '@inmolink/contracts';
import type { Option, OptionGroup } from '../listings/taxonomy';
import { localInputValue } from './dates';
import { SellerSelect } from './seller-select';

const INPUT = 'h-9 w-full rounded-md border bg-background px-2 text-sm';

export interface ProspectFieldLabels {
  title: string;
  seller: string;
  noSeller: string;
  sellerHint: string;
  sellerFind: string;
  sellerFindSubmit: string;
  sellerFindNone: string;
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

/**
 * The prospect's fields, shared by the new and edit forms (plain HTML inputs posted to a server action). `notes` is
 * false when the caller may not see the confidential notes (staff impersonating): the field is left out, so a save never
 * clears them.
 */
export function ProspectFields(props: {
  labels: ProspectFieldLabels;
  value?: ProspectDto;
  propertyTypes: OptionGroup[];
  locations: Option[];
  notes: boolean;
  /** The agency's zone: the follow-up's `datetime-local` value is its wall clock. */
  timeZone: string;
}) {
  const { labels: l, value: v } = props;
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
      <SellerSelect
        labels={{
          seller: l.seller,
          noSeller: l.noSeller,
          hint: l.sellerHint,
          find: l.sellerFind,
          findSubmit: l.sellerFindSubmit,
          findNone: l.sellerFindNone,
        }}
        current={v?.contactId ? { id: v.contactId, label: v.contactName ?? v.contactId } : null}
        inputClass={INPUT}
      />
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
          defaultValue={v?.nextFollowUpAt ? localInputValue(new Date(v.nextFollowUpAt), props.timeZone) : ''}
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
