CREATE TABLE "deal_disputes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"deal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"opened_by_user_id" uuid NOT NULL,
	"resolved_by_user_id" uuid,
	"resolution_note" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deal_disputes_status_ck" CHECK ("deal_disputes"."status" in ('OPEN', 'RESOLVED')),
	CONSTRAINT "deal_disputes_reason_ck" CHECK (char_length("deal_disputes"."reason") between 1 and 2000),
	CONSTRAINT "deal_disputes_resolved_ck" CHECK (("deal_disputes"."status" = 'OPEN') = ("deal_disputes"."resolved_at" is null and "deal_disputes"."resolved_by_user_id" is null and "deal_disputes"."resolution_note" is null)),
	CONSTRAINT "deal_disputes_note_ck" CHECK ("deal_disputes"."resolution_note" is null or char_length("deal_disputes"."resolution_note") between 1 and 2000)
);
--> statement-breakpoint
ALTER TABLE "deal_disputes" ADD CONSTRAINT "deal_disputes_deal_fk" FOREIGN KEY ("agency_id","deal_id") REFERENCES "public"."deals"("agency_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deal_disputes_open_uq" ON "deal_disputes" USING btree ("agency_id","deal_id") WHERE "deal_disputes"."status" = 'OPEN';--> statement-breakpoint
CREATE INDEX "deal_disputes_deal_idx" ON "deal_disputes" USING btree ("agency_id","deal_id","created_at");--> statement-breakpoint
CREATE INDEX "deal_disputes_deal_id_idx" ON "deal_disputes" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "deal_disputes_status_idx" ON "deal_disputes" USING btree ("status","created_at","id");