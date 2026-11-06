CREATE TABLE "client_profile_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"selection_id" uuid NOT NULL,
	"sender_user_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"period_key" text NOT NULL,
	"match_count" integer NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "client_profile_deliveries_channel_ck" CHECK ("client_profile_deliveries"."channel" in ('EMAIL', 'WHATSAPP')),
	CONSTRAINT "client_profile_deliveries_status_ck" CHECK ("client_profile_deliveries"."status" in ('PENDING', 'SENT')),
	CONSTRAINT "client_profile_deliveries_count_ck" CHECK ("client_profile_deliveries"."match_count" between 1 and 100),
	CONSTRAINT "client_profile_deliveries_period_ck" CHECK ("client_profile_deliveries"."period_key" ~ '^(I|D|W):[0-9A-Za-z-]{1,40}$')
);
--> statement-breakpoint
ALTER TABLE "client_profile_deliveries" ADD CONSTRAINT "client_profile_deliveries_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_profile_deliveries" ADD CONSTRAINT "client_profile_deliveries_profile_id_client_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."client_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "client_profile_deliveries_period_uq" ON "client_profile_deliveries" USING btree ("profile_id","period_key");--> statement-breakpoint
CREATE INDEX "client_profile_deliveries_profile_created_idx" ON "client_profile_deliveries" USING btree ("profile_id","created_at");--> statement-breakpoint
CREATE INDEX "client_profile_deliveries_agency_created_idx" ON "client_profile_deliveries" USING btree ("agency_id","created_at");