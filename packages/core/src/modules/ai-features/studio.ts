/**
 * AI Listing Studio (S12-02, PLAN §8 #1, §3 #15, PATTERNS §17): a listing's title, description and SEO meta in every
 * enabled content locale, written from its facts and photo room tags, in a tone preset, stored as `AI_DRAFT` until a
 * person saves (reviews) it. Generation never runs in a request:
 *
 * - `requestListingStudio` / `requestListingStudioBulk` (request path): authorize, resolve the locales, emit
 *   `aiFeatures.listingStudio.requested` in the transaction; the worker turns it into a job (`subscriptions.ts`).
 * - `generateListingStudio` (job `aiFeatures.generateListingCopy`, one listing): one FAST structured call per target
 *   locale, then the deterministic fact check (`studio-facts.ts`): a copy with a figure that is not a fact, a price,
 *   a percentage or a currency is asked again once with the rejected figures named, then dropped.
 * - `submitListingStudioBulk` / `collectListingStudioBulk` (jobs `aiFeatures.submitListingStudioBatch` /
 *   `aiFeatures.collectListingStudioBatch`): the same through the discounted batch API; the collect job polls until
 *   the batch ends. Cached answers are applied at submit time. The submitted items and each listing's facts hash are
 *   kept in `listing_studio_batches` (the gateway collects a batch only with the very items it submitted).
 *
 * Targets: the requested locales (default: every enabled one) minus locked locales — and, without `replaceReviewed`,
 * minus texts a person wrote or reviewed. The write re-checks both in its statement (`properties.saveListingAiDrafts`)
 * and drops a draft when the listing's facts changed since it was generated (facts hash).
 *
 * S13-F17: per-agency toggles (`agencies.aiFeatureEnabled`, cached). `LISTING_STUDIO` off: the request is refused
 * (`AI_NOT_ENABLED`) and a queued job, batch or collect calls no model (a running batch is given up). Drafts in the
 * agency's other languages (all but its main one, the first enabled content locale) are translations
 * (`TRANSLATION_DRAFTS`): off, the default request targets the main language only, a request naming another is
 * refused, and the worker never asks the model for them.
 */
import {
  LISTING_STUDIO_RUNNING_MAX,
  type ListingStudioAcceptedDto,
  type ListingStudioBody,
  type ListingStudioBulkBody,
  type ListingStudioTone,
} from '@inmolink/contracts';
import { type Tx, withSystem } from '@inmolink/db';
import { CONTENT_LOCALES } from '@inmolink/i18n';
import { type AiBatchItemResult, type AiCtx, ai, aiOrFallback, untrustedBlock } from '@inmolink/platform/ai';
import { clock } from '@inmolink/platform/clock';
import { AppError, isAppError } from '@inmolink/platform/errors';
import { flag } from '@inmolink/platform/flags';
import { newId } from '@inmolink/platform/ids';
import type { Logger } from '@inmolink/platform/logger';
import { emit } from '@inmolink/platform/outbox';
import type { Ctx } from '../../context';
import { withMemberCtx } from '../../member';
import * as agencies from '../agencies';
import * as billing from '../billing';
import * as media from '../media';
import * as properties from '../properties';
import * as taxonomy from '../taxonomy';
import { aiFeaturesEvents } from './events';
import { assertCan } from './policy';
import * as repo from './repo';
import {
  allowedFigures,
  copyViolations,
  factsHash,
  ListingCopy,
  moneyFigures,
  moneyLeaks,
  pickSource,
  type StudioInput,
  studioFacts,
} from './studio-facts';

/** The prompt file (`prompts/listing-studio/v1.md`); bump the version for any change (ADR 0008 #5). */
export const LISTING_STUDIO_PROMPT = { id: 'listing-studio', version: 1 } as const;
const FEATURE_SINGLE = 'listing-studio.describe';
const FEATURE_BULK = 'listing-studio.bulk';
const FEATURE_REPAIR = 'listing-studio.repair';
/** A write that loses to a concurrent edit re-reads the facts this many times before giving up. */
const WRITE_ATTEMPTS = 3;
/** Repair calls one bulk apply may make (bad batch answers beyond it are dropped: REPAIR_CAP). */
export const STUDIO_REPAIRS_PER_APPLY = 20;

export interface StudioRequest {
  requestId: string;
  agencyId: string;
  userId: string;
  listingIds: string[];
  tone: ListingStudioTone;
  locales: string[];
  replaceReviewed: boolean;
  /** S13-F21: the agency's plan in force (AI budgets), resolved by the job; absent: the gateway's default budget. */
  plan?: string | null;
}

export interface StudioOutcome {
  /** Locales written per listing id. */
  written: Record<string, string[]>;
  /** `<listingId>:<locale>` → why no draft was stored (FACTS, AI code, STALE). */
  dropped: Record<string, string>;
}

// ---- request path -----------------------------------------------------------------------------------------------

