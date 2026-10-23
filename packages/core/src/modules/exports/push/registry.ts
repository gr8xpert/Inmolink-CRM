/**
 * Push portals (S9-04): which channels are push-style, their adapters and the process settings (endpoints) the worker
 * sets at boot. A push channel is listed PLANNED in the catalog and becomes usable per agency when its feature flag
 * `exports.portal.<code>` is on (`portalFlagKey`, the same switch as the unconfirmed feed portals). Nothing here
 * reads tenant state; the flag check takes the caller's `FlagCtx`.
 */
import { type FlagCtx, flag } from '@inmolink/platform/flags';
import { portalFlagKey } from '../profiles';
import { fotocasaAdapter } from './fotocasa';
import type { PortalEndpoints } from './http';
import { idealistaAdapter } from './idealista';
import type { PortalAdapter } from './types';

export const PUSH_ADAPTERS: Readonly<Record<string, PortalAdapter>> = {
  idealista: idealistaAdapter,
  fotocasa: fotocasaAdapter,
};

export const PUSH_CHANNEL_CODES: readonly string[] = Object.keys(PUSH_ADAPTERS);

export const pushAdapterOf = (channelCode: string): PortalAdapter | null => PUSH_ADAPTERS[channelCode] ?? null;
export const isPushChannel = (channelCode: string): boolean => channelCode in PUSH_ADAPTERS;

/** Whether the agency may use a push channel now: the portal has an adapter and its flag is on for the agency. */
export async function pushChannelEnabled(ctx: FlagCtx, channelCode: string): Promise<boolean> {
  return isPushChannel(channelCode) && (await flag(ctx, portalFlagKey(channelCode)));
}

export interface PortalPushConfig {
  /** Per channel code: the partner API's base URL and token URL (sandbox or production). Absent: not configured. */
  endpoints: Readonly<Record<string, PortalEndpoints>>;
  /** Tests: options handed to safe-fetch (a resolver for the fake server). */
  fetchOptions?: { resolver?: import('@inmolink/platform/safe-fetch').Resolver };
  /** Largest number of calls one run makes per connection (the rest waits for the next run). */
  maxCallsPerRun?: number;
  /** Time one run (all the agency's connections together) may spend before it hands over to a continuation. */
  runBudgetMs?: number;
  /** Listings per selection round (default: the feed batch). */
  batchSize?: number;
}

export const DEFAULT_PUSH_CALLS_PER_RUN = 200;

let current: PortalPushConfig = { endpoints: {} };

/** Boot (worker): the endpoints of the push portals that have credentials from H6. */
export function configurePortalPush(next: PortalPushConfig): void {
  for (const [code, e] of Object.entries(next.endpoints)) {
    if (!isPushChannel(code)) throw new Error(`exports: ${code} is not a push portal`);
    if (!e.apiBase || !e.tokenUrl) throw new Error(`exports: ${code} needs apiBase and tokenUrl`);
  }
  current = next;
}

export const portalPushConfig = (): PortalPushConfig => current;
