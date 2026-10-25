/** presentations DTOs (PATTERNS §9): Zod schemas and inferred types for params, bodies and responses. */
import { z } from 'zod';
import { PageQuery, pageOf } from './common';

/**
 * Selections (S12-04, PLAN §7 M13): listings and units an agent picks for a client — from search results or a
 * bookmark folder — shared as a branded live page (`/s/<token>` on the public pages host) by WhatsApp or e-mail.
 */
export const SELECTION_LIMITS = {
  items: 50,
  titleChars: 200,
  messageChars: 2_000,
  noteChars: 1_000,
  enquiryChars: 2_000,
  /** A link lives at most this long (and 30 days by default). */
  expiryDaysMax: 365,
  expiryDaysDefault: 30,
} as const;

const ContentLocale = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/);
const Title = z.string().trim().min(1).max(SELECTION_LIMITS.titleChars);
const Message = z.string().trim().min(1).max(SELECTION_LIMITS.messageChars);
const Note = z.string().trim().min(1).max(SELECTION_LIMITS.noteChars);

export const SelectionItemInput = z.strictObject({
  /** A listing's or unit's id (any the agent can see: own or shared with them). */
  targetId: z.uuid(),
  titleOverride: z.string().trim().min(1).max(SELECTION_LIMITS.titleChars).nullable().optional(),
  note: Note.nullable().optional(),
});
export type SelectionItemInput = z.infer<typeof SelectionItemInput>;

/** `POST /v1/selections`: from chosen items (search results, in order) or one of the caller's bookmark folders. */
export const CreateSelectionBody = z
  .strictObject({
    title: Title,
    message: Message.nullable().optional(),
    /** The client's language (a content locale of the agency); the page falls back to the agency's default. */
    locale: ContentLocale,
    contactId: z.uuid().nullable().optional(),
    /** Days the link lives (default `SELECTION_LIMITS.expiryDaysDefault`). */
    expiresInDays: z.number().int().min(1).max(SELECTION_LIMITS.expiryDaysMax).optional(),
    items: z.array(SelectionItemInput).min(1).max(SELECTION_LIMITS.items).optional(),
    /** Start from a bookmark folder (its visible listings, oldest bookmark first). */
    fromFolderId: z.uuid().optional(),
  })
  .refine((b) => (b.items === undefined) !== (b.fromFolderId === undefined), {
    message: 'give items or fromFolderId, not both',
  });
export type CreateSelectionBody = z.infer<typeof CreateSelectionBody>;

/** `PATCH /v1/selections/:id`: optimistic (`version`); `items` replaces the list in its new order. */
export const UpdateSelectionBody = z.strictObject({
  version: z.number().int().min(1),
  title: Title.optional(),
  message: Message.nullable().optional(),
  locale: ContentLocale.optional(),
  /** Days from now the link lives; null: stop it now (revoke). */
  expiresInDays: z.number().int().min(1).max(SELECTION_LIMITS.expiryDaysMax).nullable().optional(),
  items: z.array(SelectionItemInput).min(1).max(SELECTION_LIMITS.items).optional(),
});
export type UpdateSelectionBody = z.infer<typeof UpdateSelectionBody>;

export const SelectionParams = z.strictObject({ id: z.uuid() });

export const SelectionStatus = z.enum(['LIVE', 'EXPIRED', 'REVOKED']);
export type SelectionStatus = z.infer<typeof SelectionStatus>;

export const SelectionItemDto = z.strictObject({
  targetId: z.uuid(),
  position: z.number().int(),
  titleOverride: z.string().nullable(),
  note: z.string().nullable(),
  likes: z.number().int().nonnegative(),
  enquiries: z.number().int().nonnegative(),
});
export type SelectionItemDto = z.infer<typeof SelectionItemDto>;

export const SelectionDto = z.strictObject({
  id: z.uuid(),
  title: z.string(),
  message: z.string().nullable(),
  locale: z.string(),
  contactId: z.uuid().nullable(),
  status: SelectionStatus,
  expiresAt: z.iso.datetime().nullable(),
  /** The live link's last 4 characters. */
  tokenHint: z.string(),
  items: z.array(SelectionItemDto),
  stats: z.strictObject({
    views: z.number().int().nonnegative(),
    lastViewedAt: z.iso.datetime().nullable(),
  }),
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SelectionDto = z.infer<typeof SelectionDto>;

/** A new link: shown once (the token is never stored). `url` and the share links need `PUBLIC_PAGES_URL`. */
export const SelectionShareDto = z.strictObject({
  token: z.string(),
  path: z.string(),
  url: z.string().nullable(),
  /** `https://wa.me/?text=…` (the client's number when the contact has one). */
  whatsappUrl: z.string().nullable(),
  /** `mailto:` with subject and body. */
  emailUrl: z.string().nullable(),
});
export type SelectionShareDto = z.infer<typeof SelectionShareDto>;

export const SelectionCreatedDto = z.strictObject({ selection: SelectionDto, share: SelectionShareDto });
export type SelectionCreatedDto = z.infer<typeof SelectionCreatedDto>;

/** `GET /v1/selections`: the agency's selections, newest first, keyset. */
export const ListSelectionsQuery = PageQuery.extend({ contactId: z.uuid().optional() }).strict();
export type ListSelectionsQuery = z.infer<typeof ListSelectionsQuery>;

export const SelectionSummaryDto = SelectionDto.omit({ items: true }).extend({ itemCount: z.number().int() });
export type SelectionSummaryDto = z.infer<typeof SelectionSummaryDto>;
export const SelectionPage = pageOf(SelectionSummaryDto);
export type SelectionPage = z.infer<typeof SelectionPage>;

export const SelectionInteractionKind = z.enum(['VIEW', 'LIKE', 'UNLIKE', 'ENQUIRE']);
export type SelectionInteractionKind = z.infer<typeof SelectionInteractionKind>;

export const SelectionInteractionDto = z.strictObject({
  id: z.uuid(),
  kind: SelectionInteractionKind,
  targetId: z.uuid().nullable(),
  message: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export const SelectionInteractionPage = pageOf(SelectionInteractionDto);
export type SelectionInteractionPage = z.infer<typeof SelectionInteractionPage>;
export const ListSelectionInteractionsQuery = PageQuery.strict();
export type ListSelectionInteractionsQuery = z.infer<typeof ListSelectionInteractionsQuery>;

/** The public page's like / enquiry form (`POST /s/<token>`, form-encoded). */
export const SelectionPageAction = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('like'), item: z.uuid() }),
  z.strictObject({ action: z.literal('unlike'), item: z.uuid() }),
  z.strictObject({
    action: z.literal('enquire'),
    item: z.uuid().optional(),
    message: z.string().trim().min(1).max(SELECTION_LIMITS.enquiryChars),
  }),
]);
export type SelectionPageAction = z.infer<typeof SelectionPageAction>;
