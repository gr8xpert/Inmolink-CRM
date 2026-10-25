import { createHash } from 'node:crypto';
import { SOCIAL_LIMITS } from '@inmolink/contracts';
import { withSystem } from '@inmolink/db';
import { ai, aiOrFallback, untrustedBlock } from '@inmolink/platform/ai';
import { clock } from '@inmolink/platform/clock';
import { cutAtWord } from '../../white-label';
import * as agencies from '../agencies';
import * as billing from '../billing';
import * as properties from '../properties';
import * as taxonomy from '../taxonomy';
import { allowedNumbers, CAPTIONS_PROMPT, CaptionsAnswer, type Facts, numbersMatchFacts } from './caption-facts';
import { networkPostable, whiteLabelled } from './publish';
import * as repo from './repo';

/**
 * AI captions per language and platform (S12-07, PLAN §3 #58), `social.generateCaptions` (pool `ai`, one per
 * `social.captions.requested` event, job ID = the request's id). The listing's facts (type, place, bedrooms, bathrooms,
 * areas, price) are data the prompt must not change; its description goes in as an untrusted block (prompt injection).
 * Each answer is checked: every number in a caption must be one of the facts' numbers (no invented figures), and the
 * caption passes the white-label pass before it is stored (a network listing's owner never shows). Captions may
 * publish as drafted (`origin: AI_DRAFT`; the member can edit them). A newer request makes this one's answer stale; a
 * gateway refusal (budget, outage, invalid output) leaves the post's captions as they were and `captionStatus` FAILED.
 * S13-F17: an agency that switched `SOCIAL_CAPTIONS` off since the request gets no model call: FAILED, captions kept.
 */

export async function generateCaptions(p: {
  postId: string;
  agencyId: string;
  requestId: string;
  locales: string[];
}): Promise<{ captions: number; status: 'READY' | 'FAILED' | 'STALE' }> {
  const loaded = await withSystem(`social.generateCaptions: post ${p.postId}`, async (tx) => {
    const post = await repo.lockPost(tx, p.postId);
    if (!post || post.agencyId !== p.agencyId || post.captionRequestId !== p.requestId) return null;
    if (post.status !== 'DRAFT' && post.status !== 'SCHEDULED') return null;
    const account = await repo.accountWithTokens(tx, post.accountId);
    const [listing] = await properties.listingsForReadModels(tx, [post.listingId]);
    // S12-07 review: another agency's listing only while it is still shared with the posting agency.
    if (!account || !listing || !(await networkPostable(tx, post.agencyId, listing))) {
      return { post, account: null, listing: null, facts: null, description: '', plan: null };
    }
    const tax = await taxonomy.taxonomyForReadModels(
      tx,
      { locations: [listing.locationId], propertyTypes: [listing.propertyTypeId], features: [] },
      p.locales,
    );
    const locale = p.locales[0] as string;
    const facts: Facts = {
      transaction: listing.transactionType,
      propertyType: taxonomy.taxonName(tax, listing.propertyTypeId, locale)?.name ?? null,
      place: taxonomy.taxonName(tax, listing.locationId, locale)?.name ?? null,
      bedrooms: listing.bedrooms,
      bathrooms: listing.bathrooms,
      builtM2: listing.builtM2,
      plotM2: listing.plotM2,
      terraceM2: listing.terraceM2,
      price:
        listing.priceCents !== null && !listing.priceOnRequest
          ? { amount: Math.round(listing.priceCents / 100), currency: listing.currency, period: listing.pricePeriod }
          : null,
      energyRating: listing.energyRating,
    };
    const text =
      listing.translations.find((t) => t.locale === post.locale)?.description ??
      listing.translations[0]?.description ??
      '';
    // The model never sees the owner's identity of a network listing (white label before, and again after).
    // S12-07 review: the owner's text as stored (whiteLabelled takes its plain text), so its cached model removals
    // (keyed by that plain text, S12-03) apply.
    const description = cutAtWord(await whiteLabelled(tx, text, listing, post.agencyId), 3_000);
    // S13-F21: the agency's plan in force, once per job: the call is metered against its plan budget.
    const plan = (await billing.planOf(tx, post.agencyId)).code;
    return { post, account, listing, facts, description, plan };
  });
  if (!loaded) return { captions: 0, status: 'STALE' };
  const save = (patch: { captions: repo.Captions; captionStatus: repo.CaptionStatus; caption?: string | null }) =>
    withSystem(`social.generateCaptions: save ${p.postId}`, (tx) =>
      repo.saveCaptions(tx, p.postId, p.requestId, patch, clock.now()),
    );
  const { post, account, listing, facts } = loaded;
  if (!account || !listing || !facts || !(await agencies.aiFeatureEnabled(p.agencyId, 'SOCIAL_CAPTIONS'))) {
    await save({ captions: post.captions, captionStatus: 'FAILED' });
    return { captions: 0, status: 'FAILED' };
  }
  const input = {
    platform: account.platform,
    locales: p.locales,
    facts,
    description: loaded.description ? untrustedBlock('listing_text', loaded.description) : null,
  };
  const answer = await aiOrFallback(
    () =>
      ai.structured(
        { tenant: { agencyId: p.agencyId, plan: loaded.plan }, requestId: p.requestId },
        {
          feature: 'social.captions',
          prompt: CAPTIONS_PROMPT,
          input,
          schema: CaptionsAnswer,
          cacheKey: createHash('sha256')
            .update(`${listing.id}:${listing.version}:${account.platform}:${p.locales.join(',')}`)
            .digest('hex'),
        },
      ),
    () => null,
  );
  if (!answer) {
    await save({ captions: post.captions, captionStatus: 'FAILED' });
    return { captions: 0, status: 'FAILED' };
  }
  const allowed = allowedNumbers(facts);
  const drafted: repo.Captions = [];
  for (const c of answer.data.captions) {
    if (!p.locales.includes(c.locale) || drafted.some((d) => d.locale === c.locale)) continue;
    if (!numbersMatchFacts(c.text, allowed)) continue; // an invented figure: dropped
    const clean = await withSystem('social.generateCaptions: white label', (tx) =>
      whiteLabelled(tx, c.text, listing, post.agencyId),
    );
    if (clean.trim())
      drafted.push({ locale: c.locale, text: cutAtWord(clean, SOCIAL_LIMITS.captionChars), origin: 'AI_DRAFT' });
  }
  if (drafted.length === 0) {
    await save({ captions: post.captions, captionStatus: 'FAILED' });
    return { captions: 0, status: 'FAILED' };
  }
  // The drafts replace earlier drafts of their languages; typed captions stay.
  const kept = post.captions.filter((c) => c.origin === 'HUMAN' || !drafted.some((d) => d.locale === c.locale));
  const forLocale = drafted.find((d) => d.locale === post.locale);
  await save({
    captions: [...kept, ...drafted],
    captionStatus: 'READY',
    ...(post.caption === null && forLocale ? { caption: forLocale.text } : {}),
  });
  return { captions: drafted.length, status: 'READY' };
}