/** S13-F17: which of the agency's AI toggles let Studio write a locale. */
export interface StudioGate {
  studio: boolean;
  translations: boolean;
  /** The agency's main content locale (its first enabled one): not a translation. */
  main: string | null;
}

const contentLocalesOf = (ctx: Ctx) =>
  ctx.tenant.locales.filter((l) => (CONTENT_LOCALES as readonly string[]).includes(l));

/** The agency's Studio toggles (one cached read). */
export async function studioGate(ctx: Ctx): Promise<StudioGate> {
  const on = await agencies.enabledAiFeatures(ctx.tenant.agencyId, ctx);
  return {
    studio: on.includes('LISTING_STUDIO'),
    translations: on.includes('TRANSLATION_DRAFTS'),
    main: contentLocalesOf(ctx)[0] ?? null,
  };
}

/** Whether the toggles let Studio ask the model for this locale. */
export const studioAllows = (gate: StudioGate, locale: string): boolean =>
  gate.studio && (gate.translations || locale === gate.main);

async function resolveLocales(ctx: Ctx, requested: readonly string[] | undefined): Promise<string[]> {
  const enabled = contentLocalesOf(ctx);
  if (requested?.some((l) => !enabled.includes(l))) {
    throw new AppError('VALIDATION_FAILED', { field: 'locales', reason: 'not_enabled' });
  }
  const wanted = requested ? enabled.filter((l) => requested.includes(l)) : enabled;
  const gate = await studioGate(ctx);
  if (!gate.studio) throw new AppError('AI_NOT_ENABLED', { feature: 'LISTING_STUDIO' });
  const allowed = wanted.filter((l) => studioAllows(gate, l));
  // Translation drafts off: a request naming another language is refused; the default is the main language only.
  if (requested && allowed.length < wanted.length)
    throw new AppError('AI_NOT_ENABLED', { feature: 'TRANSLATION_DRAFTS' });
  if (allowed.length === 0) throw new AppError('AI_NOT_ENABLED', { feature: 'TRANSLATION_DRAFTS' });
  return allowed;
}

async function emitRequest(
  ctx: Ctx,
  ids: string[],
  body: ListingStudioBody,
  mode: 'SINGLE' | 'BULK',
  skipped: number,
): Promise<ListingStudioAcceptedDto> {
  const locales = await resolveLocales(ctx, body.locales);
  if (ctx.actor.kind !== 'user') throw new AppError('FORBIDDEN');
  await countStudioListings(ctx, ids.length, mode);
  const requestId = newId();
  await emit(
    ctx.tx,
    aiFeaturesEvents.listingStudioRequested({
      requestId,
      userId: ctx.actor.userId,
      listingIds: ids,
      tone: body.tone,
      locales,
      replaceReviewed: body.replaceReviewed,
      mode,
    }),
  );
  return { requestId, listings: ids.length, skipped, locales };
}

/**
 * S13-F21: the plan quota of Listing Studio (`studio_listings_month`, PLAN §11: Free 10 a month) — refused with
 * `PLAN_REQUIRED` past it, else the listings are counted in this calendar month (UTC). Under the agency's studio lock
 * (the bulk path already holds it), so concurrent requests are counted one after the other.
 */
async function countStudioListings(ctx: Ctx, n: number, mode: 'SINGLE' | 'BULK'): Promise<void> {
  const { agencyId } = ctx.tenant;
  if (mode === 'SINGLE') await repo.lockAgencyStudio(ctx.tx, agencyId);
  const month = `${clock.now().toISOString().slice(0, 7)}-01`;
  await billing.requireQuota(ctx, 'studio_listings_month', () => repo.studioListingsIn(ctx.tx, agencyId, month), n);
  await repo.addStudioListings(ctx.tx, agencyId, month, n);
}

/** `POST /v1/listings/:id/studio`: queues AI drafts for one listing the caller may edit. */
export async function requestListingStudio(
  ctx: Ctx,
  listingId: string,
  body: ListingStudioBody,
): Promise<ListingStudioAcceptedDto> {
  assertCan(ctx, 'aiFeatures.listingStudio');
  await agencies.assertAiFeatureEnabled(ctx, 'LISTING_STUDIO');
  await properties.assertStudioEditable(ctx, listingId);
  return emitRequest(ctx, [listingId], body, 'SINGLE', 0);
}

/**
 * `POST /v1/listing-studio-batches`: queues AI drafts for many listings (the ones the caller may edit). At most
 * `LISTING_STUDIO_RUNNING_MAX` batches per agency: the request takes the agency's studio lock (transaction-scoped
 * advisory lock), counts the running batches and reserves its own batch row (no items yet; the submit job fills it)
 * in the same transaction as the event — concurrent requests are counted one after the other, pending ones included.
 */
