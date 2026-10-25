CREATE TABLE "listing_studio_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"listing_ids" uuid[] NOT NULL,
	"locales" text[] NOT NULL,
	"tone" text NOT NULL,
	"replace_reviewed" boolean DEFAULT false NOT NULL,
	"facts_hashes" text[] NOT NULL,
	"items" jsonb NOT NULL,
	"provider_batch_id" text,
	"state" text DEFAULT 'RUNNING' NOT NULL,
	"written" integer DEFAULT 0 NOT NULL,
	"dropped" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "listing_studio_batches_state_ck" CHECK ("listing_studio_batches"."state" in ('RUNNING', 'DONE', 'GAVE_UP')),
	CONSTRAINT "listing_studio_batches_sizes_ck" CHECK (cardinality("listing_studio_batches"."listing_ids") between 1 and 100 and cardinality("listing_studio_batches"."facts_hashes") = cardinality("listing_studio_batches"."listing_ids")
        and cardinality("listing_studio_batches"."locales") between 1 and 20)
);
--> statement-breakpoint
ALTER TABLE "listing_studio_batches" ADD CONSTRAINT "listing_studio_batches_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listing_studio_batches_agency_created_idx" ON "listing_studio_batches" USING btree ("agency_id","created_at");--> statement-breakpoint
CREATE INDEX "listing_studio_batches_created_idx" ON "listing_studio_batches" USING btree ("created_at");