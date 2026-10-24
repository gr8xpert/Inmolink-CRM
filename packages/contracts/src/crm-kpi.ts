import { z } from 'zod';

/** Response-time KPI (S10-09, PLAN §3 #60). */
export const CRM_KPI_LIMITS = {
  /** The longest range of a KPI read (the leads of the range are aggregated in one pass). */
  rangeDays: 92,
} as const;

/**
 * `GET /v1/crm/kpis/response-time?from=&to=`: leads received in `[from, to)` (by the time they reached the inbox),
 * ≤ 92 days. Hand-entered leads are not measured.
 */
export const ResponseTimeQuery = z
  .object({ from: z.iso.datetime(), to: z.iso.datetime() })
  .refine((q) => Date.parse(q.from) < Date.parse(q.to), { message: 'from must be before to', path: ['to'] })
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= CRM_KPI_LIMITS.rangeDays * 86_400_000, {
    message: `at most ${CRM_KPI_LIMITS.rangeDays} days`,
    path: ['to'],
  });
export type ResponseTimeQuery = z.infer<typeof ResponseTimeQuery>;

/** Median and mean of the leads that got a human response; null when none did. */
const seconds = z.number().int().min(0).nullable();

export const ResponseTimeAgentDto = z.strictObject({
  userId: z.uuid(),
  name: z.string().nullable(),
  /** Leads this member answered first (in the range). */
  responded: z.number().int().min(0),
  medianSeconds: seconds,
  avgSeconds: seconds,
});
export type ResponseTimeAgentDto = z.infer<typeof ResponseTimeAgentDto>;

export const ResponseTimeKpiDto = z.strictObject({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  /** Measured leads received in the range. */
  leads: z.number().int().min(0),
  /** … that got a human response. The others are `leads - responded` and stay out of the medians. */
  responded: z.number().int().min(0),
  medianSeconds: seconds,
  avgSeconds: seconds,
  /** Per first responder, fastest median first. */
  agents: z.array(ResponseTimeAgentDto),
});
export type ResponseTimeKpiDto = z.infer<typeof ResponseTimeKpiDto>;
