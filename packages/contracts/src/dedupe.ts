/** dedupe DTOs (PATTERNS §9): Zod schemas and inferred types for params, bodies and responses. */
import { z } from 'zod';
import { PageQuery, pageOf } from './common';
import { ListingCardDoc, NetworkCommission, ReadModelPrice } from './search';

/**
 * R2-03a: a duplicate candidate pair's signals, each 0–1 (null: not available for the pair), as stored with its
 * score. R2-03b's review queue shows them.
 */
export const DedupePairSignals = z.object({
  images: z.number().min(0).max(1).nullable(),
  phash: z.number().min(0).max(1).nullable(),
  geo: z.number().min(0).max(1).nullable(),
  type: z.number().min(0).max(1),
  beds: z.number().min(0).max(1).nullable(),
  baths: z.number().min(0).max(1).nullable(),
  area: z.number().min(0).max(1).nullable(),
  price: z.number().min(0).max(1).nullable(),
  text: z.number().min(0).max(1).nullable(),
});
export type DedupePairSignals = z.infer<typeof DedupePairSignals>;

/* ------------------------------------------------------------------ R2-03b: review queue, clusters, disputes */

/** A duplicate review's state: waiting, or decided by a member of the agency (a "not a duplicate" is final). */
export const DEDUPE_REVIEW_STATUSES = ['PENDING', 'CONFIRMED', 'NOT_DUPLICATE'] as const;
export const DedupeReviewStatus = z.enum(DEDUPE_REVIEW_STATUSES);
export type DedupeReviewStatus = z.infer<typeof DedupeReviewStatus>;

/** A listing card in the duplicate views: as network search shows it (never the owner, commission or portal extras). */
export const DedupeListingCard = ListingCardDoc.omit({ portalText: true, portalTerraceM2: true });
export type DedupeListingCard = z.infer<typeof DedupeListingCard>;

/** `GET /v1/duplicates/reviews`: the agency's pairs to review (or decided ones), newest first (keyset, ≤ 100). */
export const ListDedupeReviewsQuery = PageQuery.extend({
  status: DedupeReviewStatus.default('PENDING'),
}).strict();
export type ListDedupeReviewsQuery = z.input<typeof ListDedupeReviewsQuery>;

/**
 * A pair in the review queue (member-facing): the agency's own listing, the other one as far as the caller may see it
 * (another agency's, `network`, or its own), the score and its signals. The other listing's owner is never named.
 */
