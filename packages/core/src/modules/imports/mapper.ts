/**
 * The visual mapper's use cases (S6-04, PATTERNS §7): a sample from an upload or a URL, a preview of a mapping on
 * the sample records, a dry run, and the saved mapping profiles. Admins only (`imports.manage`).
 *
 * Requests stay small and bounded: the sample is at most `MAPPER_SAMPLE.maxBytes` read from the upload body or the
 * head of a URL (`safeFetch`, short deadline, rate limited per route), the preview and the dry run work on the
 * sample's records (≤ 25) that the client sends back. The dry run reads the taxonomy and the connection's listings
 * and writes nothing: no listing, no staff-queue entry, no outbox event.
 */
import {
  AppError,
  type CreateMappingProfileBody,
  FeedListing,
  type ListMappingProfilesQuery,
  MAPPER_REPORT_ROWS,
  type MapperDryRunBody,
  type MapperDryRunDto,
  type MapperPreviewBody,
  type MapperPreviewDto,
  type MapperSampleDto,
  type MapperSampleUrlBody,
  type MappingProfileDto,
  type MappingProfilePage,
  type MappingProfileSummaryDto,
  type UpdateMappingProfileBody,
  XML_MAPPED_CONNECTOR,
  XmlMapping,
} from '@inmolink/contracts';
import { newId } from '@inmolink/platform/ids';
import { isSafeFetchError } from '@inmolink/platform/safe-fetch';
import type { Ctx, CtxRunner } from '../../context';
import { decodeCursor, encodeCursor } from '../../pagination';
import * as compliance from '../compliance';
import * as properties from '../properties';
import * as taxonomy from '../taxonomy';
import { FeedHttpStatusError, feedListingProblems, getConnector } from './connectors';
import { type Kind, type Parsed, resolveTaxonomy, sourceOf, type TaxonomyResolver } from './load';
import { assertCan } from './policy';
import * as repo from './repo';
import { assertSecretsOverTls } from './service';
import { mapXmlRecord, type XmlMappedSettings, xmlMappedSettings } from './xml-mapped/mapping';
import { analyzeSample, fetchSampleBytes } from './xml-mapped/sample';

const SETTINGS: XmlMappedSettings = xmlMappedSettings({});

// ── Samples ────────────────────────────────────────────────────────────────────────────────────────────────────

/** `POST /v1/imports/mapper/sample` (raw body): the uploaded bytes are checked by magic bytes, then read. */
export async function sampleFromUpload(
  run: CtxRunner,
  bytes: Uint8Array,
  opts: { recordElement?: string | undefined },
): Promise<MapperSampleDto> {
  await run(async (ctx) => assertCan(ctx, 'imports.manage')); // a short transaction; the parse runs outside it
  return analyzeSample(bytes, opts.recordElement ? { recordElement: opts.recordElement } : {});
}

/** `POST /v1/imports/mapper/sample-url`: the head of a feed URL (SSRF-checked fetch). */
export async function sampleFromUrl(run: CtxRunner, input: MapperSampleUrlBody): Promise<MapperSampleDto> {
  // The authorization is its own short transaction: the fetch never runs inside one (CLAUDE.md rule 6).
  await run(async (ctx) => assertCan(ctx, 'imports.manage'));
  // Credentials only ever go over TLS, here as in a saved connection.
  assertSecretsOverTls(input.url, Boolean(input.credentials));
  let fetched: Awaited<ReturnType<typeof fetchSampleBytes>>;
  try {
    fetched = await fetchSampleBytes(input.url, input.credentials ?? null);
  } catch (err) {
    if (isSafeFetchError(err)) {
      // No detail about why a destination is blocked: which internal names resolve where stays private.
      const blocked = err.code === 'INVALID_URL' || err.code === 'BLOCKED_DESTINATION';
      throw blocked ? new AppError('FEED_URL_NOT_ALLOWED') : new AppError('FEED_SAMPLE_INVALID', { reason: err.code });
    }
    if (err instanceof FeedHttpStatusError) throw new AppError('FEED_SAMPLE_INVALID', { reason: `HTTP_${err.status}` });
    throw err;
  }
  return analyzeSample(fetched.bytes, {
    ...(input.recordElement ? { recordElement: input.recordElement } : {}),
    truncated: fetched.truncated,
  });
}

// ── Preview and dry run ────────────────────────────────────────────────────────────────────────────────────────

