-- R2-02g: consent records get the source `UNSUBSCRIBE_LINK` (a client's one-click unsubscribe). NOT VALID + VALIDATE:
-- the new check never holds an exclusive lock while it scans the existing rows.
ALTER TABLE "consent_records" DROP CONSTRAINT "consent_records_source_ck";--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_source_ck" CHECK ("consent_records"."source" in ('DASHBOARD', 'WEBSITE', 'PORTAL', 'IMPORT', 'MERGE', 'UNSUBSCRIBE_LINK')) NOT VALID;--> statement-breakpoint
ALTER TABLE "consent_records" VALIDATE CONSTRAINT "consent_records_source_ck";
