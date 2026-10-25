import { PUBLIC_SEARCH_STATUSES } from '@inmolink/contracts';
import { type Tx, withSystem } from '@inmolink/db';
import { type AiCtx, ai, aiOrFallback, untrustedBlock } from '@inmolink/platform/ai';
import { clock } from '@inmolink/platform/clock';
import type { ErrorCode } from '@inmolink/platform/errors';
import { z } from 'zod';
import {
  acceptRemovals,
  compileOwner,
  DETAIL_TEXT_PATHS,
  detailAt,
  NO_OWNER,
  type OwnerIdentity,
  type OwnerMatcher,
  ownerRefsOf,
  plainText,
  type RemovalGuard,
  textKey,
} from '../../white-label';
import { type AiRemovalsEntry, readAiRemovalEntries, writeAiRemovals } from '../../white-label-store';
import * as agencies from '../agencies';
import * as search from '../search';
import * as websiteApi from '../website-api';

/**
 * The white-label sanitizer's model pass (S12-03, PLAN §8 #2): after the deterministic pass (`white-label.ts`:
 * e-mails, URLs, phone numbers, tax ids, the owner's names, handles), a FAST model names what still points buyers at
 * the owner agency indirectly — an agent's first name, the office opposite the church, a number spelled out. It
 * answers with exact parts of the text to remove (never rewritten text), each checked against the text it is applied
 * to (`acceptRemovals`: whole words that occur in it, no digit, no fact in words, no place or development name, at
 * most half the text), so the facts stay unchanged by construction. The texts go to the model as untrusted blocks
 * (prompt injection: an owner's text is data, never instructions).
 *
 * Runs in the `ai` worker pool only (`aiFeatures.sanitizeTexts`, one job per `search.publicDocs.changed` event), and
 * asks only for documents network sites show (public, in a shown status, not hidden from the network). The result is
 * cached per (owner, target) with the read model version (`white-label-store.ts`) and every serving path applies it
 * by target and `textKey` — a text the worker has not seen yet, or with the model unavailable or over budget, is
 * served with the deterministic pass alone. A target whose removals changed has its edge pages purged.
 *
 * S13-F7: the event names only the targets network sites show with text new to them (`networkShownIds`); documents
 * shown before the pass existed, or whose pass degraded, get it from the backfill walk (`whiteLabelBackfillPage`).
 * The search index documents are NOT cleaned with these removals: they are built in the read-model transaction, before
 * any model pass (the pass runs later, outside it), so applying them would need a second index push per answered
 * target, and the index text is only matched, never shown — a buyer-facing page always renders the cleaned text. The
 * deterministic pass already strips the owner's identity from the index text (S7-F5); a free-text query for an
 * agent's first name can still match a network document (it reveals nothing that page shows).
 *
 * S13-F17: only for an owner agency that switched `WHITE_LABEL` on (`agencies.aiFeatureEnabled`, cached). Off, the
 * event's run, its retries and the backfill read nothing and call no model (`disabled`), queue no retry and end the
 * agency's walk: serving paths apply the deterministic pass (and removals cached while it was on).
 */

export const WHITE_LABEL_FEATURE = 'white-label.sanitize';
export const WHITE_LABEL_PROMPT = { id: 'white-label', version: 1 } as const;

/** The model's answer: exact parts of the texts to remove. */
export const WhiteLabelRemovals = z.object({ remove: z.array(z.string().max(1_000)).max(60) });
export type WhiteLabelRemovals = z.infer<typeof WhiteLabelRemovals>;

/** Shorter cleaned texts are not sent (a title fragment or a word cannot hold an indirect mention worth a call). */
export const MIN_MODEL_TEXT_CHARS = 25;
/**
 * Longest part of a text sent (characters): a longer description is checked on its first part only. Parts are still
 * checked against (and applied to) the whole text.
 */
export const MAX_MODEL_TEXT_CHARS = 6_000;
/** Model calls one job runs at once. */
const CALL_CONCURRENCY = 4;
/** The untrusted block name of each text in the model's input. */
export const WHITE_LABEL_BLOCK = 'listing_text';

const SHOWN_STATUSES: ReadonlySet<string> = new Set(PUBLIC_SEARCH_STATUSES);

