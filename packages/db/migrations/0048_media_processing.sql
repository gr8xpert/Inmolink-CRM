ALTER TABLE "media_objects" ADD COLUMN "pipeline" smallint;--> statement-breakpoint
ALTER TABLE "media_objects" ADD COLUMN "variants_ready" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "media_objects" ADD COLUMN "width" integer;--> statement-breakpoint
ALTER TABLE "media_objects" ADD COLUMN "height" integer;--> statement-breakpoint
ALTER TABLE "media_objects" ADD CONSTRAINT "media_objects_processed_ck" CHECK (("media_objects"."pipeline" is null and "media_objects"."variants_ready" = 0) or ("media_objects"."pipeline" > 0 and "media_objects"."variants_ready" >= 0 and "media_objects"."width" > 0 and "media_objects"."height" > 0));