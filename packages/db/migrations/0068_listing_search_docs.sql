CREATE TABLE "listing_search_docs" (
	"target_id" uuid PRIMARY KEY NOT NULL,
	"kind" "read_model_kind" NOT NULL,
	"owner_agency_id" uuid NOT NULL,
	"development_id" uuid,
	"status" text NOT NULL,
	"transaction_type" text NOT NULL,
	"property_type_id" uuid NOT NULL,
	"location_ids" uuid[] NOT NULL,
	"feature_ids" uuid[] NOT NULL,
	"price_cents" bigint,
	"price_on_request" boolean NOT NULL,
	"beds" integer,
	"baths" integer,
	"area_m2" numeric(10, 2),
	"plot_m2" numeric(12, 2),
	"lat" double precision,
	"lng" double precision,
	"ref" text NOT NULL,
	"published_at" bigint NOT NULL,
	"version" integer NOT NULL,
	"source_hash" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "listing_search_docs_owner_idx" ON "listing_search_docs" USING btree ("owner_agency_id","published_at","target_id");--> statement-breakpoint
CREATE INDEX "listing_search_docs_newest_idx" ON "listing_search_docs" USING btree ("published_at","target_id");--> statement-breakpoint
CREATE INDEX "listing_search_docs_price_idx" ON "listing_search_docs" USING btree ("price_cents","target_id");--> statement-breakpoint
CREATE INDEX "listing_search_docs_beds_idx" ON "listing_search_docs" USING btree ("beds","target_id");--> statement-breakpoint
CREATE INDEX "listing_search_docs_area_idx" ON "listing_search_docs" USING btree ("area_m2","target_id");--> statement-breakpoint
CREATE INDEX "listing_search_docs_transaction_idx" ON "listing_search_docs" USING btree ("transaction_type","status");--> statement-breakpoint
CREATE INDEX "listing_search_docs_type_idx" ON "listing_search_docs" USING btree ("property_type_id");--> statement-breakpoint
CREATE INDEX "listing_search_docs_locations_idx" ON "listing_search_docs" USING gin ("location_ids");--> statement-breakpoint
CREATE INDEX "listing_search_docs_features_idx" ON "listing_search_docs" USING gin ("feature_ids");--> statement-breakpoint
CREATE INDEX "listing_search_docs_development_idx" ON "listing_search_docs" USING btree ("development_id") WHERE "listing_search_docs"."development_id" is not null;--> statement-breakpoint
CREATE INDEX "listing_search_docs_ref_idx" ON "listing_search_docs" USING btree (lower("ref"));--> statement-breakpoint
CREATE INDEX "listing_search_docs_geo_idx" ON "listing_search_docs" USING btree ("lat","lng") WHERE "listing_search_docs"."lat" is not null;