import { withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { reportRehashPending } from './alerts';
import {
  clientFingerprints,
  currentFingerprintKeyId,
  mlsConfigured,
  registeredClientCipher,
  rotationEndsAt,
  rotationWindowOpen,
} from './config';
import * as repo from './repo';

/**
 * mls worker work (app_system, `withSystem` with an audit reason): the HMAC rotation rehash (S11-F13 runbook,
 * "fingerprint-style HMACs") and the fingerprints' retention.
 */

const REHASH_BATCH = 500;
const AGENCY_PAGE = 1_000;
const PRUNE_BATCH = 1_000;
const PRUNE_MAX_BATCHES = 50;
/** S12-F8: `fingerprintsPending` counts up to this many (the alert needs "any", the runbook a rough size). */
export const PENDING_COUNT_CAP = 100_000;
/** S12-F8: the alert window — pending fingerprints this close to `HMAC_KEY_PREVIOUS_UNTIL` page ops. */
export const REHASH_ALERT_BEFORE_MS = 24 * 3_600_000;
/** Expired fingerprints block nothing; kept this long after expiry for support questions, then deleted. */
export const FINGERPRINT_RETENTION_DAYS = 30;

/**
 * The agencies the rehash must visit: those with a registration still valid. Empty outside a rotation window (or in a
 * process without mls configured): nothing to do.
 */
export async function agenciesToRehash(): Promise<string[]> {
  if (!mlsConfigured() || !rotationWindowOpen()) return [];
  const all: string[] = [];
  let after: string | null = null;
  for (;;) {
    const page = await withSystem('mls.rehashFingerprints: list agencies with valid registrations', (tx) =>
      repo.agenciesWithValid(tx, after, AGENCY_PAGE),
    );
    all.push(...page);
    if (page.length < AGENCY_PAGE) return all;
    after = page.at(-1) ?? null;
  }
}

/**
 * One agency's rehash during an HMAC rotation window: every registration still valid gets its current-key fingerprints
 * (recomputed from the encrypted snapshot), so it keeps blocking once the previous key is gone. Batches of 500, one
 * transaction each; idempotent (fingerprints already there are skipped): a pass that adds nothing for every agency is
 * the runbook's condition to close the window.
 */
export async function rehashAgencyFingerprints(agencyId: string): Promise<{ registrations: number; added: number }> {
  let after: string | null = null;
  let registrations = 0;
  let added = 0;
  for (;;) {
    const batch = await withSystem(`mls.rehashFingerprints: agency ${agencyId}`, async (tx) => {
      const rows = await repo.validBatch(tx, agencyId, after, REHASH_BATCH);
      const keyId = currentFingerprintKeyId();
      const prints = rows.flatMap((r) =>
        clientFingerprints(registeredClientCipher.decrypt(agencyId, r.id, r.detailsEnc)).current.map((fingerprint) => ({
          registrationId: r.id,
          fingerprint,
          keyId,
        })),
      );
      return { rows, added: (await repo.addFingerprints(tx, agencyId, prints)).added };
    });
    registrations += batch.rows.length;
    added += batch.added;
    if (batch.rows.length < REHASH_BATCH) return { registrations, added };
    after = batch.rows.at(-1)?.id ?? null;
  }
}

/** S12-F8: limits the pending count to some agencies (support looking at one agency; tests on the shared DB). */
export interface PendingScope {
  agencyIds?: readonly string[];
}

/**
 * S12-F8: valid registrations without a fingerprint under the current `HMAC_KEY` (capped at `PENDING_COUNT_CAP`) —
 * what the rehash still has to do. The runbook closes a rotation window only at 0 (step 10).
 */
export async function fingerprintsPending(scope: PendingScope = {}): Promise<number> {
  if (!mlsConfigured()) return 0;
  const keyId = currentFingerprintKeyId();
  return withSystem('mls.fingerprintsPending: valid registrations without current-key fingerprints', (tx) =>
    repo.countPendingFingerprints(tx, keyId, PENDING_COUNT_CAP, scope.agencyIds),
  );
}

/**
 * S12-F8, the worker check (`mls.checkFingerprintRehash`): within `REHASH_ALERT_BEFORE_MS` of the window's end, any
 * pending registration raises `HmacRotationRehashPending` (gauge + warning log). Outside that stretch nothing is counted
 * and the gauge reads 0.
 */
export async function checkFingerprintRehash(
  scope: PendingScope = {},
): Promise<{ pending: number; alert: boolean; endsAt: string | null }> {
  const endsAt = mlsConfigured() ? rotationEndsAt() : null;
  if (!endsAt || endsAt.getTime() - clock.nowMs() > REHASH_ALERT_BEFORE_MS) {
    reportRehashPending(0, endsAt);
    return { pending: 0, alert: false, endsAt: endsAt?.toISOString() ?? null };
  }
  const pending = await fingerprintsPending(scope);
  reportRehashPending(pending, endsAt);
  return { pending, alert: pending > 0, endsAt: endsAt.toISOString() };
}

/**
 * Retention (daily): fingerprints that expired more than 30 days ago are deleted, in batches of 1,000 (one transaction
 * each). The registrations and the owners' receipts are kept: they are the evidence of who registered a client first.
 */
export async function pruneExpiredFingerprints(): Promise<{ deleted: number }> {
  const before = new Date(clock.nowMs() - FINGERPRINT_RETENTION_DAYS * 86_400_000);
  let deleted = 0;
  for (let i = 0; i < PRUNE_MAX_BATCHES; i++) {
    const n = await withSystem('mls.pruneFingerprints: expired client fingerprints', (tx) =>
      repo.pruneExpiredFingerprints(tx, before, PRUNE_BATCH),
    );
    deleted += n;
    if (n < PRUNE_BATCH) break;
  }
  return { deleted };
}
