CREATE TABLE "unit_status_histories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"unit_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"price_list_id" uuid,
	"from_status" "unit_status",
	"to_status" "unit_status" NOT NULL,
	"changed_by_user_id" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "price_lists" ADD COLUMN "entries" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "units" ADD COLUMN "commission_bp" integer;--> statement-breakpoint
ALTER TABLE "units" ADD COLUMN "commission_fixed_cents" bigint;--> statement-breakpoint
ALTER TABLE "units" ADD COLUMN "commission_includes_vat" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "unit_status_histories" ADD CONSTRAINT "unit_status_histories_unit_fk" FOREIGN KEY ("unit_id","agency_id") REFERENCES "public"."units"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_status_histories" ADD CONSTRAINT "unit_status_histories_price_list_fk" FOREIGN KEY ("price_list_id","agency_id") REFERENCES "public"."price_lists"("id","agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "unit_status_histories_unit_idx" ON "unit_status_histories" USING btree ("unit_id","changed_at","id");--> statement-breakpoint
CREATE INDEX "unit_status_histories_price_list_idx" ON "unit_status_histories" USING btree ("price_list_id") WHERE "unit_status_histories"."price_list_id" is not null;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_commission_ck" CHECK (("units"."commission_bp" is null or "units"."commission_bp" between 1 and 10000)
        and ("units"."commission_fixed_cents" is null or "units"."commission_fixed_cents" between 1 and 100000000000)
        and not ("units"."commission_bp" is not null and "units"."commission_fixed_cents" is not null));