CREATE TYPE "public"."api_key_kind" AS ENUM('SECRET', 'PUBLISHABLE');--> statement-breakpoint
CREATE TYPE "public"."api_key_rate_tier" AS ENUM('STANDARD', 'HIGH');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "api_key_kind" NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"allowed_origins" text[] DEFAULT '{}'::text[] NOT NULL,
	"rate_tier" "api_key_rate_tier" DEFAULT 'STANDARD' NOT NULL,
	"agency_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"last_used_at" timestamp with time zone,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_prefix_uq" ON "api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "api_keys_agency_created_idx" ON "api_keys" USING btree ("agency_id","created_at","id");