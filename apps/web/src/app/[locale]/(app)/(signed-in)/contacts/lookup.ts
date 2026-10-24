import { ContactLookupBody } from '@inmolink/contracts';

/**
 * The "find by e-mail or phone" box (S11-F14): what was typed becomes an e-mail (it has an `@`) or a phone lookup, or
 * null when it is neither. The values travel in the lookup request's body (never a URL), and are validated by the contract.
 */
export function lookupBody(input: unknown): ContactLookupBody | null {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (text === '' || text.length > 254) return null;
  const parsed = ContactLookupBody.safeParse(text.includes('@') ? { emails: [text] } : { phones: [text] });
  return parsed.success ? parsed.data : null;
}

/** A contact's display name: its name, else its e-mail or phone. */
export function contactName(c: {
  firstName: string | null;
  lastName: string | null;
  primaryEmail?: string | null;
  primaryPhone?: string | null;
}): string | null {
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || c.primaryEmail || c.primaryPhone || null;
}
