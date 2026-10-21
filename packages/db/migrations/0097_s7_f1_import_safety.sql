CREATE TABLE "feed_sheet_releases" (
	"agency_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"released_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feed_sheet_releases_pk" PRIMARY KEY("agency_id","file_id")
);
--> statement-breakpoint
ALTER TABLE "feed_connections" DROP CONSTRAINT "feed_connections_pause_ck";--> statement-breakpoint
ALTER TABLE "feed_connections" ADD COLUMN "staff_resume_reason" text;--> statement-breakpoint
ALTER TABLE "feed_sheet_releases" ADD CONSTRAINT "feed_sheet_releases_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feed_sheet_releases_released_at_idx" ON "feed_sheet_releases" USING btree ("released_at");--> statement-breakpoint
CREATE INDEX "feed_connections_sheet_url_idx" ON "feed_connections" USING btree ("url") WHERE "feed_connections"."connector" = 'sheet-mapped';--> statement-breakpoint
ALTER TABLE "feed_connections" ADD CONSTRAINT "feed_connections_staff_resume_reason_ck" CHECK (char_length("feed_connections"."staff_resume_reason") <= 500);--> statement-breakpoint
ALTER TABLE "feed_connections" ADD CONSTRAINT "feed_connections_pause_ck" CHECK (("feed_connections"."paused_at" is null) = ("feed_connections"."pause_reason" is null)
        and ("feed_connections"."pause_reason" is null or "feed_connections"."pause_reason" in ('VOLUME_SPIKE', 'MASS_WITHDRAWAL', 'EMPTY_FEED')));