import { PUBLIC_SEARCH_STATUSES } from '@inmolink/contracts';
import { type Tx, withSystem } from '@inmolink/db';
import { type AiCtx, ai, aiOrFallback, untrustedBlock } from '@inmolink/platform/ai';
import { clock } from '@inmolink/platform/clock';
import { type ErrorCode, isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
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
import * as billing from '../billing';
import * as search from '../search';
import * as websiteApi from '../website-api';
import * as repo from './repo';

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
 *
 * S13-F25: the backfill sends its pages through the provider's batch API (`ai.batch`, half price) instead of
 * `ai.structured` — recorded in `white_label_batches`, answered up to a day later (`collectWhiteLabelBackfill`) — and
 * an owner identity change re-runs the walk at once with `force` (answered targets asked again: the deterministic
 * pass's output they answered changed, e.g. an old agency name it no longer strips).
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
export function modelInput(texts: readonly Pick<PreparedText, 'sent'>[]): string {
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
  /** S13-F21: the owner agency's plan in force (AI budgets per plan); read once per job, only with documents. */
  plan: string | null;
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
  if (rows.length === 0) return { rows, identity: NO_OWNER, plan: null };
  const identities = await agencies.ownerIdentities(tx, [agencyId]);
  return {
    rows,
    identity: (identities.get(agencyId) as OwnerIdentity | undefined) ?? NO_OWNER,
    plan: (await billing.planOf(tx, agencyId)).code,
  };
}

/** A network-shown document's texts worth a model call, with the names no removal may touch. */
interface PreparedDoc {
  row: DocRow;
  texts: PreparedText[];
  names: string[];
}

/** The documents network sites show of each target, cleaned by the deterministic pass (as serving paths clean them). */
function shownDocsByTarget(rows: readonly DocRow[], identity: OwnerIdentity): Map<string, PreparedDoc[]> {
  const matcher = compileOwner(identity);
  const byTarget = new Map<string, PreparedDoc[]>();
  for (const row of rows) {
    if (!byTarget.has(row.targetId)) byTarget.set(row.targetId, []);
    // Only what network sites show is worth a model call (a hidden or private document is never white-labelled).
    if (!shownOnNetwork(row)) continue;
    const detail = row.detail as { ref?: unknown };
    const refs = ownerRefsOf({
      ref: typeof detail.ref === 'string' ? detail.ref : '',
      developmentOwnRef: row.developmentOwnRef,
    });
    const texts = prepareTexts(matcher, refs, docTexts(row.detail));
    if (texts.length > 0) byTarget.get(row.targetId)?.push({ row, texts, names: protectedNamesOf(row.detail) });
  }
  return byTarget;
}

/** A target whose texts the model is asked about, and its cache entry before. */
interface TargetWork {
  targetId: string;
  before: AiRemovalsEntry | undefined;
  docs: PreparedDoc[];
}

/**
 * The targets of these documents still to ask the model about. A target with nothing shown loses its entry; one whose
 * entry answers all its texts is skipped (`keepAlive`: its entry is written again, so its lifetime counts from now) —
 * unless `force` (S13-F25: the owner's identity changed, so the deterministic pass's output the entry answered did).
 */
async function targetsToAsk(
  agencyId: string,
  rows: readonly DocRow[],
  identity: OwnerIdentity,
  { keepAlive, force }: { keepAlive: boolean; force: boolean },
): Promise<TargetWork[]> {
  const byTarget = shownDocsByTarget(rows, identity);
  const existing = await readAiRemovalEntries([...byTarget.keys()].map((targetId) => ({ agencyId, targetId })));
  const work: TargetWork[] = [];
  await eachLimited([...byTarget.entries()], CALL_CONCURRENCY, async ([targetId, docs]) => {
    const target = { agencyId, targetId };
    const before = existing.get(targetId);
    if (docs.length === 0) {
      if (before) await writeAiRemovals(target, null);
      return;
    }
    if (
      !force &&
      before &&
      answered(
        before,
        docs.flatMap((d) => d.texts),
      )
    ) {
      if (keepAlive) await writeAiRemovals(target, before);
      return;
    }
    work.push({ targetId, before, docs });
  });
  // the targets in the order the documents were read (the lanes above finish in any order)
  const order = [...byTarget.keys()];
  return work.sort((x, y) => order.indexOf(x.targetId) - order.indexOf(y.targetId));
}

/**
 * The pass over documents already read. `keepAlive` (the backfill): an entry that already answers a target's texts is
 * written again, so its lifetime (`AI_REMOVALS_TTL_SECONDS`) counts from now while the text is shown.
 */
async function sanitizeDocs(
  agencyId: string,
  { rows, identity, plan }: OwnerDocs,
  options: SanitizeOptions,
  { keepAlive }: { keepAlive: boolean },
): Promise<SanitizeTextsResult> {
  const result: SanitizeTextsResult = { docs: rows.length, asked: 0, stored: 0, degraded: 0, degradedTargetIds: [] };
  if (rows.length === 0) return result;
  const ctx: AiCtx = { tenant: { agencyId, plan }, requestId: options.requestId };
  const work = await targetsToAsk(agencyId, rows, identity, { keepAlive, force: false });

  const changed: string[] = [];
  await eachLimited(work, CALL_CONCURRENCY, async ({ targetId, before, docs: perDoc }) => {
    const target = { agencyId, targetId };
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

/**
 * S13-F25: the backfill's batch feature — its usage and response cache apart from the event path's interactive
 * `white-label.sanitize` calls (the same prompt).
 */
export const WHITE_LABEL_BACKFILL_FEATURE = 'white-label.backfill';

/** S13-F25: one network-shown document of a backfill page as kept in `white_label_batches.items`. */
export interface BackfillItem {
  /** `d<n>`: the document's position in the page's items. */
  customId: string;
  targetId: string;
  /** The read model version the texts are of. */
  version: number;
  /** Each text's key and the part sent (the batch's input is rebuilt from these, so collect matches submit). */
  texts: { key: string; sent: string }[];
  /** The removals as the model gave them, once answered (by the response cache at submit, or the collected batch). */
  spans?: string[];
}

export interface BackfillPageResult extends SanitizeTextsResult {
  /** Network-shown targets of the page. */
  targets: number;
  /** Where the next page starts; null when the agency's walk is done. */
  next: BackfillCursor | null;
  /**
   * S13-F25: `SUBMITTED` — the page's documents went to the provider's batch API (`collectWhiteLabelBackfill` applies
   * the answers); null — nothing was sent (every target answered, every answer cached, the toggle off, over budget).
   */
  batch: 'SUBMITTED' | null;
}

/** The page's batch request: rebuilt from the stored items, identical at submit and collect. */
const backfillBatchRequest = (pageKey: string, items: readonly BackfillItem[]) => ({
  feature: WHITE_LABEL_BACKFILL_FEATURE,
  prompt: WHITE_LABEL_PROMPT,
  // Only the cleaned texts, as untrusted data: no identity, contact or id goes to the provider (PLAN §8).
  items: items.map((i) => ({ customId: i.customId, input: modelInput(i.texts) })),
  idempotencyKey: pageKey,
});

/** A batch answer's removals (`{"remove": [...]}`, perhaps fenced); null when it is not that JSON. */
export function parseRemovals(text: string): string[] | null {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  let value: unknown;
  try {
    value = JSON.parse(fenced?.[1] ?? trimmed);
  } catch {
    return null;
  }
  const parsed = WhiteLabelRemovals.safeParse(value);
  return parsed.success ? parsed.data.remove.map(unescapeBlockText) : null;
}

const pageResult = (
  base: Partial<BackfillPageResult> & Pick<BackfillPageResult, 'targets' | 'next'>,
): BackfillPageResult => ({ docs: 0, asked: 0, stored: 0, degraded: 0, degradedTargetIds: [], batch: null, ...base });

/**
 * S13-F7 / S13-F25: one page of the white-label backfill (`aiFeatures.whiteLabelBackfill`) — documents network sites
 * show that never had the model pass (shown before it existed, a degraded run, an entry about to expire). Reads the
 * agency's next `BACKFILL_PAGE_TARGETS` network-shown targets (keyset on `listing_read_models_agency_idx`), their
 * documents and the owner's identity in one short system transaction; answered targets cost nothing (their entry is
 * kept alive — unless `force`: the owner's identity changed). The rest go to the provider's batch API (half price)
 * under the page key (`pageKey`, the job's id) as the idempotency key, recorded in `white_label_batches`: a retried
 * job submits the recorded items, never a second batch. A page the response cache answered whole is applied at once;
 * otherwise `collectWhiteLabelBackfill` applies the answers later. Over budget: nothing is sent (`degraded`, the walk
 * stops). Resumable by its cursor.
 */
export async function whiteLabelBackfillPage(
  input: { agencyId: string; after: BackfillCursor | null; pageKey: string; force?: boolean },
  options: SanitizeOptions = {},
): Promise<BackfillPageResult> {
  if (!(await whiteLabelModelOn(input.agencyId))) {
    return { ...DISABLED, degradedTargetIds: [], targets: 0, next: null, batch: null };
  }
  const { agencyId, pageKey } = input;
  const read = await withSystem('aiFeatures.whiteLabelBackfill', async (tx) => {
    const recorded = await repo.getWhiteLabelBatch(tx, agencyId, pageKey);
    if (recorded) return { kind: 'RECORDED' as const, recorded, plan: (await billing.planOf(tx, agencyId)).code };
    const page = await search.networkShownTargetsPage(tx, agencyId, input.after, BACKFILL_PAGE_TARGETS);
    const docs =
      page.length > 0
        ? await search.readModelDocs(
            tx,
            page.map((p) => p.targetId),
          )
        : [];
    return { kind: 'PAGE' as const, page, owner: await ownerDocs(tx, agencyId, docs) };
  });

  let row: repo.WhiteLabelBatchRow;
  let plan: string | null;
  let targets: number;
  let docsRead = 0;
  if (read.kind === 'RECORDED') {
    // A retried job: the page's recorded batch (its items are what is sent).
    row = read.recorded;
    plan = read.plan;
    const items = row.items as BackfillItem[];
    targets = new Set(items.map((i) => i.targetId)).size;
    const next = (row.cursor as BackfillCursor | null) ?? null;
    if (row.state !== 'RUNNING') return pageResult({ targets, next });
    if (row.providerBatchId) return pageResult({ targets, next, asked: items.length, batch: 'SUBMITTED' });
  } else {
    const { page, owner } = read;
    const next = page.length === BACKFILL_PAGE_TARGETS ? (page.at(-1) ?? null) : null;
    targets = page.length;
    docsRead = owner.rows.length;
    plan = owner.plan;
    const work = await targetsToAsk(agencyId, owner.rows, owner.identity, {
      keepAlive: true,
      force: input.force ?? false,
    });
    const items: BackfillItem[] = [];
    for (const t of work) {
      for (const d of t.docs) {
        items.push({
          customId: `d${items.length}`,
          targetId: t.targetId,
          version: d.row.version,
          texts: d.texts.map((x) => ({ key: x.key, sent: x.sent })),
        });
      }
    }
    if (items.length === 0) return pageResult({ docs: docsRead, targets, next });
    row = await withSystem('aiFeatures.whiteLabelBackfill', (tx) =>
      repo.insertWhiteLabelBatch(tx, { id: newId(), agencyId, pageKey, items, cursor: next }),
    );
  }
  const sent = await sendBackfillBatch(agencyId, plan, row, options);
  const next = (row.cursor as BackfillCursor | null) ?? null;
  return { ...sent.result, docs: docsRead, targets, next, batch: sent.submitted ? 'SUBMITTED' : null };
}

/**
 * Submits a recorded page under its key. Over budget: nothing is sent, the record is given up, the page `degraded`.
 * Every item cached: applied now, the record DONE. Otherwise the cached answers are kept with the items and the
 * provider's id is saved — null when an earlier run submitted it but crashed before saving it (`unconfirmed`: nothing
 * is sent again; the collect job reconciles by the key).
 */
async function sendBackfillBatch(
  agencyId: string,
  plan: string | null,
  row: repo.WhiteLabelBatchRow,
  options: SanitizeOptions,
): Promise<{ submitted: boolean; result: SanitizeTextsResult }> {
  const items = row.items as BackfillItem[];
  const result: SanitizeTextsResult = { docs: 0, asked: items.length, stored: 0, degraded: 0, degradedTargetIds: [] };
  const ctx: AiCtx = { tenant: { agencyId, plan }, requestId: options.requestId };
  let handle: Awaited<ReturnType<typeof ai.batch>>;
  try {
    handle = await ai.batch(ctx, backfillBatchRequest(row.pageKey, items));
  } catch (err) {
    if (isAppError(err) && err.details?.reason === 'AI_BATCH_IDEMPOTENCY_KEY_REUSED') {
      // claimed before under this key: that submit stands, the collect job polls it by the key
      return { submitted: true, result };
    }
    if (isAppError(err) && err.code === 'AI_BUDGET_EXCEEDED') {
      // Nothing was sent (the budget is checked before any provider call): the walk stops until the next sweep.
      options.onDegrade?.(err.code);
      await withSystem('aiFeatures.whiteLabelBackfill', (tx) =>
        repo.finishWhiteLabelBatch(tx, agencyId, row.id, 'GAVE_UP'),
      );
      const degradedTargetIds = [...new Set(items.map((i) => i.targetId))];
      return { submitted: false, result: { ...result, degraded: items.length, degradedTargetIds } };
    }
    throw err;
  }
  const cached = new Map(handle.cached.flatMap((r) => (r.ok ? [[r.customId, r.text] as const] : [])));
  const answered = items.map((i) => {
    const text = cached.get(i.customId);
    const spans = text === undefined ? null : parseRemovals(text);
    return spans ? { ...i, spans } : i;
  });
  if (handle.batchId === null && !handle.unconfirmed) {
    const applied = await applyBackfillAnswers(agencyId, answered, options);
    await withSystem('aiFeatures.whiteLabelBackfill', (tx) => repo.finishWhiteLabelBatch(tx, agencyId, row.id, 'DONE'));
    return { submitted: false, result: { ...result, ...applied } };
  }
  const providerBatchId = handle.batchId;
  await withSystem('aiFeatures.whiteLabelBackfill', (tx) =>
    repo.setWhiteLabelBatchSubmitted(tx, agencyId, row.id, { items: answered, providerBatchId }),
  );
  return { submitted: true, result };
}

/**
 * Writes the answered items' removals, target by target: each part checked against the text as the deterministic pass
 * cleans it now (`acceptRemovals`, the same check as the event path) — a text changed since the submit is left to its
 * own event. A target with an unanswered document keeps that document's texts out of its entry (the next sweep asks
 * again). Re-reads the targets' documents and the owner's identity in one short system transaction; purges the edge
 * pages of the targets whose removals changed.
 */
async function applyBackfillAnswers(
  agencyId: string,
  items: readonly BackfillItem[],
  options: SanitizeOptions,
): Promise<Pick<SanitizeTextsResult, 'stored' | 'degraded' | 'degradedTargetIds'>> {
  const out = { stored: 0, degraded: 0, degradedTargetIds: [] as string[] };
  const itemTargetIds = [...new Set(items.map((i) => i.targetId))];
  if (itemTargetIds.length === 0) return out;
  const owner = await withSystem('aiFeatures.whiteLabelBackfill', async (tx) =>
    ownerDocs(tx, agencyId, await search.readModelDocs(tx, itemTargetIds)),
  );
  const current = shownDocsByTarget(owner.rows, owner.identity);
  // Only the agency's own targets that still have documents (security review): nothing is stored or purged for an id
  // of another agency's (or a deleted) target.
  const targetIds = itemTargetIds.filter((id) => current.has(id));
  if (targetIds.length === 0) return out;
  const existing = await readAiRemovalEntries(targetIds.map((targetId) => ({ agencyId, targetId })));
  const changed: string[] = [];
  await eachLimited(targetIds, CALL_CONCURRENCY, async (targetId) => {
    const byKey = new Map<string, { text: PreparedText; names: string[] }>();
    for (const d of current.get(targetId) ?? []) for (const t of d.texts) byKey.set(t.key, { text: t, names: d.names });
    const own = items.filter((i) => i.targetId === targetId);
    const texts: Record<string, string[]> = {};
    for (const item of own) {
      if (!item.spans) {
        out.degraded++;
        if (!out.degradedTargetIds.includes(targetId)) out.degradedTargetIds.push(targetId);
        continue;
      }
      for (const { key } of item.texts) {
        const now = byKey.get(key);
        if (now) Object.assign(texts, removalsByText([now.text], item.spans, { protectedNames: now.names }));
      }
    }
    const target = { agencyId, targetId };
    const version = Math.max(...own.map((i) => i.version));
    const outcome = await storeTargetRemovals(target, existing.get(targetId), version, texts);
    if (outcome === 'STORED') out.stored++;
    if (outcome !== 'NONE') changed.push(targetId);
  });
  if (out.degraded > 0) options.onDegrade?.('AI_UNAVAILABLE');
  // Pages the edge cached with the previous text show the new one within the purge window (S7-06).
  if (changed.length > 0) {
    await websiteApi.queueEdgePurge(
      agencyId,
      changed.map((id) => ({ kind: 't' as const, id })),
      clock.now(),
    );
  }
  return out;
}

export type BackfillCollect =
  | { status: 'IN_PROGRESS' }
  | ({ status: 'DONE' } & Pick<SanitizeTextsResult, 'stored' | 'degraded' | 'degradedTargetIds'> & {
        /** The record was given up (polled too long, the toggle switched off, the batch unknown). */
        gaveUp?: true;
      });

const nothingApplied = () => ({ stored: 0, degraded: 0, degradedTargetIds: [] as string[] });

/**
 * S13-F25 (`aiFeatures.collectWhiteLabelBatch`): `IN_PROGRESS` until the page's batch ends, then applies its answers
 * (with the cached ones kept at submit) and marks the record DONE. A batch an earlier submit never got to the provider
 * (`NOT_SUBMITTED`) is submitted now. `giveUp` (polled too long), the agency's WHITE_LABEL switched off since (no
 * provider call) or a batch the gateway does not know: the record is GAVE_UP — the next sweep covers the targets.
 */
export async function collectWhiteLabelBackfill(
  input: { agencyId: string; pageKey: string },
  options: SanitizeOptions & { giveUp?: boolean } = {},
): Promise<BackfillCollect> {
  const { agencyId, pageKey } = input;
  const { row, plan } = await withSystem('aiFeatures.collectWhiteLabelBatch', async (tx) => {
    const row = await repo.getWhiteLabelBatch(tx, agencyId, pageKey);
    return { row, plan: row?.state === 'RUNNING' ? (await billing.planOf(tx, agencyId)).code : null };
  });
  if (row?.state !== 'RUNNING') return { status: 'DONE', ...nothingApplied() };
  const giveUp = async (): Promise<BackfillCollect> => {
    await withSystem('aiFeatures.collectWhiteLabelBatch', (tx) =>
      repo.finishWhiteLabelBatch(tx, agencyId, row.id, 'GAVE_UP'),
    );
    return { status: 'DONE', ...nothingApplied(), gaveUp: true };
  };
  if (options.giveUp || !(await whiteLabelModelOn(agencyId))) return giveUp();
  const items = row.items as BackfillItem[];
  const ctx: AiCtx = { tenant: { agencyId, plan }, requestId: options.requestId };
  // the saved id; else the page key (a submit that crashed before saving it)
  const ref = row.providerBatchId ? { batchId: row.providerBatchId } : { idempotencyKey: pageKey };
  let res: Awaited<ReturnType<typeof ai.collectBatch>>;
  try {
    res = await ai.collectBatch(ctx, { ...ref, request: backfillBatchRequest(pageKey, items) });
  } catch (err) {
    if (isAppError(err) && err.code === 'NOT_FOUND') return giveUp();
    throw err;
  }
  if (res.status === 'IN_PROGRESS') return res;
  if (res.status === 'NOT_SUBMITTED') {
    const sent = await sendBackfillBatch(agencyId, plan, row, options);
    if (sent.submitted) return { status: 'IN_PROGRESS' };
    const { stored, degraded, degradedTargetIds } = sent.result;
    return { status: 'DONE', stored, degraded, degradedTargetIds };
  }
  const answers = new Map(res.results.flatMap((r) => (r.ok ? [[r.customId, r.text] as const] : [])));
  const answered = items.map((i) => {
    if (i.spans) return i;
    const text = answers.get(i.customId);
    const spans = text === undefined ? null : parseRemovals(text);
    return spans ? { ...i, spans } : i;
  });
  const applied = await applyBackfillAnswers(agencyId, answered, options);
  await withSystem('aiFeatures.collectWhiteLabelBatch', (tx) =>
    repo.finishWhiteLabelBatch(tx, agencyId, row.id, 'DONE'),
  );
  return { status: 'DONE', ...applied };
}

/** S13-F25 (the daily prune, all agencies via `withSystem`): backfill batches created before `before`. */
export async function pruneWhiteLabelBatches(tx: Tx, before: Date, limit: number): Promise<number> {
  return repo.pruneWhiteLabelBatches(tx, before, limit);
}
