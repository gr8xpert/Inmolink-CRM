CREATE TABLE "taxonomy_unmatched" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"value_key" text NOT NULL,
	"value" text NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"examples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"candidate_id" uuid,
	"candidate_score" real,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"mapped_to_id" uuid,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "taxonomy_unmatched_value_uq" UNIQUE("kind","value_key"),
	CONSTRAINT "taxonomy_unmatched_kind_ck" CHECK ("taxonomy_unmatched"."kind" in ('location','propertyType','feature')),
	CONSTRAINT "taxonomy_unmatched_status_ck" CHECK ("taxonomy_unmatched"."status" in ('OPEN','MAPPED','IGNORED'))
);
--> statement-breakpoint
CREATE INDEX "taxonomy_unmatched_queue_idx" ON "taxonomy_unmatched" USING btree ("status","kind","count" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "feature_aliases_key_trgm_idx" ON "feature_aliases" USING gin ("alias_key" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "feature_translations_name_key_idx" ON "feature_translations" USING gin (btrim(regexp_replace(translate(lower("name"), 'áàâäãåéèêëíìîïóòôöõúùûüñçß', 'aaaaaaeeeeiiiiooooouuuunc'), '[^[:alnum:]]+', ' ', 'g')) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "location_aliases_key_trgm_idx" ON "location_aliases" USING gin ("alias_key" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "location_translations_name_key_idx" ON "location_translations" USING gin (btrim(regexp_replace(translate(lower("name"), 'áàâäãåéèêëíìîïóòôöõúùûüñçß', 'aaaaaaeeeeiiiiooooouuuunc'), '[^[:alnum:]]+', ' ', 'g')) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "property_type_aliases_key_trgm_idx" ON "property_type_aliases" USING gin ("alias_key" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "property_type_translations_name_key_idx" ON "property_type_translations" USING gin (btrim(regexp_replace(translate(lower("name"), 'áàâäãåéèêëíìîïóòôöõúùûüñçß', 'aaaaaaeeeeiiiiooooouuuunc'), '[^[:alnum:]]+', ' ', 'g')) gin_trgm_ops);