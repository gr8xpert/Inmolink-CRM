// Before anything loads pg/ioredis: the ESM loader hook + instrumentations (same preload as the Node apps).
import '@inmolink/platform/telemetry/register';
import { loadStackEnv } from '@inmolink/core';
import { coreEnv, loadConfig, telemetryEnv } from '@inmolink/platform/config';
import { reportError, startObservability } from '@inmolink/platform/telemetry';
import type { Instrumentation } from 'next';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import { loadWebConfig } from './server/env';

loadStackEnv('dev', { allowExample: false });
const config = loadConfig({ NODE_ENV: coreEnv.NODE_ENV, ...telemetryEnv });

// Web is scraped through its own request logs for now; the RED metrics endpoint is on the API apps.
// Internet-facing: a client's traceparent must not force sampling.
startObservability(config, { service: 'web', trustRemoteParent: false });

// Fail the boot, not the first login, when the server env is incomplete (deploy health checks pass otherwise).
if (process.env.NEXT_PHASE !== PHASE_PRODUCTION_BUILD) loadWebConfig();

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function reportRequestError(
  err: unknown,
  request: Parameters<Instrumentation.onRequestError>[1],
  context: Parameters<Instrumentation.onRequestError>[2],
): void {
  const header = request.headers['x-request-id'];
  const requestId = typeof header === 'string' && REQUEST_ID.test(header) ? header : undefined;
  const digest = typeof err === 'object' && err !== null && 'digest' in err ? String(err.digest) : undefined;
  reportError(err, {
    requestId,
    route: context.routePath,
    routeType: context.routeType,
    method: request.method,
    digest,
  });
}
