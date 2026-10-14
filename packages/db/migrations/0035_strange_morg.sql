CREATE TABLE "feature_aliases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"alias_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_group_translations" (
	"group_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	CONSTRAINT "feature_group_translations_pk" PRIMARY KEY("group_id","locale"),
	CONSTRAINT "feature_group_translations_slug_ck" CHECK ("feature_group_translations"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "feature_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"sort" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_groups_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "feature_translations" (
	"feature_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	CONSTRAINT "feature_translations_pk" PRIMARY KEY("feature_id","locale"),
	CONSTRAINT "feature_translations_slug_ck" CHECK ("feature_translations"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "features" (
	"id" uuid PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL,
	"key" text NOT NULL,
	"icon" text NOT NULL,
	"sort" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "features_key_unique" UNIQUE("key"),
	CONSTRAINT "features_icon_ck" CHECK ("features"."icon" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "property_type_aliases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"alias_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "property_type_group_translations" (
	"group_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	CONSTRAINT "property_type_group_translations_pk" PRIMARY KEY("group_id","locale"),
	CONSTRAINT "property_type_group_translations_slug_ck" CHECK ("property_type_group_translations"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "property_type_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"sort" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "property_type_groups_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "property_type_translations" (
	"type_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	CONSTRAINT "property_type_translations_pk" PRIMARY KEY("type_id","locale"),
	CONSTRAINT "property_type_translations_slug_ck" CHECK ("property_type_translations"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "property_types" (
	"id" uuid PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL,
	"key" text NOT NULL,
	"sort" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "property_types_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "feature_aliases" ADD CONSTRAINT "feature_aliases_owner_id_features_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."features"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_group_translations" ADD CONSTRAINT "feature_group_translations_group_id_feature_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."feature_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_translations" ADD CONSTRAINT "feature_translations_feature_id_features_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."features"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "features" ADD CONSTRAINT "features_group_id_feature_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."feature_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_type_aliases" ADD CONSTRAINT "property_type_aliases_owner_id_property_types_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."property_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_type_group_translations" ADD CONSTRAINT "property_type_group_translations_group_id_property_type_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."property_type_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_type_translations" ADD CONSTRAINT "property_type_translations_type_id_property_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."property_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_types" ADD CONSTRAINT "property_types_group_id_property_type_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."property_type_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feature_aliases_key_uq" ON "feature_aliases" USING btree ("alias_key");--> statement-breakpoint
CREATE INDEX "feature_aliases_owner_idx" ON "feature_aliases" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "feature_group_translations_slug_uq" ON "feature_group_translations" USING btree ("locale","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "feature_translations_slug_uq" ON "feature_translations" USING btree ("locale","slug");--> statement-breakpoint
CREATE INDEX "features_group_idx" ON "features" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "property_type_aliases_key_uq" ON "property_type_aliases" USING btree ("alias_key");--> statement-breakpoint
CREATE INDEX "property_type_aliases_owner_idx" ON "property_type_aliases" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "property_type_group_translations_slug_uq" ON "property_type_group_translations" USING btree ("locale","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "property_type_translations_slug_uq" ON "property_type_translations" USING btree ("locale","slug");--> statement-breakpoint
CREATE INDEX "property_types_group_idx" ON "property_types" USING btree ("group_id");