export async function requestListingStudioBulk(
  ctx: Ctx,
  body: ListingStudioBulkBody,
): Promise<ListingStudioAcceptedDto> {
  assertCan(ctx, 'aiFeatures.listingStudio');
  if (ctx.actor.kind !== 'user') throw new AppError('FORBIDDEN');
  await agencies.assertAiFeatureEnabled(ctx, 'LISTING_STUDIO');
  await repo.lockAgencyStudio(ctx.tx, ctx.tenant.agencyId);
  if ((await repo.countRunningStudioBatches(ctx.tx, ctx.tenant.agencyId)) >= LISTING_STUDIO_RUNNING_MAX) {
    throw new AppError('LISTING_STUDIO_BATCH_LIMIT', { max: LISTING_STUDIO_RUNNING_MAX });
  }
  const editable = await properties.studioEditableIds(ctx, body.listingIds);
  if (editable.length === 0) throw new AppError('FORBIDDEN', { reason: 'no_editable_listing' });
  // keep the caller's order (the batch's custom ids are positions in this list)
  const ids = body.listingIds.filter((id) => editable.includes(id));
  const dto = await emitRequest(ctx, ids, body, 'BULK', body.listingIds.length - ids.length);
  await repo.insertStudioBatch(ctx.tx, {
    id: dto.requestId,
    agencyId: ctx.tenant.agencyId,
    createdByUserId: ctx.actor.userId,
    listingIds: ids,
    locales: dto.locales,
    tone: body.tone,
    replaceReviewed: body.replaceReviewed,
    factsHashes: ids.map(() => ''),
    items: [],
  });
  return dto;
}

// ---- auto-drafts (S13-F14, PLAN §3 #15) ----------------------------------------------------------------------------

/** Platform flag (`feature_flags`, off unless switched on — for everyone or per agency): Studio drafts by itself. */
export const STUDIO_AUTO_DRAFTS_FLAG = 'ai.listing-studio.auto-drafts';
/** The tone of auto-drafts (the request's default). */
const AUTO_DRAFT_TONE: ListingStudioTone = 'PROFESSIONAL';

export type AutoDraftResult =
  | { status: 'QUEUED'; requestId: string; locales: string[] }
  | { status: 'SKIPPED'; reason: 'FLAG_OFF' | 'NO_OWNER' | 'NOT_ENABLED' | 'NOTHING_TO_DRAFT' | 'QUOTA' };

/**
 * S13-F14: after a listing is created or its facts change (`properties.listing.factsChanged`, worker), queues Studio
 * drafts for its enabled languages as its owner — behind `STUDIO_AUTO_DRAFTS_FLAG`, and only within the agency's toggles (`LISTING_STUDIO`;
 * other languages only with `TRANSLATION_DRAFTS`) and its plan's monthly Studio quota (a listing past it is skipped,
 * never refused to anyone). Only locales with no text or an earlier AI draft are targeted: a person's text is never
 * replaced (`replaceReviewed: false`). The drafts stay `AI_DRAFT` until a person saves them; nothing is published.
 * The studio's own draft writes, price or status changes emit no `factsChanged`: no loop, no cost.
 */
export async function autoDraftListing(input: { agencyId: string; listingId: string }): Promise<AutoDraftResult> {
  // worker only (the outbox subscription): the flag and the listing's owner, one short system transaction
  const owner = await withSystem('aiFeatures.autoDraftListing', async (tx) =>
    (await flag({ tx, tenant: { agencyId: input.agencyId } }, STUDIO_AUTO_DRAFTS_FLAG))
      ? { on: true, userId: await properties.studioListingOwner(tx, input.agencyId, input.listingId) }
      : { on: false, userId: null },
  );
  if (!owner.on) return { status: 'SKIPPED', reason: 'FLAG_OFF' };
  if (!owner.userId) return { status: 'SKIPPED', reason: 'NO_OWNER' };
  const userId = owner.userId;
  try {
    return await withMemberCtx({ userId, agencyId: input.agencyId, requestId: newId() }, async (ctx) => {
      const gate = await studioGate(ctx);
      if (!gate.studio) return { status: 'SKIPPED', reason: 'NOT_ENABLED' } as const;
      const [listing] = await properties.studioListings(ctx, [input.listingId]);
      if (!listing) return { status: 'SKIPPED', reason: 'NO_OWNER' } as const;
      const byLocale = new Map(listing.translations.map((t) => [t.locale, t]));
      const locales = contentLocalesOf(ctx).filter((l) => {
        const t = byLocale.get(l);
        return studioAllows(gate, l) && (!t || (!t.locked && t.origin === 'AI_DRAFT'));
      });
      if (locales.length === 0) return { status: 'SKIPPED', reason: 'NOTHING_TO_DRAFT' } as const;
      try {
        await countStudioListings(ctx, 1, 'SINGLE');
      } catch (err) {
        if (isAppError(err) && err.code === 'PLAN_REQUIRED') return { status: 'SKIPPED', reason: 'QUOTA' } as const;
        throw err;
      }
      const requestId = newId();
      await emit(
        ctx.tx,
        aiFeaturesEvents.listingStudioRequested({
          requestId,
          userId,
          listingIds: [input.listingId],
          tone: AUTO_DRAFT_TONE,
          locales,
          replaceReviewed: false,
          mode: 'SINGLE',
        }),
      );
      return { status: 'QUEUED', requestId, locales } as const;
    });
  } catch (err) {
    // the owner left the agency, or the agency is suspended: nobody to draft as
    if (isAppError(err) && err.code === 'FORBIDDEN') return { status: 'SKIPPED', reason: 'NO_OWNER' };
    throw err;
  }
}

