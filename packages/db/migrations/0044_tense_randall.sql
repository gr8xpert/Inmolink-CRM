DROP INDEX "feature_aliases_key_trgm_idx";--> statement-breakpoint
DROP INDEX "feature_translations_name_key_idx";--> statement-breakpoint
DROP INDEX "location_aliases_key_trgm_idx";--> statement-breakpoint
DROP INDEX "location_translations_name_key_idx";--> statement-breakpoint
DROP INDEX "property_type_aliases_key_trgm_idx";--> statement-breakpoint
DROP INDEX "property_type_translations_name_key_idx";--> statement-breakpoint
ALTER TABLE "feature_group_translations" ADD COLUMN "name_key" text GENERATED ALWAYS AS (btrim(regexp_replace(translate(replace(lower(name), 'ß', 'ss'), 'áàâäãåéèêëíìîïóòôöõúùûüÿñç', 'aaaaaaeeeeiiiiooooouuuuync'), '[^[:alnum:]]+', ' ', 'g'))) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "feature_translations" ADD COLUMN "name_key" text GENERATED ALWAYS AS (btrim(regexp_replace(translate(replace(lower(name), 'ß', 'ss'), 'áàâäãåéèêëíìîïóòôöõúùûüÿñç', 'aaaaaaeeeeiiiiooooouuuuync'), '[^[:alnum:]]+', ' ', 'g'))) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "location_translations" ADD COLUMN "name_key" text GENERATED ALWAYS AS (btrim(regexp_replace(translate(replace(lower(name), 'ß', 'ss'), 'áàâäãåéèêëíìîïóòôöõúùûüÿñç', 'aaaaaaeeeeiiiiooooouuuuync'), '[^[:alnum:]]+', ' ', 'g'))) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "property_type_group_translations" ADD COLUMN "name_key" text GENERATED ALWAYS AS (btrim(regexp_replace(translate(replace(lower(name), 'ß', 'ss'), 'áàâäãåéèêëíìîïóòôöõúùûüÿñç', 'aaaaaaeeeeiiiiooooouuuuync'), '[^[:alnum:]]+', ' ', 'g'))) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "property_type_translations" ADD COLUMN "name_key" text GENERATED ALWAYS AS (btrim(regexp_replace(translate(replace(lower(name), 'ß', 'ss'), 'áàâäãåéèêëíìîïóòôöõúùûüÿñç', 'aaaaaaeeeeiiiiooooouuuuync'), '[^[:alnum:]]+', ' ', 'g'))) STORED NOT NULL;--> statement-breakpoint
CREATE INDEX "feature_translations_name_key_eq_idx" ON "feature_translations" USING btree ("name_key");--> statement-breakpoint
CREATE INDEX "location_translations_name_key_eq_idx" ON "location_translations" USING btree ("name_key");--> statement-breakpoint
CREATE INDEX "locations_level_idx" ON "locations" USING btree ("level","id");--> statement-breakpoint
CREATE INDEX "property_type_translations_name_key_eq_idx" ON "property_type_translations" USING btree ("name_key");--> statement-breakpoint
CREATE INDEX "feature_aliases_key_trgm_idx" ON "feature_aliases" USING gin ("alias_key" gin_trgm_ops) WITH (fastupdate=false);--> statement-breakpoint
CREATE INDEX "feature_translations_name_key_idx" ON "feature_translations" USING gin ("name_key" gin_trgm_ops) WITH (fastupdate=false);--> statement-breakpoint
CREATE INDEX "location_aliases_key_trgm_idx" ON "location_aliases" USING gin ("alias_key" gin_trgm_ops) WITH (fastupdate=false);--> statement-breakpoint
CREATE INDEX "location_translations_name_key_idx" ON "location_translations" USING gin ("name_key" gin_trgm_ops) WITH (fastupdate=false);--> statement-breakpoint
CREATE INDEX "property_type_aliases_key_trgm_idx" ON "property_type_aliases" USING gin ("alias_key" gin_trgm_ops) WITH (fastupdate=false);--> statement-breakpoint
CREATE INDEX "property_type_translations_name_key_idx" ON "property_type_translations" USING gin ("name_key" gin_trgm_ops) WITH (fastupdate=false);