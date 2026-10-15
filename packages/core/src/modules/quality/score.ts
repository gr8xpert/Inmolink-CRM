/**
 * The listing quality score v1 (S3-08, PLAN §7 M2, §10): a pure function of what the listing has, so the editor's
 * live score and the stored one (ranking, nudges) never disagree. Weights and targets live in
 * `@inmolink/contracts` (`QUALITY_COMPONENTS`), shared with the web.
 */
import {
  type CeeRating,
  LISTING_CONFIRM_PROMPT_DAYS,
  LISTING_NETWORK_HIDE_DAYS,
  type ListingQualityDto,
  type ListingStatus,
  type LocationPrecision,
  QUALITY_COMPONENTS,
  QUALITY_DESCRIPTION_TARGET,
  QUALITY_MIN_LONG_EDGE_PX,
  QUALITY_PHOTOS_TARGET,
  type QualityComponentKey,
  type QualityHint,
} from '@inmolink/contracts';

const DAY_MS = 86_400_000;
/** An approximate pin earns this share of the location points (a privacy choice, but less useful to buyers). */
const APPROX_LOCATION_SHARE = 0.6;
/** Between the prompt and the hide, freshness earns half its points. */
const DUE_FRESHNESS_SHARE = 0.5;

export interface QualityFacts {
  /** Each photo's pixel size; null while it is still processing. */
  images: ({ width: number; height: number } | null)[];
  /** Description length per translated locale. */
  descriptions: { locale: string; length: number }[];
  /** The agency's languages: each should have a description. */
  locales: readonly string[];
  /** Freshness counts only for ACTIVE listings (the sweep prompts and hides only those). */
  status: ListingStatus;
  hasCoordinates: boolean;
  locationPrecision: LocationPrecision;
  energyRating: CeeRating | null;
  lastConfirmedAt: Date;
  networkHiddenAt: Date | null;
  now: Date;
}

export type QualityResult = Omit<ListingQualityDto, 'listingId'>;

/** `max × share`, rounded, within 0…max. */
const part = (max: number, share: number) => Math.round(max * Math.min(1, Math.max(0, share)));

export function scoreListing(f: QualityFacts): QualityResult {
  const points = {} as Record<QualityComponentKey, number>;
  const hints: QualityHint[] = [];
  const award = (key: QualityComponentKey, earned: number, hint?: Omit<QualityHint, 'gain'>) => {
    const max = QUALITY_COMPONENTS[key];
    points[key] = earned;
    if (hint && earned < max) hints.push({ ...hint, gain: max - earned });
  };

  const photos = f.images.length;
  award('photos', part(QUALITY_COMPONENTS.photos, photos / QUALITY_PHOTOS_TARGET), {
    code: 'PHOTOS_FEW',
    section: 'media',
    params: { count: photos, target: QUALITY_PHOTOS_TARGET },
  });

  // Resolution of the processed photos; photos still processing are not held against the listing.
  const sized = f.images.filter((i) => i !== null);
  const pendingPhotos = photos - sized.length;
  const sharp = sized.filter((i) => Math.max(i.width, i.height) >= QUALITY_MIN_LONG_EDGE_PX).length;
  const resolutionShare = photos === 0 ? 0 : sized.length === 0 ? 1 : sharp / sized.length;
  award(
    'resolution',
    part(QUALITY_COMPONENTS.resolution, resolutionShare),
    photos === 0
      ? undefined // the photo hint covers it
      : {
          code: 'PHOTOS_LOW_RES',
          section: 'media',
          params: { count: sized.length - sharp, minPx: QUALITY_MIN_LONG_EDGE_PX },
        },
  );

  const longest = f.descriptions.reduce((m, d) => Math.max(m, d.length), 0);
  award('description', part(QUALITY_COMPONENTS.description, longest / QUALITY_DESCRIPTION_TARGET), {
    code: 'DESCRIPTION_SHORT',
    section: 'translations',
    params: { length: longest, target: QUALITY_DESCRIPTION_TARGET },
  });

  const described = new Set(f.descriptions.filter((d) => d.length > 0).map((d) => d.locale));
  const wanted = [...new Set(f.locales)];
  const missing = wanted.filter((l) => !described.has(l));
  award(
    'translations',
    wanted.length === 0
      ? QUALITY_COMPONENTS.translations
      : part(QUALITY_COMPONENTS.translations, 1 - missing.length / wanted.length),
    {
      code: 'TRANSLATIONS_MISSING',
      section: 'translations',
      params: { count: missing.length, locales: missing.join(', ') },
    },
  );

  if (!f.hasCoordinates) {
    award('location', 0, { code: 'LOCATION_MISSING', section: 'location', params: {} });
  } else if (f.locationPrecision === 'APPROX') {
    award('location', part(QUALITY_COMPONENTS.location, APPROX_LOCATION_SHARE), {
      code: 'LOCATION_APPROX',
      section: 'location',
      params: {},
    });
  } else {
    award('location', QUALITY_COMPONENTS.location);
  }

  // A CEE rating that allows advertising: A–G or EXEMPT (PENDING is "in progress").
  const rated = f.energyRating !== null && f.energyRating !== 'PENDING';
  award('energy', rated ? QUALITY_COMPONENTS.energy : 0, {
    code: 'ENERGY_RATING_MISSING',
    section: 'specs',
    params: {},
  });

  const days = Math.floor((f.now.getTime() - f.lastConfirmedAt.getTime()) / DAY_MS);
  if (f.status !== 'ACTIVE') {
    award('freshness', QUALITY_COMPONENTS.freshness);
  } else if (f.networkHiddenAt !== null || days >= LISTING_NETWORK_HIDE_DAYS) {
    award('freshness', 0, {
      code: f.networkHiddenAt !== null ? 'NETWORK_HIDDEN' : 'CONFIRMATION_DUE',
      section: 'freshness',
      params: { days },
    });
  } else if (days >= LISTING_CONFIRM_PROMPT_DAYS) {
    award('freshness', part(QUALITY_COMPONENTS.freshness, DUE_FRESHNESS_SHARE), {
      code: 'CONFIRMATION_DUE',
      section: 'freshness',
      params: { days },
    });
  } else {
    award('freshness', QUALITY_COMPONENTS.freshness);
  }

  const keys = Object.keys(QUALITY_COMPONENTS) as QualityComponentKey[];
  return {
    score: keys.reduce((s, k) => s + points[k], 0),
    components: keys.map((key) => ({ key, points: points[key], max: QUALITY_COMPONENTS[key] })),
    hints: hints.sort((a, b) => b.gain - a.gain),
    pendingPhotos,
  };
}