// ---- worker: inputs ---------------------------------------------------------------------------------------------

interface ListingWork {
  listingId: string;
  version: number;
  hash: string;
  /** Locales to write now (locks and reviewed texts left out). */
  targets: string[];
  /** The model input per requested locale. */
  inputs: Map<string, StudioInput>;
  /** The listing's money figures (`moneyFigures`): checked on the server, never in an input. */
  money: Set<number>;
}

/** Reads the listings' facts, names and photo tags as the member, and builds each locale's model input. */
async function collectWork(ctx: Ctx, req: StudioRequest, ids: readonly string[]): Promise<ListingWork[]> {
  // S13-F17: the toggles as they are now — a feature switched off after the request asks the model for nothing.
  const gate = await studioGate(ctx);
  if (!gate.studio) return [];
  const listings = await properties.studioListings(ctx, ids);
  if (listings.length === 0) return [];
  // one after the other: a transaction is one connection
  const mediaOf = await media.mediaForReadModels(
    ctx.tx,
    listings.map((l) => l.id),
    { agencyId: ctx.tenant.agencyId },
  );
  const tax = await taxonomy.taxonomyForReadModels(
    ctx.tx,
    {
      locations: listings.map((l) => l.locationId),
      propertyTypes: listings.map((l) => l.propertyTypeId),
      features: listings.flatMap((l) => l.featureIds),
    },
    req.locales,
  );
  return listings.map((l) => {
    const rooms = (mediaOf.get(l.id)?.items ?? []).map((m) => (m.kind === 'IMAGE' ? m.room : null));
    const source = pickSource(l.translations, req.locales);
    const lineage = tax.lineage.get(l.locationId) ?? [];
    const inputs = new Map<string, StudioInput>();
    let money: Set<number> | undefined;
    for (const locale of req.locales) {
      const name = (id: string) => taxonomy.taxonName(tax, id, locale)?.name ?? null;
      const facts = studioFacts(
        l,
        {
          propertyType: name(l.propertyTypeId),
          location: lineage
            .map((p) => name(p.id))
            .filter((n): n is string => n !== null)
            .slice(0, 3),
          features: l.featureIds.map(name).filter((n): n is string => n !== null),
        },
        rooms,
      );
      money ??= moneyFigures(l.money, facts);
      // the agency's own text may come from a feed: data, never instructions (S12-01 review, `untrustedBlock`)
      const useSource =
        source && source.locale !== locale
          ? {
              locale: source.locale,
              title: untrustedBlock('source_title', source.title),
              description: untrustedBlock('source_text', source.description ?? ''),
            }
          : undefined;
      inputs.set(locale, { locale, tone: req.tone, facts, ...(useSource ? { source: useSource } : {}) });
    }
    const byLocale = new Map(l.translations.map((t) => [t.locale, t]));
    const targets = req.locales.filter((locale) => {
      if (!studioAllows(gate, locale)) return false;
      const t = byLocale.get(locale);
      if (!t) return true;
      if (t.locked) return false;
      return t.origin === 'AI_DRAFT' || req.replaceReviewed;
    });
    const { version: _v, agencyId: _a, translations: _t, ...facts } = l;
    return {
      listingId: l.id,
      version: l.version,
      hash: factsHash({ facts, rooms, source }),
      targets,
      inputs,
      money: money ?? new Set<number>(),
    };
  });
}

const member = (req: StudioRequest) => ({ userId: req.userId, agencyId: req.agencyId, requestId: req.requestId });

async function readWork(req: StudioRequest, ids: readonly string[]): Promise<ListingWork[]> {
  return withMemberCtx(member(req), (ctx) => collectWork(ctx, req, ids));
}

/** S13-F21: the gateway meters the call against the agency's plan budget (`plan`, resolved once per job). */
const aiCtxOf = (req: StudioRequest): AiCtx => ({
  tenant: { agencyId: req.agencyId, plan: req.plan ?? null },
  requestId: req.requestId,
});

/** S13-F21: the listing's work and the agency's plan in force (AI budgets per plan), in one transaction per job. */
const readWorkAndPlan = (req: StudioRequest, ids: readonly string[]) =>
  withMemberCtx(member(req), async (ctx) => ({
    work: await collectWork(ctx, req, ids),
    plan: (await billing.planOf(ctx.tx, req.agencyId)).code,
  }));

