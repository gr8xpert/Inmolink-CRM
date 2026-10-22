CREATE TABLE "feed_source_hashes" (
	"agency_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_ref" text NOT NULL,
	"hash" char(64) NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_run_id" uuid NOT NULL,
	CONSTRAINT "feed_source_hashes_pk" PRIMARY KEY("agency_id","connection_id","external_ref"),
	CONSTRAINT "feed_source_hashes_ref_ck" CHECK (char_length("feed_source_hashes"."external_ref") between 1 and 200),
	CONSTRAINT "feed_source_hashes_hash_ck" CHECK ("feed_source_hashes"."hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "feed_source_hashes" ADD CONSTRAINT "feed_source_hashes_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_source_hashes" ADD CONSTRAINT "feed_source_hashes_connection_fk" FOREIGN KEY ("connection_id","agency_id") REFERENCES "public"."feed_connections"("id","agency_id") ON DELETE cascade ON UPDATE no action;