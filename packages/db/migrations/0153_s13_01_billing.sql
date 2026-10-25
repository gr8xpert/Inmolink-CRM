CREATE TYPE "public"."billing_interval" AS ENUM('MONTH', 'YEAR');--> statement-breakpoint
CREATE TYPE "public"."billing_invoice_status" AS ENUM('DRAFT', 'OPEN', 'PAID', 'VOID', 'UNCOLLECTIBLE');--> statement-breakpoint
CREATE TYPE "public"."billing_item_kind" AS ENUM('PLAN', 'ADDON');--> statement-breakpoint
CREATE TYPE "public"."billing_subscription_status" AS ENUM('INCOMPLETE', 'INCOMPLETE_EXPIRED', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'UNPAID', 'CANCELED', 'PAUSED');--> statement-breakpoint
CREATE TABLE "billing_catalog_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"kind" "billing_item_kind" NOT NULL,
	"seats_included" integer,
	"rank" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"stripe_product_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_catalog_items_code_ck" CHECK ("billing_catalog_items"."code" ~ '^[a-z][a-z0-9_]{1,39}$')
);
--> statement-breakpoint
CREATE TABLE "billing_customers" (
	"agency_id" uuid PRIMARY KEY NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"stripe_invoice_id" text NOT NULL,
	"number" text,
	"status" "billing_invoice_status" NOT NULL,
	"currency" char(3) NOT NULL,
	"total_cents" bigint NOT NULL,
	"tax_cents" bigint DEFAULT 0 NOT NULL,
	"amount_paid_cents" bigint DEFAULT 0 NOT NULL,
	"hosted_url" text,
	"pdf_url" text,
	"issued_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_prices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"item_id" uuid NOT NULL,
	"interval" "billing_interval" NOT NULL,
	"currency" char(3) NOT NULL,
	"amount_cents" bigint NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"stripe_price_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_prices_amount_ck" CHECK ("billing_prices"."amount_cents" >= 0),
	CONSTRAINT "billing_prices_currency_ck" CHECK ("billing_prices"."currency" in ('EUR', 'GBP'))
);
--> statement-breakpoint
CREATE TABLE "billing_stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_subscriptions" (
	"agency_id" uuid PRIMARY KEY NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"plan_code" text NOT NULL,
	"status" "billing_subscription_status" NOT NULL,
	"interval" "billing_interval",
	"currency" char(3),
	"addons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"payment_method" text,
	"current_period_end" timestamp with time zone,
	"cancel_at" timestamp with time zone,
	"synced_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_customers" ADD CONSTRAINT "billing_customers_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_prices" ADD CONSTRAINT "billing_prices_item_id_billing_catalog_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."billing_catalog_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_catalog_items_code_uq" ON "billing_catalog_items" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_catalog_items_stripe_uq" ON "billing_catalog_items" USING btree ("stripe_product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_customers_stripe_uq" ON "billing_customers" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_invoices_stripe_uq" ON "billing_invoices" USING btree ("stripe_invoice_id");--> statement-breakpoint
CREATE INDEX "billing_invoices_agency_issued_idx" ON "billing_invoices" USING btree ("agency_id","issued_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_prices_active_uq" ON "billing_prices" USING btree ("item_id","interval","currency") WHERE "billing_prices"."active";--> statement-breakpoint
CREATE UNIQUE INDEX "billing_prices_stripe_uq" ON "billing_prices" USING btree ("stripe_price_id");--> statement-breakpoint
CREATE INDEX "billing_prices_item_idx" ON "billing_prices" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "billing_stripe_events_processed_idx" ON "billing_stripe_events" USING btree ("processed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscriptions_stripe_uq" ON "billing_subscriptions" USING btree ("stripe_subscription_id");