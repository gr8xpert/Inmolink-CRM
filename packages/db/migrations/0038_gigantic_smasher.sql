CREATE TABLE "legacy_id_maps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entity" text NOT NULL,
	"legacy_id" text NOT NULL,
	"new_id" uuid NOT NULL,
	"method" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_id_maps_legacy_uq" ON "legacy_id_maps" USING btree ("entity","legacy_id");--> statement-breakpoint
CREATE INDEX "legacy_id_maps_new_idx" ON "legacy_id_maps" USING btree ("entity","new_id");