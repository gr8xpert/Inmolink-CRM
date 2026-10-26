CREATE TABLE "white_label_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"page_key" text NOT NULL,
	"items" jsonb NOT NULL,
	"cursor" jsonb,
	"provider_batch_id" text,
	"state" text DEFAULT 'RUNNING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "white_label_batches_state_ck" CHECK ("white_label_batches"."state" in ('RUNNING', 'DONE', 'GAVE_UP')),
	CONSTRAINT "white_label_batches_page_key_ck" CHECK (length("white_label_batches"."page_key") between 1 and 128)
);
--> statement-breakpoint
ALTER TABLE "white_label_batches" ADD CONSTRAINT "white_label_batches_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "white_label_batches_page_uq" ON "white_label_batches" USING btree ("agency_id","page_key");--> statement-breakpoint
CREATE INDEX "white_label_batches_created_idx" ON "white_label_batches" USING btree ("created_at");