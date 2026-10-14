import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/**
 * taxonomy events (PATTERNS §8), emitted with `emit(tx, …)` in the same transaction as the write. IDs only.
 * Taxonomy is platform data, so the events belong to the platform agency (`PLATFORM_AGENCY_ID`).
 */
export const TAXONOMY_ENTITIES = [
  'location',
  'locationAlias',
  'locationGroup',
  'propertyTypeGroup',
  'propertyType',
  'propertyTypeAlias',
  'featureGroup',
  'feature',
  'featureAlias',
] as const;
export type TaxonomyEntity = (typeof TAXONOMY_ENTITIES)[number];

export const taxonomyEvents = {
  /**
   * A location, location group, property type, feature (or a group or feed alias of one) was created (S2-03).
   * The taxonomy cache invalidates on it; feed mapping (S6) re-tries unmatched values on new aliases.
   */
  changed: defineEvent('taxonomy.data.changed', 1, z.object({ entity: z.enum(TAXONOMY_ENTITIES), id: z.uuid() })),
};
