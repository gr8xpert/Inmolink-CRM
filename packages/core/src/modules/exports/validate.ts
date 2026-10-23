/**
 * Pre-export validation (S9-02, PLAN §7 M7): one listing against its portal's profile. Pure. Every reason is a code
 * with numbers (`PortalIssue`), never a sentence — the dashboard words them per locale. A listing with any issue is
 * left out of the feed; the others still go out. The thresholds are the profile's (`profiles.ts`), nowhere else.
 */
import type { PortalIssue } from '@inmolink/contracts';
import { type FeedItem, feedPictureUrls, kyeroBlocker } from '../../feed-xml';
import type { PortalProfile } from './profiles';

/** Characters of a description as the portal counts them (trimmed). */
const length = (text: string | null | undefined) => (text ?? '').trim().length;

export function validateItem(profile: PortalProfile, item: FeedItem): PortalIssue[] {
  const d = item.base;
  const issues: PortalIssue[] = [];

  if (profile.format === 'kyero-v3') {
    // The Kyero format cannot carry these at all; the writer would drop the listing, so say why up front.
    // `KyeroBlocker` values are portal issue codes: reported as they are, so the writer's drop and the issue agree.
    const blocker = kyeroBlocker(d);
    if (blocker !== null) issues.push({ code: blocker });
  }
  if (profile.priceOnRequest === 'refused' && d.price.onRequest && !issues.some((i) => i.code === 'PRICE_ON_REQUEST')) {
    issues.push({ code: 'PRICE_ON_REQUEST' });
  }
  if (!d.price.onRequest && (d.price.amountCents === null || d.price.amountCents <= 0)) {
    if (profile.format !== 'kyero-v3') issues.push({ code: 'PRICE_MISSING' });
  }

  if (profile.energyRating === 'required' && d.kind === 'LISTING' && d.energyRating === null) {
    issues.push({ code: 'ENERGY_RATING_MISSING' });
  }

  const photos = feedPictureUrls(d).length;
  if (photos < profile.minPhotos)
    issues.push({ code: 'PHOTOS_TOO_FEW', params: { min: profile.minPhotos, actual: photos } });

  const lengths = [...item.texts.values()].map((t) => length(t.description)).filter((n) => n > 0);
  if (profile.minDescriptionChars > 0) {
    if (lengths.length === 0) issues.push({ code: 'DESCRIPTION_MISSING' });
    else if (Math.max(...lengths) < profile.minDescriptionChars) {
      issues.push({
        code: 'DESCRIPTION_TOO_SHORT',
        params: { min: profile.minDescriptionChars, actual: Math.max(...lengths) },
      });
    }
  }
  if (profile.maxDescriptionChars !== null && lengths.some((n) => n > (profile.maxDescriptionChars as number))) {
    issues.push({
      code: 'DESCRIPTION_TOO_LONG',
      params: { max: profile.maxDescriptionChars, actual: Math.max(...lengths) },
    });
  }
  return issues;
}
