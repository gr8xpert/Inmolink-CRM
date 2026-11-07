/** dedupe DTOs (PATTERNS §9): Zod schemas and inferred types for params, bodies and responses. */
import { z } from 'zod';

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
