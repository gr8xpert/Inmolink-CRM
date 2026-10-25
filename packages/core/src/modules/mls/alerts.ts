/**
 * mls alerts (S12-F8): the fingerprint rehash of an HMAC rotation (`docs/runbooks/hmac-key-rotation.md` step 10). A
 * gauge Prometheus alerts on (`HmacRotationRehashPending`, infra/monitoring/rules/security.yml) and a warning log line
 * with the same alert name — counts and the window's end only, never a fingerprint or an agency's client.
 */
import { createLogger, type Logger } from '@inmolink/platform/logger';
import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('@inmolink/core');
const pendingGauge = meter.createGauge('inmolink.mls.fingerprint_rehash.pending', {
  description:
    'Valid client registrations without a fingerprint under the current HMAC_KEY, within 24 h of HMAC_KEY_PREVIOUS_UNTIL (0 otherwise)',
});

let log: Logger | undefined;
let listener: ((pending: number) => void) | undefined;

/** Records the check's result; any pending registration also logs the alert. */
export function reportRehashPending(pending: number, endsAt: Date | null): void {
  pendingGauge.record(pending);
  if (pending > 0) {
    log ??= createLogger({ service: 'mls' });
    log.warn(
      { alert: 'HmacRotationRehashPending', pending, windowEndsAt: endsAt?.toISOString() ?? null },
      'mls: client fingerprints still under the previous HMAC key near the end of the rotation window',
    );
    listener?.(pending);
  }
}

/** Tests: observe raised alerts (undefined clears). */
export function onRehashPendingAlert(fn: ((pending: number) => void) | undefined): void {
  listener = fn;
}