/** A document's texts the serializer white-labels (titles, descriptions, payment terms, meta texts). */
export function docTexts(detail: unknown): string[] {
  if (!detail || typeof detail !== 'object') return [];
  // S13-F7: the same paths the read-model upsert compares to tell a text change (`DETAIL_TEXT_PATHS`).
  const texts = DETAIL_TEXT_PATHS.map((path) => detailAt(detail, path));
  return texts.filter((t): t is string => typeof t === 'string' && t.trim() !== '');
}

const nameOf = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>).name : undefined);

/** A document's place and development names: no removal may touch them (`RemovalGuard`). */
export function protectedNamesOf(detail: unknown): string[] {
  if (!detail || typeof detail !== 'object') return [];
  const d = detail as Record<string, unknown>;
  const place = (d.place ?? {}) as Record<string, unknown>;
  const names = [
    nameOf(place.country),
    nameOf(place.region),
    nameOf(place.city),
    nameOf(place.area),
    nameOf(d.development),
    nameOf(d.phase),
  ];
  return names.filter((n): n is string => typeof n === 'string' && n.trim() !== '');
}

/**
 * One text as the model sees it: the deterministic pass's whole output (what removals are checked against and applied
 * to), the part sent, and the key serving paths look it up by.
 */
export interface PreparedText {
  key: string;
  clean: string;
  sent: string;
}

/** A document's texts cleaned by the deterministic pass (as serving paths clean them), those worth a model call. */
export function prepareTexts(
  matcher: OwnerMatcher,
  ownerRefs: readonly string[],
  sources: readonly string[],
): PreparedText[] {
  const out = new Map<string, PreparedText>();
  for (const source of sources) {
    const plain = plainText(source);
    const key = textKey(plain);
    if (out.has(key)) continue;
    const clean = matcher.clean(plain, ownerRefs);
    if (clean.length >= MIN_MODEL_TEXT_CHARS) out.set(key, { key, clean, sent: clean.slice(0, MAX_MODEL_TEXT_CHARS) });
  }
  return [...out.values()];
}

/**
 * The model's parts sorted to the texts they occur in, each text's set checked against that whole text
 * (`acceptRemovals`); a text whose set fails the check gets none (deterministic only). Every text is in the result
 * (empty: nothing to remove).
 */
export function removalsByText(
  texts: readonly PreparedText[],
  spans: readonly string[],
  guard: RemovalGuard = {},
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const t of texts) out[t.key] = acceptRemovals(t.clean, spans, guard) ?? [];
  return out;
}

/** The model's input: each text as an untrusted block (escaped, nonce-tagged), numbered. */
export function modelInput(texts: readonly PreparedText[]): string {
  return [
    `Texts to check: ${texts.length}.`,
    ...texts.map((t, i) => `Text ${i + 1}:\n${untrustedBlock(WHITE_LABEL_BLOCK, t.sent)}`),
  ].join('\n\n');
}

/** A part copied from an untrusted block, as the text has it (`&lt;` `&gt;` `&amp;` unescaped). */
export const unescapeBlockText = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * Asks the model for one document's texts; null when the gateway degrades (outage, budget, refusal, bad output).
 * Module-internal (S13-F17): its callers check the agency's WHITE_LABEL toggle first (not exported from the module).
 */
export async function modelRemovals(
  ctx: AiCtx,
  texts: readonly PreparedText[],
  onDegrade?: (code: ErrorCode) => void,
): Promise<string[] | null> {
  if (texts.length === 0) return [];
  return aiOrFallback(
    async () =>
      (
        await ai.structured(ctx, {
          feature: WHITE_LABEL_FEATURE,
          prompt: WHITE_LABEL_PROMPT,
          // Only the cleaned texts, as untrusted data: no identity, contact or id goes to the provider (PLAN §8).
          input: modelInput(texts),
          schema: WhiteLabelRemovals,
        })
      ).data.remove.map(unescapeBlockText),
    (code) => {
      onDegrade?.(code);
      return null;
    },
  );
}

/** Whether a target's entry already answers all its current texts with this prompt version. */
const answered = (entry: AiRemovalsEntry | undefined, texts: readonly PreparedText[]) =>
  !!entry && entry.prompt === WHITE_LABEL_PROMPT.version && texts.every((t) => t.key in entry.texts);

async function eachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  });
  await Promise.all(lanes);
}

/**
 * Writes a target's answered texts: an entry when the model found something, the old entry dropped when it found
 * nothing now. An entry of a newer read model version (another run's) is kept. Answers what changed.
 */