interface Mapped {
  position: number;
  ref: string | null;
  listing: FeedListing | null;
  problems: { code: string; field: string | null; message: string | null }[];
}

/** Maps every record and checks the result as the run would (`map` → `validate` → the `FeedListing` contract). */
function mapRecords(mapping: XmlMapping, records: MapperPreviewBody['records']): Mapped[] {
  const seen = new Set<string>();
  return records.map((record, position) => {
    const refused = (
      ref: string | null,
      p: { code: string; field?: string | undefined; message?: string | undefined },
    ): Mapped => ({
      position,
      ref,
      listing: null,
      problems: [{ code: p.code, field: p.field ?? null, message: p.message ?? null }],
    });
    const mapped = mapXmlRecord(record, mapping, SETTINGS);
    if (!mapped.ok) return refused(mapped.ref ?? null, mapped.problems[0] ?? { code: 'INVALID_ITEM' });
    if (seen.has(mapped.ref)) return refused(mapped.ref, { code: 'DUPLICATE_REF', field: 'ref' });
    const problems = feedListingProblems(mapped.item);
    if (problems[0]) return refused(mapped.ref, problems[0]);
    seen.add(mapped.ref);
    return {
      position,
      ref: mapped.ref,
      listing: FeedListing.parse({ ...mapped.item, ref: mapped.ref }),
      problems: [],
    };
  });
}

/** `POST /v1/imports/mapper/preview`: the first records as the import would read them. Writes and reads nothing. */
export async function previewMapping(ctx: Ctx, input: MapperPreviewBody): Promise<MapperPreviewDto> {
  assertCan(ctx, 'imports.manage');
  const mapped = mapRecords(input.mapping, input.records);
  return {
    items: mapped.map((m) => ({
      position: m.position,
      ref: m.ref,
      listing: m.listing as Record<string, unknown> | null,
      problems: m.problems,
    })),
  };
}

/** Taxonomy lookups that never queue anything for staff: it counts what has no match instead. */
class ReadOnlyResolver implements TaxonomyResolver {
  readonly unmatched = new Map<string, { kind: Kind; text: string; count: number }>();

  async resolve(
    tx: Parameters<TaxonomyResolver['resolve']>[0],
    kind: Kind,
    values: readonly { text: string; example: string }[],
    hints: taxonomy.ResolveHints = {},
  ) {
    const results = await taxonomy.resolveMany(
      tx,
      kind,
      values.map((v) => v.text),
      hints,
    );
    return results.map((r, i) => {
      if (r.id) return r.id;
      const text = values[i]?.text ?? '';
      const key = `${kind}|${taxonomy.aliasKey(text)}`;
      const entry = this.unmatched.get(key) ?? { kind, text, count: 0 };
      entry.count++;
      this.unmatched.set(key, entry);
      return null;
    });
  }
}

/**
 * `POST /v1/imports/mapper/dry-run`: what an import of these records would do — how many would be created, updated
 * (with a connection: its listings are looked up by feed reference), held as DRAFT for taxonomy that does not match
 * yet, or refused with the first problem of each — and the unmatched taxonomy values. Nothing is written.
 */
export async function dryRunMapping(ctx: Ctx, input: MapperDryRunBody): Promise<MapperDryRunDto> {
  assertCan(ctx, 'imports.manage');
  const connection = input.connectionId ? await repo.getConnection(ctx.tx, input.connectionId) : null;
  if (input.connectionId && !connection) throw new AppError('FEED_CONNECTION_NOT_FOUND');
  if (connection && !getConnector(connection.connector)?.requiresMapping) {
    throw new AppError('FEED_MAPPING_INVALID', { reason: 'WRONG_CONNECTOR' });
  }
  const mapped = mapRecords(input.mapping, input.records);
  const good: Parsed[] = mapped.flatMap((m) => (m.listing ? [{ position: m.position, listing: m.listing }] : []));
  const resolver = new ReadOnlyResolver();
  // Level by level, one lookup per level: the cost does not grow with the records (see `resolveTaxonomy`).
  const resolved = good.length > 0 ? await resolveTaxonomy(ctx.tx, resolver, good, { levelOnly: true }) : [];
  const wouldHold = resolved.filter((r) => r.held.length > 0).length;
  const existing = connection
    ? await properties.existingImportRefs(
        ctx.tx,
        { agencyId: ctx.tenant.agencyId, source: sourceOf(connection.connector), connectionId: connection.id },
        good.map((g) => g.listing.ref),
      )
    : new Set<string>();
  const wouldUpdate = good.filter((g) => existing.has(g.listing.ref)).length;
  const refusedRows = mapped.filter((m) => !m.listing);
  return {
    total: mapped.length,
    valid: good.length,
    wouldCreate: good.length - wouldUpdate,
    wouldUpdate,
    wouldHold,
    refused: refusedRows.length,
    refusals: refusedRows.slice(0, MAPPER_REPORT_ROWS).map((m) => ({
      position: m.position,
      itemRef: m.ref,
      problem: m.problems[0] ?? { code: 'INVALID_ITEM', field: null, message: null },
    })),
    unmatched: [...resolver.unmatched.values()].sort((a, b) => b.count - a.count).slice(0, 100),
    comparedWithConnection: connection !== null,
  };
}

