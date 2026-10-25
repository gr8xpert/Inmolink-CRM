import { readFileSync } from 'node:fs';
import { BillingCurrency, BillingInterval, CatalogCode, PlanFeature } from '@inmolink/contracts';
import { z } from 'zod';

/** The plan catalog file's shape (S13-01, `scripts/ops/billing-catalog.json`): prices are data, never code. */
export const CatalogFile = z.object({
  $comment: z.string().optional(),
  items: z
    .array(
      z
        .object({
          code: CatalogCode,
          kind: z.enum(['PLAN', 'ADDON']),
          seatsIncluded: z.number().int().min(1).max(10_000).nullable(),
          rank: z.number().int().min(0).max(10_000),
          /** S13-02: the gated features a plan includes (the plan matrix as data). */
          features: z.array(PlanFeature).max(100).optional(),
          /** S13-F19: the Stripe Tax product tax code (`txcd_…`) sent on the Stripe product; null/absent: the account's preset. */
          taxCode: z
            .string()
            .regex(/^txcd_\d{8}$/)
            .nullable()
            .optional(),
          prices: z.array(
            z
              .object({ interval: BillingInterval, currency: BillingCurrency, amountCents: z.number().int().min(0) })
              .strict(),
          ),
        })
        .strict(),
    )
    .max(100),
});

export const DEFAULT_CATALOG_FILE = new URL('./billing-catalog.json', import.meta.url);

/** A catalog file's items (default: the bundled working assumptions of PLAN §11). */
export function readCatalog(file: string | URL = DEFAULT_CATALOG_FILE) {
  return CatalogFile.parse(JSON.parse(readFileSync(file, 'utf8'))).items;
}
