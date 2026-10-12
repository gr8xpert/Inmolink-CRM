CREATE INDEX "audit_logs_time_idx" ON "audit_logs" USING btree ("occurred_at","id");--> statement-breakpoint
CREATE INDEX "audit_logs_type_idx" ON "audit_logs" USING btree ("type","occurred_at","id");