// ── Mapping profiles ───────────────────────────────────────────────────────────────────────────────────────────

function toSummary(row: repo.ProfileSummary): MappingProfileSummaryDto {
  return {
    id: row.id,
    name: row.name,
    connector: row.connector,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toProfileDto(row: repo.ProfileView): MappingProfileDto {
  return {
    id: row.id,
    name: row.name,
    connector: row.connector,
    mapping: XmlMapping.parse(row.mapping),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function validMapping(mapping: unknown): XmlMapping {
  const parsed = XmlMapping.safeParse(mapping);
  if (!parsed.success) throw new AppError('FEED_MAPPING_INVALID');
  return parsed.data;
}

/** `POST /v1/imports/mapping-profiles` (admins): the mapper's "save". */
export async function createMappingProfile(ctx: Ctx, input: CreateMappingProfileBody): Promise<MappingProfileDto> {
  assertCan(ctx, 'imports.manage');
  const id = newId();
  const row = await repo.insertProfile(ctx.tx, {
    id,
    agencyId: ctx.tenant.agencyId,
    name: input.name,
    connector: input.connector ?? XML_MAPPED_CONNECTOR,
    mapping: validMapping(input.mapping),
  });
  await compliance.audit(ctx, 'imports.mappingProfile.created', { type: 'feedMappingProfile', id }, {});
  return toProfileDto(row);
}

export async function getMappingProfile(ctx: Ctx, id: string): Promise<MappingProfileDto> {
  assertCan(ctx, 'imports.read');
  const row = await repo.getProfile(ctx.tx, id);
  if (!row) throw new AppError('FEED_MAPPING_PROFILE_NOT_FOUND');
  return toProfileDto(row);
}

export async function listMappingProfiles(ctx: Ctx, q: ListMappingProfilesQuery): Promise<MappingProfilePage> {
  assertCan(ctx, 'imports.read');
  const page = await repo.listProfiles(ctx.tx, ctx.tenant.agencyId, {
    limit: q.limit,
    cursor: decodeCursor(q.cursor),
    connector: q.connector ?? XML_MAPPED_CONNECTOR,
  });
  const last = page.items.at(-1);
  return {
    items: page.items.map(toSummary),
    nextCursor: page.hasMore && last ? encodeCursor({ at: last.createdAt, id: last.id }) : null,
  };
}

/** `PATCH /v1/imports/mapping-profiles/:id` (admins, optimistic concurrency): the next run of its connections uses it. */
export async function updateMappingProfile(
  ctx: Ctx,
  id: string,
  input: UpdateMappingProfileBody,
): Promise<MappingProfileDto> {
  assertCan(ctx, 'imports.manage');
  const current = await repo.getProfileForUpdate(ctx.tx, id);
  if (!current) throw new AppError('FEED_MAPPING_PROFILE_NOT_FOUND');
  if (current.version !== input.version) throw new AppError('VERSION_CONFLICT');
  const updated = await repo.updateProfileWithVersion(ctx.tx, id, input.version, {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.mapping !== undefined ? { mapping: validMapping(input.mapping) } : {}),
  });
  if (!updated) throw new AppError('VERSION_CONFLICT');
  await compliance.audit(
    ctx,
    'imports.mappingProfile.changed',
    { type: 'feedMappingProfile', id },
    { changed: Object.keys(input).filter((k) => k !== 'version') },
  );
  return toProfileDto(updated);
}