async function storeTargetRemovals(
  target: { agencyId: string; targetId: string },
  before: AiRemovalsEntry | undefined,
  version: number,
  texts: Record<string, string[]>,
): Promise<'STORED' | 'DROPPED' | 'NONE'> {
  if (before && before.version > version) return 'NONE';
  if (Object.values(texts).some((s) => s.length > 0)) {
    await writeAiRemovals(target, { version, prompt: WHITE_LABEL_PROMPT.version, texts });
    return 'STORED';
  }
  if (before && Object.keys(texts).length > 0) {
    await writeAiRemovals(target, null);
    return 'DROPPED';
  }
  return 'NONE';
}

export interface SanitizeTextsResult {
  /** Documents (target × locale) of the agency looked at. */
  docs: number;
  /** Documents sent to the model (or its response cache). */
  asked: number;
  /** Targets with cached removals written. */
  stored: number;
  /** Documents left deterministic-only because the gateway degraded. */
  degraded: number;
  /** S13-F7: the targets with such a document (the job asks again for them later). */
  degradedTargetIds: string[];
  /** S13-F17: the owner agency has the model pass switched off: nothing was read or asked. */
  disabled?: true;
}

const DISABLED: SanitizeTextsResult = {
  docs: 0,
  asked: 0,
  stored: 0,
  degraded: 0,
  degradedTargetIds: [],
  disabled: true,
};

/** S13-F17: whether the owner agency switched the white-label model pass on (cached read). */
export const whiteLabelModelOn = (agencyId: string): Promise<boolean> =>
  agencies.aiFeatureEnabled(agencyId, 'WHITE_LABEL');

type DocRow = Awaited<ReturnType<typeof search.readModelDocs>>[number];

/** Whether network sites show a document (the website search's rule): public, a shown status, not network-hidden. */
export const shownOnNetwork = (row: Pick<DocRow, 'public' | 'status' | 'networkHidden'>): boolean =>
  row.public && !row.networkHidden && SHOWN_STATUSES.has(row.status);

/** The owner's documents and identity, read in one short system transaction. */
interface OwnerDocs {
  rows: DocRow[];
  identity: OwnerIdentity;
}

type SanitizeOptions = { requestId?: string; onDegrade?: (code: ErrorCode) => void };

/**
 * `aiFeatures.sanitizeTexts`: the model pass over one owner agency's changed documents (every locale built). Reads
 * the documents and the owner's identity in one short system transaction, then — outside any transaction — asks the
 * model per document (one call per locale's texts) of the shown targets not answered yet, writes one cache entry per
 * target and purges the edge pages of the targets whose removals changed. Idempotent: a repeated run finds the
 * entries answered (or the gateway's response cache answers).
 */
export async function sanitizeTargetTexts(
  input: { agencyId: string; targetIds: readonly string[] },
  options: SanitizeOptions = {},
): Promise<SanitizeTextsResult> {
  if (!(await whiteLabelModelOn(input.agencyId))) return { ...DISABLED, degradedTargetIds: [] };
  const owner = await withSystem('aiFeatures.sanitizeTexts', async (tx) =>
    ownerDocs(tx, input.agencyId, await search.readModelDocs(tx, input.targetIds)),
  );
  return sanitizeDocs(input.agencyId, owner, options, { keepAlive: false });
}

async function ownerDocs(tx: Tx, agencyId: string, docs: readonly DocRow[]): Promise<OwnerDocs> {
  const rows = docs.filter((d) => d.agencyId === agencyId);
  const identities = rows.length > 0 ? await agencies.ownerIdentities(tx, [agencyId]) : new Map();
  return { rows, identity: (identities.get(agencyId) as OwnerIdentity | undefined) ?? NO_OWNER };
}

/**
 * The pass over documents already read. `keepAlive` (the backfill): an entry that already answers a target's texts is
 * written again, so its lifetime (`AI_REMOVALS_TTL_SECONDS`) counts from now while the text is shown.
 */