// ---- worker: generation and the fact check ----------------------------------------------------------------------

type Checked = { ok: true; copy: ListingCopy } | { ok: false; reason: string };

/**
 * The fact check (`money`: the listing's price and commission figures, which the copy must not quote), with one
 * repair call naming what was rejected (`FACTS` when the repair fails it too). `repairs` caps the repair calls of one
 * bulk apply. The budget's hard cap stops the job (`AI_BUDGET_EXCEEDED` is rethrown); other AI failures drop the copy.
 */
async function checkOrRepair(
  aiCtx: AiCtx,
  input: StudioInput,
  copy: ListingCopy,
  money: ReadonlySet<number> = new Set(),
  repairs?: { left: number },
): Promise<Checked> {
  const allowed = allowedFigures(input.facts, input.source, money);
  const bad = copyViolations(copy, allowed, input.locale);
  if (bad.length === 0) return { ok: true, copy };
  if (repairs) {
    if (repairs.left <= 0) return { ok: false, reason: 'REPAIR_CAP' };
    repairs.left -= 1;
  }
  return aiOrFallback(
    async (): Promise<Checked> => {
      const repaired = await ai.structured(aiCtx, {
        feature: FEATURE_REPAIR,
        prompt: LISTING_STUDIO_PROMPT,
        input: { ...input, rejected: bad },
        schema: ListingCopy,
      });
      return copyViolations(repaired.data, allowed, input.locale).length === 0
        ? { ok: true, copy: repaired.data }
        : { ok: false, reason: 'FACTS' };
    },
    (code): Checked => {
      if (code === 'AI_BUDGET_EXCEEDED') rethrowUnlessDegraded(code);
      return { ok: false, reason: code };
    },
  );
}

/** Stops a job for good on the budget's hard cap; an outage (or anything else) is retried by the queue. */
function rethrowUnlessDegraded(code: string): string {
  if (code === 'AI_BUDGET_EXCEEDED') throw new AppError('AI_BUDGET_EXCEEDED', { feature: FEATURE_SINGLE });
  if (code === 'AI_UNAVAILABLE') throw new AppError('AI_UNAVAILABLE', { feature: FEATURE_SINGLE });
  return code;
}

/**
 * Writes the checked copies of one listing as the member: re-reads the listing, drops the drafts when its facts
 * changed since `hash`, and retries a lost race (VERSION_CONFLICT) with the fresh version.
 */
async function writeDrafts(
  req: StudioRequest,
  listingId: string,
  hash: string,
  copies: Map<string, ListingCopy>,
  outcome: StudioOutcome,
): Promise<void> {
  if (copies.size === 0) return;
  for (let attempt = 1; ; attempt++) {
    try {
      const written = await withMemberCtx(member(req), async (ctx) => {
        const [now] = await collectWork(ctx, req, [listingId]);
        if (!now || now.hash !== hash) return null;
        const drafts = [...copies]
          .filter(([locale, c]) => {
            // a copy quoting the price or the commission is never stored (checked here, on current figures)
            if (moneyLeaks(c, now.money).length === 0) return true;
            outcome.dropped[`${listingId}:${locale}`] = 'MONEY';
            return false;
          })
          .filter(([locale]) => now.targets.includes(locale))
          .map(([locale, c]) => ({ locale, ...c }));
        if (drafts.length === 0) return [];
        return (
          await properties.saveListingAiDrafts(ctx, listingId, {
            version: now.version,
            drafts,
            replaceReviewed: req.replaceReviewed,
          })
        ).written;
      });
      if (written === null) for (const l of copies.keys()) outcome.dropped[`${listingId}:${l}`] = 'STALE';
      else if (written.length > 0) outcome.written[listingId] = written;
      return;
    } catch (err) {
      if (isAppError(err) && err.code === 'VERSION_CONFLICT' && attempt < WRITE_ATTEMPTS) continue;
      if (isAppError(err) && (err.code === 'LISTING_NOT_FOUND' || err.code === 'FORBIDDEN')) return;
      throw err;
    }
  }
}

/** Job `aiFeatures.generateListingCopy`: one listing, one structured call per target locale. */
export async function generateListingStudio(input: StudioRequest, log?: Logger): Promise<StudioOutcome> {
  const outcome: StudioOutcome = { written: {}, dropped: {} };
  const read = await readWorkAndPlan(input, input.listingIds.slice(0, 1));
  const [work] = read.work;
  if (!work) return outcome;
  const req: StudioRequest = { ...input, plan: read.plan };
  const aiCtx = aiCtxOf(req);
  const copies = new Map<string, ListingCopy>();
  for (const locale of work.targets) {
    const input = work.inputs.get(locale);
    if (!input) continue;
    const checked = await aiOrFallback(
      async (): Promise<Checked> => {
        const res = await ai.structured(aiCtx, {
          feature: FEATURE_SINGLE,
          prompt: LISTING_STUDIO_PROMPT,
          input,
          schema: ListingCopy,
        });
        return checkOrRepair(aiCtx, input, res.data, work.money);
      },
      (code): Checked => ({ ok: false, reason: rethrowUnlessDegraded(code) }),
    );
    if (checked.ok) copies.set(locale, checked.copy);
    else outcome.dropped[`${work.listingId}:${locale}`] = checked.reason;
  }
  await writeDrafts(req, work.listingId, work.hash, copies, outcome);
  log?.info(
    { requestId: req.requestId, written: outcome.written[work.listingId] ?? [], dropped: outcome.dropped },
    'listing studio drafts',
  );
  return outcome;
}

