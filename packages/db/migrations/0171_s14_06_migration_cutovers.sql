CREATE TABLE "migration_cutovers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"target_agency_id" uuid NOT NULL,
	"path" text NOT NULL,
	"legacy_agency_id" text,
	"provider" text,
	"renewal_date" date,
	"scheduled_for" date,
	"state" text DEFAULT 'PLANNED' NOT NULL,
	"steps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"inventory_mode" text,
	"area_location_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"old_area_listings" integer,
	"last_error" text,
	"lease_owner" uuid,
	"lease_until" timestamp with time zone,
	"started_at" timestamp with time zone,
	"cut_over_at" timestamp with time zone,
	"rolled_back_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "migration_cutovers_path_ck" CHECK ("migration_cutovers"."path" in ('A', 'B') and ("migration_cutovers"."path" = 'B' or "migration_cutovers"."legacy_agency_id" is not null)),
	CONSTRAINT "migration_cutovers_state_ck" CHECK ("migration_cutovers"."state" in ('PLANNED', 'IN_PROGRESS', 'CUT_OVER', 'ROLLED_BACK')),
	CONSTRAINT "migration_cutovers_inventory_ck" CHECK ("migration_cutovers"."inventory_mode" is null or "migration_cutovers"."inventory_mode" in ('PARALLEL', 'V2')),
	CONSTRAINT "migration_cutovers_old_area_ck" CHECK ("migration_cutovers"."old_area_listings" is null or "migration_cutovers"."old_area_listings" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "migration_cutovers_agency_uq" ON "migration_cutovers" USING btree ("target_agency_id");--> statement-breakpoint
CREATE UNIQUE INDEX "migration_cutovers_legacy_uq" ON "migration_cutovers" USING btree ("legacy_agency_id") WHERE "migration_cutovers"."legacy_agency_id" is not null;--> statement-breakpoint
CREATE INDEX "migration_cutovers_due_idx" ON "migration_cutovers" USING btree ("scheduled_for","id") WHERE "migration_cutovers"."state" in ('PLANNED', 'IN_PROGRESS', 'ROLLED_BACK');