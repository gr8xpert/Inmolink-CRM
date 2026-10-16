-- S3-F5: a file attached as VIDEO before videos became links is an image again; one attached as DOCUMENT is removed
-- from the listing (a document must not become a network-visible image; the media worker's prune recounts its
-- object). FORCE RLS hides the rows from the owner running this migration: lift it, in the transaction, and restore it.
DO $$
DECLARE forced boolean;
BEGIN
  SELECT relforcerowsecurity INTO forced FROM pg_class WHERE oid = 'public.property_media'::regclass;
  ALTER TABLE "property_media" NO FORCE ROW LEVEL SECURITY;
  UPDATE "property_media" SET "kind" = 'IMAGE' WHERE "kind" = 'VIDEO';
  DELETE FROM "property_media" WHERE "kind" = 'DOCUMENT';
  IF forced THEN ALTER TABLE "property_media" FORCE ROW LEVEL SECURITY; END IF;
END $$;--> statement-breakpoint
CREATE TABLE "listing_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" char(64) NOT NULL,
	"storage_key" text NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listing_documents_property_sha_uq" UNIQUE("property_id","sha256"),
	CONSTRAINT "listing_documents_sha256_ck" CHECK ("listing_documents"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "listing_documents_type_ck" CHECK ("listing_documents"."content_type" = 'application/pdf'),
	CONSTRAINT "listing_documents_size_ck" CHECK ("listing_documents"."size_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "property_media" ALTER COLUMN "sha256" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "property_media" ADD COLUMN "video_provider" text;--> statement-breakpoint
ALTER TABLE "property_media" ADD COLUMN "video_id" text;--> statement-breakpoint
ALTER TABLE "listing_documents" ADD CONSTRAINT "listing_documents_property_fk" FOREIGN KEY ("property_id","agency_id") REFERENCES "public"."properties"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listing_documents_property_idx" ON "listing_documents" USING btree ("agency_id","property_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_documents_key_uq" ON "listing_documents" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "property_media_video_uq" ON "property_media" USING btree ("property_id","video_provider","video_id") WHERE "property_media"."kind" = 'VIDEO';--> statement-breakpoint
ALTER TABLE "property_media" ADD CONSTRAINT "property_media_video_ck" CHECK (("property_media"."kind" = 'VIDEO') = ("property_media"."sha256" is null) and ("property_media"."kind" = 'VIDEO') = ("property_media"."video_provider" is not null and "property_media"."video_id" is not null));--> statement-breakpoint
ALTER TABLE "property_media" ADD CONSTRAINT "property_media_no_document_ck" CHECK ("property_media"."kind" <> 'DOCUMENT');--> statement-breakpoint
ALTER TABLE "property_media" ADD CONSTRAINT "property_media_video_provider_ck" CHECK ("property_media"."video_provider" in ('youtube', 'vimeo', 'matterport'));