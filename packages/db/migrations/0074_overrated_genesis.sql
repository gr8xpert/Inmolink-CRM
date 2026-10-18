CREATE TABLE "read_model_queue" (
	"target_id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"owner_agency_id" uuid NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rechecks" integer DEFAULT 0 NOT NULL,
	"claimed_until" timestamp with time zone,
	"claim_token" uuid
);
--> statement-breakpoint
CREATE INDEX "read_model_queue_agency_due_idx" ON "read_model_queue" USING btree ("owner_agency_id","due_at");