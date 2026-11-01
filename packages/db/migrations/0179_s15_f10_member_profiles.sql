CREATE TABLE "member_public_profiles" (
	"agency_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"display_name" text NOT NULL,
	"languages" text[] DEFAULT '{}'::text[] NOT NULL,
	"phone" text,
	"email" text,
	"photo_storage_key" text,
	"photo_content_type" text,
	"photo_public_key" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_public_profiles_agency_id_user_id_pk" PRIMARY KEY("agency_id","user_id"),
	CONSTRAINT "member_public_profiles_name_ck" CHECK (char_length("member_public_profiles"."display_name") between 2 and 80),
	CONSTRAINT "member_public_profiles_languages_ck" CHECK (cardinality("member_public_profiles"."languages") <= 12),
	CONSTRAINT "member_public_profiles_contacts_ck" CHECK (("member_public_profiles"."phone" is null or char_length("member_public_profiles"."phone") between 3 and 40) and ("member_public_profiles"."email" is null or (char_length("member_public_profiles"."email") <= 254 and position('@' in "member_public_profiles"."email") > 1))),
	CONSTRAINT "member_public_profiles_photo_ck" CHECK (("member_public_profiles"."photo_storage_key" is null and "member_public_profiles"."photo_content_type" is null) or (starts_with("member_public_profiles"."photo_storage_key", 'member-photos/' || "member_public_profiles"."agency_id"::text || '/') and "member_public_profiles"."photo_content_type" in ('image/png', 'image/jpeg', 'image/webp'))),
	CONSTRAINT "member_public_profiles_photo_public_ck" CHECK ("member_public_profiles"."photo_public_key" is null or starts_with("member_public_profiles"."photo_public_key", 'portal/member-photos/' || "member_public_profiles"."agency_id"::text || '/'))
);
--> statement-breakpoint
ALTER TABLE "agency_profiles" ADD COLUMN "logo_public_key" text;--> statement-breakpoint
ALTER TABLE "member_public_profiles" ADD CONSTRAINT "member_public_profiles_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "member_public_profiles_id_uq" ON "member_public_profiles" USING btree ("id");--> statement-breakpoint
CREATE INDEX "member_public_profiles_agency_published_idx" ON "member_public_profiles" USING btree ("agency_id","display_name","id") WHERE "member_public_profiles"."published";--> statement-breakpoint
ALTER TABLE "agency_profiles" ADD CONSTRAINT "agency_profiles_logo_public_ck" CHECK ("agency_profiles"."logo_public_key" is null or starts_with("agency_profiles"."logo_public_key", 'portal/agency-logos/' || "agency_profiles"."agency_id"::text || '/'));