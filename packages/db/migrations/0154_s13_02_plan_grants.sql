CREATE TYPE "public"."billing_plan_grant_kind" AS ENUM('TRIAL', 'STAFF');--> statement-breakpoint
CREATE TABLE "billing_plan_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"kind" "billing_plan_grant_kind" NOT NULL,
	"plan_code" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"granted_by" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_plan_grants_period_ck" CHECK ("billing_plan_grants"."ends_at" > "billing_plan_grants"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "billing_price_locks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"plan_code" text NOT NULL,
	"interval" "billing_interval" NOT NULL,
	"currency" char(3) NOT NULL,
	"amount_cents" bigint NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_price_locks_amount_ck" CHECK ("billing_price_locks"."amount_cents" >= 0),
	CONSTRAINT "billing_price_locks_currency_ck" CHECK ("billing_price_locks"."currency" in ('EUR', 'GBP'))
);
--> statement-breakpoint
ALTER TABLE "billing_catalog_items" ADD COLUMN "features" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN "past_due_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_plan_grants" ADD CONSTRAINT "billing_plan_grants_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_price_locks" ADD CONSTRAINT "billing_price_locks_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_plan_grants_agency_idx" ON "billing_plan_grants" USING btree ("agency_id","ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_plan_grants_trial_uq" ON "billing_plan_grants" USING btree ("agency_id") WHERE "billing_plan_grants"."kind" = 'TRIAL';--> statement-breakpoint
CREATE INDEX "billing_plan_grants_due_idx" ON "billing_plan_grants" USING btree ("ends_at") WHERE "billing_plan_grants"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_price_locks_uq" ON "billing_price_locks" USING btree ("agency_id","plan_code","interval","currency");