async function sanitizeDocs(
  agencyId: string,
  { rows, identity }: OwnerDocs,
  options: SanitizeOptions,
  { keepAlive }: { keepAlive: boolean },
): Promise<SanitizeTextsResult> {
  const result: SanitizeTextsResult = { docs: rows.length, asked: 0, stored: 0, degraded: 0, degradedTargetIds: [] };
  if (rows.length === 0) return result;
  const matcher = compileOwner(identity);
  const ctx: AiCtx = { tenant: { agencyId }, requestId: options.requestId };

  const byTarget = new Map<string, DocRow[]>();
  for (const r of rows) byTarget.set(r.targetId, [...(byTarget.get(r.targetId) ?? []), r]);
  const existing = await readAiRemovalEntries([...byTarget.keys()].map((targetId) => ({ agencyId, targetId })));
  const prepared = (row: DocRow) => {
    const detail = row.detail as { ref?: unknown };
    const refs = ownerRefsOf({
      ref: typeof detail.ref === 'string' ? detail.ref : '',
      developmentOwnRef: row.developmentOwnRef,
    });
    return { row, texts: prepareTexts(matcher, refs, docTexts(row.detail)), names: protectedNamesOf(row.detail) };
  };

  const changed: string[] = [];
  await eachLimited([...byTarget.entries()], CALL_CONCURRENCY, async ([targetId, docs]) => {
    const target = { agencyId, targetId };
    const before = existing.get(targetId);
    // Only what network sites show is worth a model call (a hidden or private document is never white-labelled).
    const perDoc = docs
      .filter(shownOnNetwork)
      .map(prepared)
      .filter((d) => d.texts.length > 0);
    if (perDoc.length === 0) {
      if (before) await writeAiRemovals(target, null);
      return;
    }
    if (
      before &&
      answered(
        before,
        perDoc.flatMap((d) => d.texts),
      )
    ) {
      if (keepAlive) await writeAiRemovals(target, before);
      return;
    }
    const texts: Record<string, string[]> = {};
    for (const doc of perDoc) {
      result.asked++;
      const spans = await modelRemovals(ctx, doc.texts, options.onDegrade);
      if (spans === null) {
        // Unanswered texts stay out of the entry: the next run asks again.
        result.degraded++;
        if (!result.degradedTargetIds.includes(targetId)) result.degradedTargetIds.push(targetId);
        continue;
      }
      Object.assign(texts, removalsByText(doc.texts, spans, { protectedNames: doc.names }));
    }
    const outcome = await storeTargetRemovals(target, before, Math.max(...perDoc.map((d) => d.row.version)), texts);
    if (outcome === 'STORED') result.stored++;
    if (outcome !== 'NONE') changed.push(targetId);
  });
  // Pages the edge cached with the previous text show the new one within the purge window (S7-06).
  if (changed.length > 0) {
    await websiteApi.queueEdgePurge(
      agencyId,
      changed.map((id) => ({ kind: 't' as const, id })),
      clock.now(),
    );
  }
  return result;
}

/** Targets per backfill page (S13-F7), each with every locale built. */
export const BACKFILL_PAGE_TARGETS = 50;

export type BackfillCursor = search.TargetPosition;

export interface BackfillPageResult extends SanitizeTextsResult {
  /** Network-shown targets of the page. */
  targets: number;
  /** Where the next page starts; null when the agency's walk is done. */
  next: BackfillCursor | null;
}

/**
 * S13-F7: one page of the white-label backfill (`aiFeatures.whiteLabelBackfill`) — documents network sites show that
 * never had the model pass (shown before it existed, a degraded run, an entry about to expire). Reads the agency's next
 * `BACKFILL_PAGE_TARGETS` network-shown targets (keyset on `listing_read_models_agency_idx`), their documents and the
 * owner's identity in one short system transaction, then runs the same pass as the event path: answered targets cost
 * nothing (their entry is kept alive), unchanged texts are answered by the gateway's response cache, only the rest
 * reach the model. Idempotent and resumable by its cursor.
 */
export async function whiteLabelBackfillPage(
  input: { agencyId: string; after: BackfillCursor | null },
  options: SanitizeOptions = {},
): Promise<BackfillPageResult> {
  if (!(await whiteLabelModelOn(input.agencyId))) {
    return { ...DISABLED, degradedTargetIds: [], targets: 0, next: null };
  }
  const { page, owner } = await withSystem('aiFeatures.whiteLabelBackfill', async (tx) => {
    const page = await search.networkShownTargetsPage(tx, input.agencyId, input.after, BACKFILL_PAGE_TARGETS);
    const docs =
      page.length > 0
        ? await search.readModelDocs(
            tx,
            page.map((p) => p.targetId),
          )
        : [];
    return { page, owner: await ownerDocs(tx, input.agencyId, docs) };
  });
  const result = await sanitizeDocs(input.agencyId, owner, options, { keepAlive: true });
  return {
    ...result,
    targets: page.length,
    next: page.length === BACKFILL_PAGE_TARGETS ? (page.at(-1) ?? null) : null,
  };
}