// ---- worker: bulk (batch API) ------------------------------------------------------------------------------------

/** A submitted batch item as stored in `listing_studio_batches.items`. */
interface StoredItem {
  customId: string;
  input: StudioInput;
}

/** `l<position>_<locale>`: the position in `req.listingIds` (custom ids are ≤ 64 characters). */
const customIdOf = (index: number, locale: string) => `l${index}_${locale}`;

function parseCustomId(req: StudioRequest, customId: string): { listingId: string; locale: string } | null {
  const m = /^l(\d+)_(.+)$/.exec(customId);
  const listingId = m ? req.listingIds[Number(m[1])] : undefined;
  return m && listingId ? { listingId, locale: m[2] as string } : null;
}

/** One item per (listing, target locale). */
function batchItems(req: StudioRequest, work: ListingWork[]): StoredItem[] {
  const items: StoredItem[] = [];
  for (const w of work) {
    const index = req.listingIds.indexOf(w.listingId);
    if (index === -1) continue;
    for (const locale of w.targets) {
      const input = w.inputs.get(locale);
      if (input) items.push({ customId: customIdOf(index, locale), input });
    }
  }
  return items;
}

/**
 * S13-F14: the request id is the batch's idempotency key — the gateway claims it before calling the provider, so a
 * submit job that crashed after the provider accepted the batch never submits it a second time when retried.
 */
const batchRequest = (req: StudioRequest, items: readonly StoredItem[]) => ({
  feature: FEATURE_BULK,
  prompt: LISTING_STUDIO_PROMPT,
  items: items.map((i) => ({ customId: i.customId, input: i.input })),
  idempotencyKey: req.requestId,
});

/** Parses, checks (one repair) and writes batch answers, listing by listing (one transaction each). */
async function applyResults(
  req: StudioRequest,
  items: readonly StoredItem[],
  hashes: readonly string[],
  results: readonly AiBatchItemResult[],
  outcome: StudioOutcome,
  gate: StudioGate,
): Promise<void> {
  const aiCtx = aiCtxOf(req);
  const repairs = { left: STUDIO_REPAIRS_PER_APPLY };
  const inputOf = new Map(items.map((i) => [i.customId, i.input]));
  const byListing = new Map<string, Map<string, ListingCopy>>();
  for (const r of results) {
    const key = parseCustomId(req, r.customId);
    const input = inputOf.get(r.customId);
    if (!key || !input) continue;
    // S13-F17: a locale whose toggle was switched off since the submit gets no repair call and no draft.
    if (!studioAllows(gate, key.locale)) {
      outcome.dropped[`${key.listingId}:${key.locale}`] = 'AI_NOT_ENABLED';
      continue;
    }
    if (!r.ok) {
      outcome.dropped[`${key.listingId}:${key.locale}`] = r.error;
      continue;
    }
    const parsed = ListingCopy.safeParse(parseJson(r.text));
    const checked: Checked = parsed.success
      ? await checkOrRepair(aiCtx, input, parsed.data, undefined, repairs)
      : repairs.left <= 0
        ? { ok: false, reason: 'REPAIR_CAP' }
        : await aiOrFallback(
            async (): Promise<Checked> => {
              // counted before the call, like `checkOrRepair`: a failed call counts against the cap too
              repairs.left -= 1;
              const res = await ai.structured(aiCtx, {
                feature: FEATURE_REPAIR,
                prompt: LISTING_STUDIO_PROMPT,
                input,
                schema: ListingCopy,
              });
              return checkOrRepair(aiCtx, input, res.data, undefined, repairs);
            },
            (code): Checked => {
              if (code === 'AI_BUDGET_EXCEEDED') rethrowUnlessDegraded(code);
              return { ok: false, reason: code };
            },
          );
    if (!checked.ok) {
      outcome.dropped[`${key.listingId}:${key.locale}`] = checked.reason;
      continue;
    }
    const copies = byListing.get(key.listingId) ?? new Map<string, ListingCopy>();
    copies.set(key.locale, checked.copy);
    byListing.set(key.listingId, copies);
  }
  for (const [listingId, copies] of byListing) {
    const index = req.listingIds.indexOf(listingId);
    await writeDrafts(req, listingId, hashes[index] ?? '', copies, outcome);
  }
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  try {
    return JSON.parse(fenced?.[1] ?? trimmed);
  } catch {
    return null;
  }
}

