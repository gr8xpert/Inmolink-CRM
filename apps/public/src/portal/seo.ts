/**
 * Structured data and alternates for portal pages (S15-01). S15-F7: built in core (`website-api/portal-seo.ts`,
 * PATTERNS §19: `portalMetadataFor`, `portalCrumbs`, `portalJsonLd`); re-exported for the views and tests.
 */
export {
  type AgencyLd,
  agencyJsonLd,
  breadcrumbJsonLd,
  type Crumb,
  type DevelopmentLd,
  developmentJsonLd,
  type ListingLd,
  languageAlternates,
  listingJsonLd,
  serializeJsonLd,
} from '@inmolink/core/modules/website-api';
