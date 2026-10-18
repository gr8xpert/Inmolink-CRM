CREATE TABLE "search_index_queue" (
	"target_id" uuid PRIMARY KEY NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "search_index_queue_queued_idx" ON "search_index_queue" USING btree ("queued_at");