const countOf = (outcome: StudioOutcome) => ({
  written: Object.values(outcome.written).reduce((n, l) => n + l.length, 0),
  dropped: Object.keys(outcome.dropped).length,
});

async function finish(req: StudioRequest, state: 'DONE' | 'GAVE_UP', outcome: StudioOutcome): Promise<void> {
  await withMemberCtx(member(req), (ctx) =>
    repo.finishStudioBatch(ctx.tx, req.agencyId, req.requestId, { state, ...countOf(outcome) }),
  );
}

export type BulkSubmit =
  | { status: 'DONE'; outcome: StudioOutcome }
  /** `batchId` null: submitted by an earlier run whose id was never saved — the collect job reconciles it (S13-F14). */
  | { status: 'SUBMITTED'; batchId: string | null; outcome: StudioOutcome };

/**
 * Job `aiFeatures.submitListingStudioBatch`: builds one item per (listing, target locale), records them with each
 * listing's facts hash in the row the request reserved (`listing_studio_batches`, id = request id), submits the batch
 * and applies the answers the cache already had. A retried job finds the record: submitted → nothing to do; items
 * recorded → the same items again; a reservation only → it builds them.
 */
export async function submitListingStudioBulk(input: StudioRequest): Promise<BulkSubmit> {
  const outcome: StudioOutcome = { written: {}, dropped: {} };
  const { existing, gate, plan } = await withMemberCtx(member(input), async (ctx) => ({
    existing: await repo.getStudioBatch(ctx.tx, input.agencyId, input.requestId),
    gate: await studioGate(ctx),
    plan: (await billing.planOf(ctx.tx, input.agencyId)).code,
  }));
  const req: StudioRequest = { ...input, plan };
  if (existing?.providerBatchId) return { status: 'SUBMITTED', batchId: existing.providerBatchId, outcome };
  if (existing && existing.state !== 'RUNNING') return { status: 'DONE', outcome };
  // S13-F17: Listing Studio switched off since the request: nothing is sent, the reservation ends.
  if (!gate.studio) {
    if (existing) await finish(req, 'GAVE_UP', outcome);
    return { status: 'DONE', outcome };
  }
  let items: StoredItem[];
  let hashes: string[];
  const recorded = (existing?.items ?? []) as StoredItem[];
  if (existing && recorded.length > 0) {
    // S13-F17: the recorded items of locales still allowed (a retried submit after a toggle was switched off).
    items = recorded.filter((i) => studioAllows(gate, i.input.locale));
    hashes = existing.factsHashes;
    if (items.length === 0) {
      await finish(req, 'GAVE_UP', outcome);
      return { status: 'DONE', outcome };
    }
  } else if (existing) {
    // the request's reservation: build the items now and record them before anything is sent
    const work = await readWork(req, req.listingIds);
    hashes = req.listingIds.map((id) => work.find((w) => w.listingId === id)?.hash ?? '');
    items = batchItems(req, work);
    if (items.length === 0) {
      await finish(req, 'DONE', outcome);
      return { status: 'DONE', outcome };
    }
    const filled = { items, hashes };
    const stored = await withMemberCtx(member(req), async (ctx) =>
      (await repo.fillStudioBatch(ctx.tx, req.agencyId, req.requestId, filled.items, filled.hashes))
        ? null
        : repo.getStudioBatch(ctx.tx, req.agencyId, req.requestId),
    );
    // another run recorded its items first: submit those, never a second set
    if (stored) {
      if (stored.providerBatchId) return { status: 'SUBMITTED', batchId: stored.providerBatchId, outcome };
      items = stored.items as StoredItem[];
      hashes = stored.factsHashes;
    }
  } else {
    // no reservation (an event queued before reservations existed)
    const work = await readWork(req, req.listingIds);
    hashes = req.listingIds.map((id) => work.find((w) => w.listingId === id)?.hash ?? '');
    items = batchItems(req, work);
    if (items.length === 0) return { status: 'DONE', outcome };
    const row = {
      id: req.requestId,
      agencyId: req.agencyId,
      createdByUserId: req.userId,
      listingIds: req.listingIds,
      locales: req.locales,
      tone: req.tone,
      replaceReviewed: req.replaceReviewed,
      factsHashes: hashes,
      items,
    };
    await withMemberCtx(member(req), (ctx) => repo.insertStudioBatch(ctx.tx, row));
  }
  const sent = await sendBatch(req, items, hashes, outcome, gate);
  if (sent === 'DONE') return { status: 'DONE', outcome };
  return { status: 'SUBMITTED', batchId: sent.batchId, outcome };
}

/**
 * `ai.batch` under the request's idempotency key, then the answers the cache had. `DONE`: everything came from the
 * cache (the record is finished); otherwise the provider's batch id is saved — or null when an earlier run submitted
 * it but crashed before its id was saved (`unconfirmed`: nothing is sent again; the collect job reconciles).
 */
