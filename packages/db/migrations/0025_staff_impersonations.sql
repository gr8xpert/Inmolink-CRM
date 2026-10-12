CREATE TABLE "staff_impersonations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"staff_user_id" uuid NOT NULL,
	"target_user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_impersonations_reason_ck" CHECK (char_length("staff_impersonations"."reason") between 10 and 500),
	CONSTRAINT "staff_impersonations_window_ck" CHECK ("staff_impersonations"."expires_at" > "staff_impersonations"."started_at" and "staff_impersonations"."expires_at" <= "staff_impersonations"."started_at" + interval '60 minutes'),
	CONSTRAINT "staff_impersonations_ended_ck" CHECK ("staff_impersonations"."ended_at" is null or "staff_impersonations"."ended_at" >= "staff_impersonations"."started_at"),
	CONSTRAINT "staff_impersonations_not_self_ck" CHECK ("staff_impersonations"."staff_user_id" <> "staff_impersonations"."target_user_id")
);
--> statement-breakpoint
ALTER TABLE "staff_impersonations" ADD CONSTRAINT "staff_impersonations_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_impersonations" ADD CONSTRAINT "staff_impersonations_staff_user_id_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_impersonations" ADD CONSTRAINT "staff_impersonations_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_impersonations_open_uq" ON "staff_impersonations" USING btree ("staff_user_id") WHERE ended_at is null;--> statement-breakpoint
CREATE INDEX "staff_impersonations_agency_idx" ON "staff_impersonations" USING btree ("agency_id","started_at");--> statement-breakpoint
CREATE INDEX "staff_impersonations_staff_idx" ON "staff_impersonations" USING btree ("staff_user_id","started_at");--> statement-breakpoint
CREATE INDEX "staff_impersonations_target_idx" ON "staff_impersonations" USING btree ("target_user_id");--> statement-breakpoint
CREATE INDEX "agencies_created_idx" ON "agencies" USING btree ("created_at","agency_id");