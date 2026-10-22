/**
 * The white-label check (S7-02, reused by S7-F8): what of a network listing's owner shows in something a site serves
 * — a serialized document, a feed, a rendered page. Returns one line per leak (empty: white-labelled), so a test can
 * `expect(whiteLabelLeaks(out, owner)).toEqual([])` and see every leak at once.
 */
export interface WhiteLabelOwner {
  name: string;
  email: string;
  /** The owner's web domain (`ownerhaus.example`). */
  domain: string;
  /** As written (`+34 600 123 456`); its digits are looked for in any spacing too. Optional. */
  phone?: string;
  /** The digits looked for in any spacing (default: the phone's digits) — e.g. the number without its country code. */
  phoneDigits?: string;
  /** The owner's own reference of the listing. */
  ref: string;
  /** The owner agency's id. Optional. */
  agencyId?: string;
  /** The commission as a string (`3.5`), looked for next to the word "commission". Optional. */
  commission?: string;
}

/** Every string anywhere in a value (object keys included); a string is itself. */
export function stringsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsOf(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      stringsOf(v, out);
    }
  }
  return out;
}

export function whiteLabelLeaks(served: unknown, owner: WhiteLabelOwner): string[] {
  const all = stringsOf(served);
  const text = all.join('\n');
  const lower = text.toLowerCase();
  const leaks: string[] = [];
  if (lower.includes(owner.name.toLowerCase())) leaks.push('owner name');
  if (lower.includes(owner.email.toLowerCase())) leaks.push('owner e-mail');
  if (lower.includes(owner.domain.toLowerCase())) leaks.push('owner domain');
  if (lower.includes(owner.ref.toLowerCase())) leaks.push('owner reference');
  if (owner.agencyId && lower.includes(owner.agencyId.toLowerCase())) leaks.push('owner agency id');
  if (owner.phone) {
    if (text.includes(owner.phone)) leaks.push('owner phone');
    const digits = owner.phoneDigits ?? owner.phone.replace(/\D/g, '');
    for (const s of all) {
      if (digits.length >= 6 && s.replace(/\D/g, '').includes(digits)) leaks.push(`owner phone digits in "${s}"`);
    }
  }
  if (all.some((s) => /commission|owner/i.test(s))) leaks.push('commission or owner field');
  if (owner.commission && text.includes(owner.commission) && /commission/i.test(text)) leaks.push('commission');
  return leaks;
}
