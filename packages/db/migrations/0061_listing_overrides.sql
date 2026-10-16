CREATE TYPE "public"."listing_override_target" AS ENUM('LISTING', 'DEVELOPMENT', 'UNIT');--> statement-breakpoint
CREATE TABLE "listing_overrides" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"target_kind" "listing_override_target" NOT NULL,
	"target_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"title" text,
	"description" text,
	"origin" "translation_origin" DEFAULT 'HUMAN' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listing_overrides_locale_ck" CHECK ("listing_overrides"."locale" ~ '^[a-z]{2}(-[A-Z]{2})?$'),
	CONSTRAINT "listing_overrides_text_ck" CHECK ("listing_overrides"."title" is not null or "listing_overrides"."description" is not null),
	CONSTRAINT "listing_overrides_length_ck" CHECK (char_length("listing_overrides"."title") <= 200 and char_length("listing_overrides"."description") <= 20000)
);
--> statement-breakpoint
ALTER TABLE "listing_overrides" ADD CONSTRAINT "listing_overrides_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "listing_overrides_target_locale_uq" ON "listing_overrides" USING btree ("agency_id","target_kind","target_id","locale");