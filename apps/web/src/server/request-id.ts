import { type AuthCtx, authCtx } from '@inmolink/core';
import { newId, requestIdFrom } from '@inmolink/platform/ids';
import { headers } from 'next/headers';
import { webConfig } from './env';

/**
 * The request id for auth flows (S1-F4), as the API derives it: the edge's id header
 * (`EDGE_REQUEST_ID_HEADER`, e.g. `cf-ray`) when configured and well formed, else a fresh id. Never a
 * client-sent `x-request-id`. Outside a request (no headers) it is a fresh id too.
 */
export async function requestId(from?: Headers): Promise<string> {
  const { EDGE_REQUEST_ID_HEADER } = await webConfig();
  if (!EDGE_REQUEST_ID_HEADER) return newId();
  try {
    const h = from ?? (await headers());
    return requestIdFrom(h.get(EDGE_REQUEST_ID_HEADER));
  } catch {
    return newId();
  }
}

/** `authCtx` for this request: the anonymous auth flows (`app_auth`) with the request's id. */
export async function requestAuthCtx(from?: Headers): Promise<AuthCtx> {
  return authCtx(await requestId(from));
}
