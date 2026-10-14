CREATE TABLE "location_aliases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"location_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"alias_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "location_group_members" (
	"group_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	CONSTRAINT "location_group_members_group_id_location_id_pk" PRIMARY KEY("group_id","location_id")
);
--> statement-breakpoint
CREATE TABLE "location_group_translations" (
	"group_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	CONSTRAINT "location_group_translations_group_id_locale_pk" PRIMARY KEY("group_id","locale"),
	CONSTRAINT "location_group_translations_slug_ck" CHECK ("location_group_translations"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "location_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "location_groups_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "location_translations" (
	"location_id" uuid NOT NULL,
	"parent_id" uuid,
	"locale" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	CONSTRAINT "location_translations_location_id_locale_pk" PRIMARY KEY("location_id","locale"),
	CONSTRAINT "location_translations_slug_ck" CHECK ("location_translations"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"parent_id" uuid,
	"level" text NOT NULL,
	"depth" smallint NOT NULL,
	"code" text,
	"centroid" geometry(Point,4326),
	"polygon" geometry(MultiPolygon,4326),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "locations_id_parent_uq" UNIQUE("id","parent_id"),
	CONSTRAINT "locations_level_ck" CHECK ("locations"."level" in ('COUNTRY','REGION','CITY','AREA')),
	CONSTRAINT "locations_depth_ck" CHECK ("locations"."depth" = case "locations"."level" when 'COUNTRY' then 1 when 'REGION' then 2 when 'CITY' then 3 else 4 end),
	CONSTRAINT "locations_root_ck" CHECK (("locations"."level" = 'COUNTRY') = ("locations"."parent_id" is null))
);
--> statement-breakpoint
ALTER TABLE "location_aliases" ADD CONSTRAINT "location_aliases_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_group_members" ADD CONSTRAINT "location_group_members_group_id_location_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."location_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_group_members" ADD CONSTRAINT "location_group_members_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_group_translations" ADD CONSTRAINT "location_group_translations_group_id_location_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."location_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_translations" ADD CONSTRAINT "location_translations_location_fk" FOREIGN KEY ("location_id","parent_id") REFERENCES "public"."locations"("id","parent_id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "location_aliases_key_uq" ON "location_aliases" USING btree ("alias_key");--> statement-breakpoint
CREATE INDEX "location_aliases_location_idx" ON "location_aliases" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "location_group_members_location_idx" ON "location_group_members" USING btree ("location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "location_group_translations_slug_uq" ON "location_group_translations" USING btree ("locale","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "location_translations_slug_uq" ON "location_translations" USING btree ("parent_id","locale","slug") WHERE "location_translations"."parent_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "location_translations_root_slug_uq" ON "location_translations" USING btree ("locale","slug") WHERE "location_translations"."parent_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "locations_code_uq" ON "locations" USING btree ("code") WHERE "locations"."code" is not null;--> statement-breakpoint
CREATE INDEX "locations_parent_idx" ON "locations" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "locations_polygon_gix" ON "locations" USING gist ("polygon");--> statement-breakpoint
CREATE INDEX "locations_centroid_gix" ON "locations" USING gist ("centroid");