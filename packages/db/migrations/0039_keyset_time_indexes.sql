DROP INDEX "agencies_created_idx";--> statement-breakpoint
DROP INDEX "staff_impersonations_agency_idx";--> statement-breakpoint
CREATE INDEX "agencies_created_idx" ON "agencies" USING btree (date_trunc('milliseconds', "created_at", 'UTC'),"agency_id");--> statement-breakpoint
CREATE INDEX "staff_impersonations_agency_idx" ON "staff_impersonations" USING btree ("agency_id",date_trunc('milliseconds', "started_at", 'UTC'),"id");