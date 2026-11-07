import { FormTemplate } from '@inmolink/contracts';
import { z } from 'zod';

/**
 * What a form document is merged from (R2-05a), stored with it (`form_documents.data`) as read when it was made: the
 * agency, the client, the property, prices and commission come from the agency's data; the amounts, dates and
 * conditions a form asks for come from the member's request. Nothing here is AI-written. The render reads only this
 * (a later edit of the listing or contact never changes a made document).
 *
 * Bump `FORM_TEMPLATE_VERSION` with any change to the layout or the clause texts; `v` versions this shape.
 */
export const FORM_TEMPLATE_VERSION = 1;
/** The last template version whose clause texts are placeholders pending lawyer review (H17; R2-05c shows it). */
export const FORM_PLACEHOLDER_UNTIL_VERSION = 1;

const Text = (max: number) => z.string().max(max);
const Money = z.object({ amountCents: z.number().int().nonnegative(), currency: z.string().length(3) });

/** The agency issuing the document: its company details and branding. */
export const FormAgency = z.object({
  name: Text(200),
  taxId: Text(40).nullable(),
  address: Text(400).nullable(),
  registerNumber: Text(80).nullable(),
  email: Text(320).nullable(),
  phone: Text(40).nullable(),
  website: Text(400).nullable(),
  primaryColor: Text(32).nullable(),
  accentColor: Text(32).nullable(),
});
export type FormAgency = z.infer<typeof FormAgency>;

/** The client (seller or buyer): the agency's contact. */
export const FormClient = z.object({
  contactId: z.uuid(),
  name: Text(300),
  email: Text(320).nullable(),
  phone: Text(40).nullable(),
});
export type FormClient = z.infer<typeof FormClient>;

export const FormProperty = z.object({
  listingId: z.uuid(),
  reference: Text(64),
  title: Text(300).nullable(),
  cadastralRef: Text(64).nullable(),
  transactionType: z.enum(['SALE', 'RENT_LONG_TERM', 'RENT_SHORT_TERM']),
  price: Money.nullable(),
});
export type FormProperty = z.infer<typeof FormProperty>;

export const FormCommission = z.object({
  bp: z.number().int().nullable(),
  fixed: Money.nullable(),
  includesVat: z.boolean(),
});
export type FormCommission = z.infer<typeof FormCommission>;

const common = { v: z.literal(1), generatedAt: z.iso.datetime(), agency: FormAgency };

export const FormData = z.discriminatedUnion('template', [
  z.object({
    template: z.literal('LISTING_AGREEMENT'),
    ...common,
    client: FormClient,
    property: FormProperty,
    commission: FormCommission,
    exclusive: z.boolean(),
    termMonths: z.number().int(),
  }),
  z.object({
    template: z.literal('RESERVATION'),
    ...common,
    client: FormClient,
    property: FormProperty,
    price: Money,
    deposit: Money,
    holdDays: z.number().int(),
  }),
  z.object({
    template: z.literal('VIEWING_SHEET'),
    ...common,
    client: FormClient,
    properties: z.array(FormProperty).min(1),
    visitedOn: z.iso.date(),
  }),
  z.object({
    template: z.literal('OFFER'),
    ...common,
    client: FormClient,
    property: FormProperty,
    offer: Money,
    validUntil: z.iso.date(),
    conditions: Text(1_000).nullable(),
  }),
  z.object({
    template: z.literal('COLLABORATION_AGREEMENT'),
    ...common,
    dealId: z.uuid(),
    /** The issuing agency's side of the deal. */
    party: z.enum(['OWNER', 'INTRODUCER']),
    counterpart: z.object({ name: Text(200) }),
    property: z.object({ reference: Text(64), title: Text(300).nullable() }).nullable(),
    price: Money,
    terms: z.object({
      commissionBp: z.number().int().nullable(),
      commissionFixed: Money.nullable(),
      splitBp: z.number().int(),
      includesVat: z.boolean(),
    }),
    commission: z.object({
      totalCents: z.number().int(),
      introducerShareCents: z.number().int(),
      ownerShareCents: z.number().int(),
      currency: z.string().length(3),
    }),
  }),
]);
export type FormData = z.infer<typeof FormData>;

// The stored templates are exactly the contract's.
FormTemplate.options satisfies readonly FormData['template'][];