async function sendBatch(
  req: StudioRequest,
  items: readonly StoredItem[],
  hashes: readonly string[],
  outcome: StudioOutcome,
  gate: StudioGate,
): Promise<'DONE' | { batchId: string | null }> {
  let handle: Awaited<ReturnType<typeof ai.batch>>;
  try {
    handle = await ai.batch(aiCtxOf(req), batchRequest(req, items));
  } catch (err) {
    // An earlier run claimed the key with the full recorded items (a toggle switched off since narrowed this run's):
    // that submit stands — the collect job polls it by the key and drops the locales no longer allowed.
    if (isAppError(err) && err.details?.reason === 'AI_BATCH_IDEMPOTENCY_KEY_REUSED') return { batchId: null };
    throw err;
  }
  await applyResults(req, items, hashes, handle.cached, outcome, gate);
  if (handle.batchId === null) {
    if (handle.unconfirmed) return { batchId: null };
    await finish(req, 'DONE', outcome);
    return 'DONE';
  }
  const batchId = handle.batchId;
  await withMemberCtx(member(req), (ctx) => repo.setStudioBatchProvider(ctx.tx, req.agencyId, req.requestId, batchId));
  return { batchId };
}

/**
 * Job `aiFeatures.collectListingStudioBatch`: `IN_PROGRESS` until the provider's batch ends, then checks and writes
 * the answers (drafts for listings whose facts changed since submit are dropped: STALE) and marks the record DONE.
 * `giveUp` marks it GAVE_UP instead (the batch never ended).
 */
export async function collectListingStudioBulk(
  who: { requestId: string; agencyId: string; userId: string },
  options: { giveUp?: boolean } = {},
): Promise<{ status: 'IN_PROGRESS' } | { status: 'DONE'; outcome: StudioOutcome }> {
  const outcome: StudioOutcome = { written: {}, dropped: {} };
  const row = await withMemberCtx({ userId: who.userId, agencyId: who.agencyId, requestId: who.requestId }, (ctx) =>
    repo.getStudioBatch(ctx.tx, who.agencyId, who.requestId),
  );
  // S13-F14: a record whose batch id was never saved (`items` recorded, submitted under the request's key) is collected
  // by the key; one with nothing recorded was never submitted.
  if (row?.state !== 'RUNNING' || (!row.providerBatchId && (row.items as StoredItem[]).length === 0))
    return { status: 'DONE', outcome };
  const req: StudioRequest = {
    requestId: who.requestId,
    agencyId: who.agencyId,
    userId: who.userId,
    listingIds: row.listingIds,
    locales: row.locales,
    tone: row.tone as ListingStudioTone,
    replaceReviewed: row.replaceReviewed,
  };
  // S13-F17: Listing Studio switched off since the submit: the batch is not collected (no provider call), given up.
  const { gate, plan } = await withMemberCtx(member(req), async (ctx) => ({
    gate: await studioGate(ctx),
    plan: (await billing.planOf(ctx.tx, req.agencyId)).code,
  }));
  req.plan = plan;
  if (options.giveUp || !gate.studio) {
    await finish(req, 'GAVE_UP', outcome);
    return { status: 'DONE', outcome };
  }
  const items = row.items as StoredItem[];
  // a saved id (also batches submitted before S13-F14, without a key); else the request's key
  const ref = row.providerBatchId ? { batchId: row.providerBatchId } : { idempotencyKey: req.requestId };
  const res = await ai.collectBatch(aiCtxOf(req), { ...ref, request: batchRequest(req, items) });
  if (res.status === 'IN_PROGRESS') return res;
  if (res.status === 'NOT_SUBMITTED') {
    // S13-F14: the crashed submit never reached the provider (its claim is gone): submitted now, polled from here
    const sent = await sendBatch(req, items, row.factsHashes, outcome, gate);
    return sent === 'DONE' ? { status: 'DONE', outcome } : { status: 'IN_PROGRESS' };
  }
  await applyResults(req, items, row.factsHashes, res.results, outcome, gate);
  await finish(req, 'DONE', outcome);
  return { status: 'DONE', outcome };
}

/**
 * A batch whose member lost access (left the agency, agency suspended) can no longer be collected as them: the job
 * marks it GAVE_UP on a system transaction (`withSystem`, worker only).
 */
export async function abandonListingStudioBatch(tx: Tx, agencyId: string, id: string): Promise<boolean> {
  return repo.finishStudioBatch(tx, agencyId, id, { state: 'GAVE_UP', written: 0, dropped: 0 });
}

/** Job `aiFeatures.pruneListingStudioBatches` (all agencies, `withSystem`): records older than `before`. */
export async function pruneListingStudioBatches(tx: Tx, before: Date, limit: number): Promise<number> {
  return repo.pruneStudioBatches(tx, before, limit);
}
