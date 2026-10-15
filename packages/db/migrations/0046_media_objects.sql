CREATE TABLE "media_objects" (
	"sha256" char(64) PRIMARY KEY NOT NULL,
	"size_bytes" bigint NOT NULL,
	"content_type" text NOT NULL,
	"phash" bigint,
	"refcount" integer DEFAULT 0 NOT NULL,
	"delete_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_objects_sha256_ck" CHECK ("media_objects"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "media_objects_size_ck" CHECK ("media_objects"."size_bytes" > 0),
	CONSTRAINT "media_objects_refcount_ck" CHECK ("media_objects"."refcount" >= 0),
	CONSTRAINT "media_objects_content_type_ck" CHECK ("media_objects"."content_type" in ('image/jpeg', 'image/png', 'image/webp', 'image/heic'))
);
--> statement-breakpoint
ALTER TABLE "property_media" ADD COLUMN "sha256" char(64) NOT NULL;--> statement-breakpoint
CREATE INDEX "media_objects_delete_after_idx" ON "media_objects" USING btree ("delete_after") WHERE "media_objects"."delete_after" is not null;--> statement-breakpoint
CREATE INDEX "property_media_sha_idx" ON "property_media" USING btree ("sha256");--> statement-breakpoint
ALTER TABLE "property_media" ADD CONSTRAINT "property_media_property_sha_uq" UNIQUE("property_id","sha256");--> statement-breakpoint
ALTER TABLE "property_media" ADD CONSTRAINT "property_media_sha256_ck" CHECK ("property_media"."sha256" ~ '^[0-9a-f]{64}$');