export const DedupeReviewDto = z.strictObject({
  id: z.uuid(),
  status: DedupeReviewStatus,
  /** 0–1. */
  score: z.number(),
  signals: DedupePairSignals,
  listing: DedupeListingCard,
  other: z.strictObject({ network: z.boolean(), card: DedupeListingCard }),
  decidedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type DedupeReviewDto = z.infer<typeof DedupeReviewDto>;

export const DedupeReviewPage = pageOf(DedupeReviewDto);
export type DedupeReviewPage = z.infer<typeof DedupeReviewPage>;

export const DedupeReviewParams = z.strictObject({ id: z.uuid() });
export type DedupeReviewParams = z.infer<typeof DedupeReviewParams>;

/** `POST /v1/duplicates/reviews/:id/confirm` · `/not-duplicate`: the review after the decision. */
export const DedupeReviewMoveDto = z.strictObject({ id: z.uuid(), status: DedupeReviewStatus });
export type DedupeReviewMoveDto = z.infer<typeof DedupeReviewMoveDto>;

/** `GET /v1/duplicates/clusters`: the agency's listings in a duplicate cluster, newest first (keyset, ≤ 100). */
export const ListDedupeClustersQuery = PageQuery.strict();
export type ListDedupeClustersQuery = z.input<typeof ListDedupeClustersQuery>;

export const DEDUPE_DISPUTE_KINDS = ['NOT_DUPLICATE', 'CANONICAL'] as const;
export const DedupeDisputeKind = z.enum(DEDUPE_DISPUTE_KINDS);
export type DedupeDisputeKind = z.infer<typeof DedupeDisputeKind>;

export const DEDUPE_DISPUTE_STATUSES = ['OPEN', 'UPHELD', 'REJECTED'] as const;
export const DedupeDisputeStatus = z.enum(DEDUPE_DISPUTE_STATUSES);
export type DedupeDisputeStatus = z.infer<typeof DedupeDisputeStatus>;

/**
 * One of the agency's clustered listings: the cluster's members the caller may see, in canonical order (its own listing
 * among them), whether its own listing is the first of those (`canonical`: what its clients are shown), how it joined,
 * and its open dispute if any. Members the caller may not see are left out, unnamed and uncounted.
 */
export const DedupeClusterDto = z.strictObject({
  listingId: z.uuid(),
  clusterId: z.uuid(),
  canonical: z.boolean(),
  via: z.enum(['AUTO', 'CONFIRMED']),
  members: z.array(z.strictObject({ own: z.boolean(), network: z.boolean(), card: DedupeListingCard })),
  openDispute: z.strictObject({ id: z.uuid(), kind: DedupeDisputeKind }).nullable(),
  createdAt: z.iso.datetime(),
});
export type DedupeClusterDto = z.infer<typeof DedupeClusterDto>;

export const DedupeClusterPage = pageOf(DedupeClusterDto);
export type DedupeClusterPage = z.infer<typeof DedupeClusterPage>;

/** `POST /v1/duplicates/disputes`: the agency disputes the clustering of its own listing (one open dispute a listing). */
export const OpenDedupeDisputeBody = z.strictObject({
  listingId: z.uuid(),
  kind: DedupeDisputeKind,
  reason: z.string().trim().min(1).max(1000),
});
export type OpenDedupeDisputeBody = z.infer<typeof OpenDedupeDisputeBody>;

export const DedupeDisputeDto = z.strictObject({
  id: z.uuid(),
  listingId: z.uuid(),
  clusterId: z.uuid(),
  kind: DedupeDisputeKind,
  reason: z.string(),
  status: DedupeDisputeStatus,
  resolutionNote: z.string().nullable(),
  createdAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
});
export type DedupeDisputeDto = z.infer<typeof DedupeDisputeDto>;

/** `GET /v1/duplicates/disputes`: the agency's disputes, newest first (keyset, ≤ 100). */
export const ListDedupeDisputesQuery = PageQuery.strict();
export type ListDedupeDisputesQuery = z.input<typeof ListDedupeDisputesQuery>;

export const DedupeDisputePage = pageOf(DedupeDisputeDto);
export type DedupeDisputePage = z.infer<typeof DedupeDisputePage>;

/** `GET /v1/staff/duplicates/disputes`: every agency's disputes of one status, oldest first (keyset, ≤ 100). */
export const StaffDedupeDisputesQuery = PageQuery.extend({ status: DedupeDisputeStatus.default('OPEN') }).strict();
export type StaffDedupeDisputesQuery = z.input<typeof StaffDedupeDisputesQuery>;

/** Staff's view of a dispute: the agency, and the cluster's members now (ids, owners, rank, how they joined). */
export const StaffDedupeDisputeDto = DedupeDisputeDto.extend({
  agency: z.strictObject({ id: z.uuid(), name: z.string() }),
  members: z.array(
    z.strictObject({
      listingId: z.uuid(),
      agencyId: z.uuid(),
      rank: z.number().int(),
      via: z.enum(['AUTO', 'CONFIRMED']),
    }),
  ),
});
export type StaffDedupeDisputeDto = z.infer<typeof StaffDedupeDisputeDto>;

export const StaffDedupeDisputePage = pageOf(StaffDedupeDisputeDto);
export type StaffDedupeDisputePage = z.infer<typeof StaffDedupeDisputePage>;

export const DedupeDisputeParams = z.strictObject({ id: z.uuid() });
export type DedupeDisputeParams = z.infer<typeof DedupeDisputeParams>;

/** `POST /v1/staff/duplicates/disputes/:id/resolve`: uphold (applied by the worker) or reject, with a note (audited). */
export const ResolveDedupeDisputeBody = z.strictObject({
  outcome: z.enum(['UPHELD', 'REJECTED']),
  note: z.string().trim().min(1).max(1000),
});
export type ResolveDedupeDisputeBody = z.infer<typeof ResolveDedupeDisputeBody>;

/* ------------------------------------------------------------------ R2-03c: "listed by N agencies" */

/** Listings one `GET /v1/duplicates/listed-by` asks about at most (a page of results). */
export const DEDUPE_LISTED_BY_MAX = 50;

const UUID_LIST = z
  .string()
  .max(DEDUPE_LISTED_BY_MAX * 37)
  .transform((v) => [...new Set(v.split(',').filter((x) => x.length > 0))])
  .pipe(z.array(z.uuid()).min(1).max(DEDUPE_LISTED_BY_MAX));

/** `GET /v1/duplicates/listed-by?listingIds=a,b`: the duplicates of these listings the caller may see. */
export const DedupeListedByQuery = z.strictObject({ listingIds: UUID_LIST });
export type DedupeListedByQuery = z.input<typeof DedupeListedByQuery>;

/** The service's input: the listing ids (the query's parsed form). */
export const DedupeListedByInput = z.strictObject({
  listingIds: z.array(z.uuid()).min(1).max(DEDUPE_LISTED_BY_MAX),
});
export type DedupeListedByInput = z.input<typeof DedupeListedByInput>;

/**
 * One listing of a duplicate cluster as an agent sees it beside the others (PLAN §10 "agents see listed by N agencies
 * with each agency's terms"): the caller's own (`own`: no agency, no network commission) or another agency's network
 * listing it may see — the agency as the network directory names it and the commission as network search shows it.
 * `canonical`: the first of the members the caller may see in canonical order (what its clients are shown).
 */
export const DedupeListedByMember = z.strictObject({
  listingId: z.uuid(),
  own: z.boolean(),
  canonical: z.boolean(),
  reference: z.string(),
  agency: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
  price: ReadModelPrice,
  commission: NetworkCommission.nullable(),
});
export type DedupeListedByMember = z.infer<typeof DedupeListedByMember>;

/**
 * A listing that is one of several the caller may see in one cluster: how many agencies list it (`agencies`, among the
 * members shown) and every member with its terms, in canonical order. Listings with no other visible member are left
 * out (a member the caller may not see is never named or counted).
 */
export const DedupeListedBy = z.strictObject({
  listingId: z.uuid(),
  agencies: z.number().int().min(1),
  members: z.array(DedupeListedByMember).min(2),
});
export type DedupeListedBy = z.infer<typeof DedupeListedBy>;

export const DedupeListedByResult = z.strictObject({ items: z.array(DedupeListedBy) });
export type DedupeListedByResult = z.infer<typeof DedupeListedByResult>;
