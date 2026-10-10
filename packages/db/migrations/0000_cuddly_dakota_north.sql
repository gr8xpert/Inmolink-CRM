CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"type" text NOT NULL,
	"version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"dead_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" USING btree ("available_at","id") WHERE "outbox_events"."processed_at" is null;--> statement-breakpoint
CREATE INDEX "outbox_events_processed_idx" ON "outbox_events" USING btree ("processed_at") WHERE "outbox_events"."processed_at" is not null;--> statement-breakpoint
CREATE INDEX "outbox_events_type_created_idx" ON "outbox_events" USING btree ("type","created_at");