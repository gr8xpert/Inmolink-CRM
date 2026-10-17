CREATE TYPE "public"."read_model_kind" AS ENUM('LISTING', 'UNIT');--> statement-breakpoint
CREATE TABLE "listing_read_models" (
	"target_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"kind" "read_model_kind" NOT NULL,
	"agency_id" uuid NOT NULL,
	"development_id" uuid,
	"public" boolean NOT NULL,
	"status" text NOT NULL,
	"version" integer NOT NULL,
	"card" jsonb NOT NULL,
	"detail" jsonb NOT NULL,
	"etag" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listing_read_models_pk" PRIMARY KEY("target_id","locale"),
	CONSTRAINT "listing_read_models_version_ck" CHECK ("listing_read_models"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "listing_read_models" ADD CONSTRAINT "listing_read_models_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listing_read_models_agency_idx" ON "listing_read_models" USING btree ("agency_id","kind","target_id");--> statement-breakpoint
CREATE INDEX "listing_read_models_development_idx" ON "listing_read_models" USING btree ("development_id") WHERE "listing_read_models"."development_id" is not null;