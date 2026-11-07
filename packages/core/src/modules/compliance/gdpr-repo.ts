import type { ConsentSource } from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import { consentRecords, dataExportJobs, retentionSettings } from '@inmolink/db/schema/compliance';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';

/**
 * GDPR queries (S16-04, PATTERNS §5): consent records, retention settings and the data exports an erasure expires.
 * Takes `tx`, selects only the columns it needs. Only `@inmolink/db/schema/compliance`.
 */

export interface ConsentInsert {
  id: string;
  agencyId: string;
  contactId: string;
  purpose: 'MARKETING' | 'PROCESSING';
  granted: boolean;
  source: ConsentSource;
  policyVersion: string | null;
  actorUserId: string | null;
  impersonatedBy: string | null;
  recordedAt?: Date;
}

/** One statement for any number of records; the time is the database's unless the record names one. */
export async function insertConsents(tx: Tx, rows: readonly ConsentInsert[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(consentRecords).values([...rows]);
}

/** A contact's history, newest first (`consent_records_contact_idx`), at most `limit`. */
export function consentsOf(tx: Tx, agencyId: string, contactId: string, limit: number) {
  return tx
    .select({
      id: consentRecords.id,
      purpose: consentRecords.purpose,
      granted: consentRecords.granted,
      source: consentRecords.source,
      policyVersion: consentRecords.policyVersion,
      actorUserId: consentRecords.actorUserId,
      impersonatedBy: consentRecords.impersonatedBy,
      recordedAt: consentRecords.recordedAt,
    })
    .from(consentRecords)
    .where(and(eq(consentRecords.agencyId, agencyId), eq(consentRecords.contactId, contactId)))
    .orderBy(desc(consentRecords.recordedAt), desc(consentRecords.id))
    .limit(limit);
}

export type ConsentRow = Awaited<ReturnType<typeof consentsOf>>[number];

export interface RetentionRow {
  months: number | null;
  previousMonths: number | null;
  effectiveAt: Date;
}

const retentionColumns = {
  months: retentionSettings.inactiveContactMonths,
  previousMonths: retentionSettings.previousMonths,
  effectiveAt: retentionSettings.effectiveAt,
};

export async function getRetention(tx: Tx, agencyId: string): Promise<RetentionRow | null> {
  const [row] = await tx
    .select(retentionColumns)
    .from(retentionSettings)
    .where(eq(retentionSettings.agencyId, agencyId));
  return row ?? null;
}

/** The agency's row, locked (`for update`) for a change. */
export async function lockRetention(tx: Tx, agencyId: string): Promise<RetentionRow | null> {
  const [row] = await tx
    .select(retentionColumns)
    .from(retentionSettings)
    .where(eq(retentionSettings.agencyId, agencyId))
    .for('update');
  return row ?? null;
}

export async function upsertRetention(
  tx: Tx,
  agencyId: string,
  row: RetentionRow & { updatedBy: string },
): Promise<void> {
  const values = {
    inactiveContactMonths: row.months,
    previousMonths: row.previousMonths,
    effectiveAt: row.effectiveAt,
    updatedBy: row.updatedBy,
  };
  await tx
    .insert(retentionSettings)
    .values({ agencyId, ...values })
    .onConflictDoUpdate({ target: retentionSettings.agencyId, set: { ...values, updatedAt: sql`now()` } });
}

/**
 * Agencies with a period in force at `now` — the chosen one once `effective_at` is past, the previous one before — in id
 * order after `after` (the daily job, `app_system`; the primary key, 5,000 rows at most).
 */
export async function retentionPage(
  tx: Tx,
  now: Date,
  after: string | null,
  limit: number,
): Promise<{ agencyId: string; months: number }[]> {
  const res = await tx.execute(sql`
    select agency_id as "agencyId", m.months from ${retentionSettings},
      lateral (select case when effective_at <= ${now.toISOString()}::timestamptz
                           then inactive_contact_months else previous_months end as months) m
     where m.months is not null ${after ? sql`and agency_id > ${after}::uuid` : sql``}
     order by agency_id
     limit ${limit}`);
  return res.rows as { agencyId: string; months: number }[];
}

/**
 * The data exports whose file may hold a person's data — those of some subjects (contact erasure), or every one of the
 * agency (agency erasure) — expire now (queued / running ones fail): the caller deletes their files after the commit
 * (`markExpired`), the daily sweep retries any it could not. Answers their ids.
 */
export async function expireExports(
  tx: Tx,
  agencyId: string,
  scope: { subjectContactIds: readonly string[] } | 'ALL',
): Promise<string[]> {
  const rows = await tx
    .update(dataExportJobs)
    .set({
      // a queued or running one fails: its run's outcome is then refused and the run deletes what it stored
      status: sql`case when ${dataExportJobs.status} in ('QUEUED', 'RUNNING') then 'FAILED' else ${dataExportJobs.status} end`,
      errorCode: sql`case when ${dataExportJobs.status} in ('QUEUED', 'RUNNING') then 'INTERNAL' else ${dataExportJobs.errorCode} end`,
      finishedAt: sql`coalesce(${dataExportJobs.finishedAt}, now())`,
      expiresAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(dataExportJobs.agencyId, agencyId),
        isNull(dataExportJobs.fileDeletedAt),
        scope === 'ALL'
          ? undefined
          : scope.subjectContactIds.length > 0
            ? or(
                inArray(dataExportJobs.kind, ['CONTACTS', 'LEADS', 'ACCOUNT']),
                inArray(dataExportJobs.subjectContactId, [...scope.subjectContactIds]),
              )
            : inArray(dataExportJobs.kind, ['CONTACTS', 'LEADS', 'ACCOUNT']),
      ),
    )
    .returning({ id: dataExportJobs.id });
  return rows.map((r) => r.id);
}
