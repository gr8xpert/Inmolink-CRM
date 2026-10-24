ALTER TABLE "leads" ADD COLUMN "auto_ack_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "first_human_response_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "first_responder_user_id" uuid;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "response_seconds" integer;--> statement-breakpoint
CREATE INDEX "leads_agency_response_idx" ON "leads" USING btree ("agency_id","created_ms","first_responder_user_id","response_seconds") WHERE "leads"."source" <> 'MANUAL';--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_response_ck" CHECK (("leads"."first_human_response_at" is null) = ("leads"."response_seconds" is null)
        and ("leads"."response_seconds" is null or "leads"."response_seconds" >= 0)
        and ("leads"."first_responder_user_id" is null or "leads"."first_human_response_at" is not null));--> statement-breakpoint
-- backfill (pre-launch data, single statements): the acknowledgement time from the website lead
UPDATE "leads" l SET "auto_ack_sent_at" = w."ack_sent_at" FROM "website_leads" w WHERE w."id" = l."inbound_lead_id" AND w."ack_sent_at" IS NOT NULL;--> statement-breakpoint
-- the first human response: the earliest of the first logged reply / call / meeting by a member and the moment the lead
-- left NEW (the responder is the member of the logged activity when it is the earlier one, else unknown)
UPDATE "leads" l SET "first_human_response_at" = t."at",
  "first_responder_user_id" = CASE WHEN t."act_at" IS NOT NULL AND (l."first_responded_at" IS NULL OR t."act_at" <= l."first_responded_at") THEN t."uid" END,
  "response_seconds" = greatest(0, floor(extract(epoch from (t."at" - l."created_at"))))::int
  FROM (SELECT l2."id", a."at" AS "act_at", a."uid", least(a."at", l2."first_responded_at") AS "at" FROM "leads" l2
        LEFT JOIN (SELECT DISTINCT ON ("lead_id") "lead_id", "occurred_at" AS "at", "actor_user_id" AS "uid" FROM "activities"
                   WHERE "lead_id" IS NOT NULL AND "actor_user_id" IS NOT NULL AND "type" IN ('CALL', 'EMAIL', 'MEETING')
                   ORDER BY "lead_id", "occurred_at") a ON a."lead_id" = l2."id"
        WHERE a."at" IS NOT NULL OR l2."first_responded_at" IS NOT NULL) t
  WHERE t."id" = l."id";
