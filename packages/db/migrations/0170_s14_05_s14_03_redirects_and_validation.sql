CREATE TABLE "legacy_url_redirects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"locale" text DEFAULT '' NOT NULL,
	"path_key" text NOT NULL,
	"target_path" text NOT NULL,
	"entity" text NOT NULL,
	"target_id" uuid,
	"status" integer DEFAULT 301 NOT NULL,
	"hits" bigint DEFAULT 0 NOT NULL,
	"last_hit_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legacy_url_redirects_source_ck" CHECK ("legacy_url_redirects"."source" in ('portal', 'plugin')),
	CONSTRAINT "legacy_url_redirects_status_ck" CHECK ("legacy_url_redirects"."status" in (301, 308)),
	CONSTRAINT "legacy_url_redirects_target_ck" CHECK ("legacy_url_redirects"."target_path" like '/%' and "legacy_url_redirects"."target_path" not like '//%')
);
--> statement-breakpoint
CREATE TABLE "migration_validation_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"legacy_agency_id" text NOT NULL,
	"target_agency_id" uuid NOT NULL,
	"status" text NOT NULL,
	"latest" boolean DEFAULT true NOT NULL,
	"legacy_rows" integer NOT NULL,
	"unexplained" integer NOT NULL,
	"sample_diffs" integer NOT NULL,
	"url_failures" integer NOT NULL,
	"report" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "migration_validation_reports_status_ck" CHECK ("migration_validation_reports"."status" in ('PASS', 'FAIL')),
	CONSTRAINT "migration_validation_reports_counts_ck" CHECK ("migration_validation_reports"."legacy_rows" >= 0 and "migration_validation_reports"."unexplained" >= 0 and "migration_validation_reports"."sample_diffs" >= 0 and "migration_validation_reports"."url_failures" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_url_redirects_key_uq" ON "legacy_url_redirects" USING btree ("source","locale","path_key");--> statement-breakpoint
CREATE INDEX "legacy_url_redirects_target_idx" ON "legacy_url_redirects" USING btree ("entity","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "migration_validation_reports_latest_uq" ON "migration_validation_reports" USING btree ("legacy_agency_id") WHERE "migration_validation_reports"."latest";--> statement-breakpoint
CREATE INDEX "migration_validation_reports_list_idx" ON "migration_validation_reports" USING btree ("status","created_at","id") WHERE "migration_validation_reports"."latest";--> statement-breakpoint
CREATE INDEX "migration_validation_reports_created_idx" ON "migration_validation_reports" USING btree ("created_at","id") WHERE "migration_validation_reports"."latest";