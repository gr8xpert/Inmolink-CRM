CREATE TABLE "migration_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"legacy_agency_id" text NOT NULL,
	"target_agency_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"seq" integer NOT NULL,
	"input_hash" char(64) NOT NULL,
	"status" text NOT NULL,
	"rows" integer NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "migration_batches_status_ck" CHECK ("migration_batches"."status" in ('DONE', 'FAILED')),
	CONSTRAINT "migration_batches_seq_ck" CHECK ("migration_batches"."seq" >= 0 and "migration_batches"."rows" >= 0 and "migration_batches"."attempts" >= 1)
);
--> statement-breakpoint
ALTER TABLE "legacy_id_maps" ADD COLUMN "target_agency_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "migration_batches_batch_uq" ON "migration_batches" USING btree ("legacy_agency_id","entity","seq");