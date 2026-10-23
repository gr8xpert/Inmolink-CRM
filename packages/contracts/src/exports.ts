/**
 * Portal syndication (S9-01, PLAN §7 M7): the portals an agency can feed, its connections to them and which listings
 * each connection sends. Writers (S9-02) and the generator (S9-03) build on the selection rules defined here.
 */
import { z } from 'zod';
import { Cursor, PageQuery, pageOf } from './common';
import { ListingTag } from './properties';

/** AVAILABLE: can be connected · PLANNED: listed, waiting for the portal's partner approval (idealista, Fotocasa). */
export const PortalChannelStatus = z.enum(['AVAILABLE', 'PLANNED']);
export type PortalChannelStatus = z.infer<typeof PortalChannelStatus>;

/** All PUBLIC listings · the listings carrying `selectionTag` · only the listings chosen with INCLUDE. */
export const PortalSelectionMode = z.enum(['ALL_PUBLIC', 'TAGGED', 'MANUAL']);
export type PortalSelectionMode = z.infer<typeof PortalSelectionMode>;

export const PortalOverrideAction = z.enum(['INCLUDE', 'EXCLUDE']);
export type PortalOverrideAction = z.infer<typeof PortalOverrideAction>;

/** At most this many connections per agency, and per-property choices per connection. */
export const MAX_PORTAL_CONNECTIONS = 20;
export const MAX_CONNECTION_OVERRIDES = 10_000;
/** Per-property choices changed in one request. */
export const MAX_OVERRIDES_PER_REQUEST = 200;

export const PortalChannelDto = z.strictObject({
  code: z.string(),
  name: z.string(),
  status: PortalChannelStatus,
  /** The credential keys a connection may store for this portal (all optional). */
  credentialFields: z.array(z.string()),
});
export type PortalChannelDto = z.infer<typeof PortalChannelDto>;
export const PortalChannelList = z.strictObject({ items: z.array(PortalChannelDto) });
export type PortalChannelList = z.infer<typeof PortalChannelList>;

/** Credentials as sent: key to value (non-empty, at most 500 characters), up to 10 keys. Stored encrypted. */
export const PortalCredentials = z
  .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/), z.string().min(1).max(500))
  .refine((c) => Object.keys(c).length <= 10, { message: 'at most 10 credentials' });
export type PortalCredentials = z.infer<typeof PortalCredentials>;

/** A rule: TAGGED needs `tag`, the other modes must not have one. */
export const PortalSelection = z
  .strictObject({ mode: PortalSelectionMode, tag: ListingTag.nullable().default(null) })
  .superRefine((v, ctx) => {
    if ((v.mode === 'TAGGED') !== (v.tag !== null)) {
      ctx.addIssue({ code: 'custom', path: ['tag'], message: 'a tag is required for TAGGED and only then' });
    }
  });
export type PortalSelection = z.infer<typeof PortalSelection>;

const connectionName = z.string().trim().min(1).max(80);

export const CreatePortalConnectionBody = z.strictObject({
  channelCode: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name: connectionName,
  selection: PortalSelection.default({ mode: 'ALL_PUBLIC', tag: null }),
  credentials: PortalCredentials.optional(),
});
export type CreatePortalConnectionInput = z.infer<typeof CreatePortalConnectionBody>;

/** `version` is the one the edit was made on. `credentials`: replaces them; `null` removes them; absent keeps them. */
export const UpdatePortalConnectionBody = z.strictObject({
  version: z.number().int().min(1),
  name: connectionName.optional(),
  enabled: z.boolean().optional(),
  selection: PortalSelection.optional(),
  credentials: PortalCredentials.nullable().optional(),
});
export type UpdatePortalConnectionInput = z.infer<typeof UpdatePortalConnectionBody>;

export const PortalConnectionParams = z.object({ connectionId: z.uuid() });
export type PortalConnectionParams = z.infer<typeof PortalConnectionParams>;

/** A connection as the dashboard shows it: never the token, only its last characters; never the credentials. */
export const PortalConnectionDto = z.strictObject({
  id: z.uuid(),
  channelCode: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  selection: PortalSelection,
  /** The keys of the stored credentials (never their values); empty: none. */
  credentialKeys: z.array(z.string()),
  /** false: the token was revoked (the feed URL answers 404 until it is rotated). */
  tokenActive: z.boolean(),
  tokenHint: z.string(),
  tokenCreatedAt: z.iso.datetime(),
  /** Per-property choices: how many listings are always sent / never sent. */
  includeCount: z.number().int(),
  excludeCount: z.number().int(),
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type PortalConnectionDto = z.infer<typeof PortalConnectionDto>;
export const PortalConnectionPage = pageOf(PortalConnectionDto);
export type PortalConnectionPage = z.infer<typeof PortalConnectionPage>;

/** A connection with its new token (creation, rotation): shown once. */
export const PortalConnectionSecretDto = z.strictObject({
  connection: PortalConnectionDto,
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type PortalConnectionSecretDto = z.infer<typeof PortalConnectionSecretDto>;

/** A listing by id or by its reference (case-insensitive; exactly one of the two) and what to do with it. */
export const PortalOverrideItem = z
  .strictObject({
    propertyId: z.uuid().optional(),
    ref: z.string().trim().min(1).max(40).optional(),
    /** INCLUDE / EXCLUDE; `null` clears the choice (the rule decides again). */
    action: PortalOverrideAction.nullable(),
  })
  .refine((i) => (i.propertyId === undefined) !== (i.ref === undefined), {
    message: 'exactly one of propertyId and ref',
  });
export const SetPortalOverridesBody = z
  .strictObject({ items: z.array(PortalOverrideItem).min(1).max(MAX_OVERRIDES_PER_REQUEST) })
  .refine(
    (b) => {
      const keys = b.items.map((i) => i.propertyId ?? (i.ref as string).toUpperCase());
      return new Set(keys).size === keys.length;
    },
    { message: 'duplicate listing' },
  );
export type SetPortalOverridesInput = z.infer<typeof SetPortalOverridesBody>;

export const ListPortalOverridesQuery = PageQuery.extend({ action: PortalOverrideAction.optional() }).strict();
export type ListPortalOverridesQuery = z.infer<typeof ListPortalOverridesQuery>;

export const PortalOverrideDto = z.strictObject({
  propertyId: z.uuid(),
  ref: z.string().nullable(),
  action: PortalOverrideAction,
});
export type PortalOverrideDto = z.infer<typeof PortalOverrideDto>;
export const PortalOverridePage = pageOf(PortalOverrideDto);
export type PortalOverridePage = z.infer<typeof PortalOverridePage>;

/** `GET .../selection`: a page of the listings the connection sends now (dashboard preview); keyset by listing id. */
export const PortalSelectionQuery = z.object({
  cursor: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type PortalSelectionQuery = z.infer<typeof PortalSelectionQuery>;
export const PortalSelectedListingDto = z.strictObject({ propertyId: z.uuid(), ref: z.string().nullable() });
export const PortalSelectionPage = pageOf(PortalSelectedListingDto);
export type PortalSelectionPage = z.infer<typeof PortalSelectionPage>;
