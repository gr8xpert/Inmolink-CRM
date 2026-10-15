CREATE TABLE "bookmark_folders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookmark_folders_id_member_uq" UNIQUE("id","agency_id","user_id"),
	CONSTRAINT "bookmark_folders_name_ck" CHECK (char_length("bookmark_folders"."name") between 1 and 60)
);
--> statement-breakpoint
CREATE TABLE "listing_bookmarks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"folder_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listing_bookmarks_note_ck" CHECK (char_length("listing_bookmarks"."note") <= 1000)
);
--> statement-breakpoint
ALTER TABLE "bookmark_folders" ADD CONSTRAINT "bookmark_folders_member_fk" FOREIGN KEY ("agency_id","user_id") REFERENCES "public"."agency_members"("agency_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_bookmarks" ADD CONSTRAINT "listing_bookmarks_folder_fk" FOREIGN KEY ("folder_id","agency_id","user_id") REFERENCES "public"."bookmark_folders"("id","agency_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bookmark_folders_member_name_uq" ON "bookmark_folders" USING btree ("agency_id","user_id","name");--> statement-breakpoint
CREATE INDEX "listing_bookmarks_folder_created_idx" ON "listing_bookmarks" USING btree ("agency_id","folder_id",date_trunc('milliseconds', "created_at", 'UTC'),"id");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_bookmarks_folder_property_uq" ON "listing_bookmarks" USING btree ("agency_id","folder_id","property_id");--> statement-breakpoint
CREATE INDEX "listing_bookmarks_member_property_idx" ON "listing_bookmarks" USING btree ("agency_id","user_id","property_id");