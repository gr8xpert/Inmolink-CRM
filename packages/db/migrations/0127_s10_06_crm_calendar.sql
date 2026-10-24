CREATE TABLE "calendar_event_attendees" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" uuid,
	"contact_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"reminder_sent_for" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_event_attendees_one_ck" CHECK (("calendar_event_attendees"."user_id" is null) <> ("calendar_event_attendees"."contact_id" is null))
);
--> statement-breakpoint
CREATE TABLE "calendar_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"location" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'SCHEDULED' NOT NULL,
	"organizer_user_id" uuid NOT NULL,
	"created_by" uuid,
	"listing_id" uuid,
	"remind_minutes" integer,
	"remind_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"idempotency_hash" text,
	"request_hash" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_events_agency_id_uq" UNIQUE("agency_id","id"),
	CONSTRAINT "calendar_events_type_ck" CHECK ("calendar_events"."type" in ('VIEWING', 'MEETING', 'CALL')),
	CONSTRAINT "calendar_events_status_ck" CHECK ("calendar_events"."status" in ('SCHEDULED', 'CANCELLED')),
	CONSTRAINT "calendar_events_title_ck" CHECK (length("calendar_events"."title") between 1 and 200),
	CONSTRAINT "calendar_events_description_ck" CHECK ("calendar_events"."description" is null or length("calendar_events"."description") between 1 and 4000),
	CONSTRAINT "calendar_events_location_ck" CHECK ("calendar_events"."location" is null or length("calendar_events"."location") between 1 and 300),
	CONSTRAINT "calendar_events_time_ck" CHECK ("calendar_events"."starts_at" = date_trunc('milliseconds', "calendar_events"."starts_at", 'UTC') and "calendar_events"."ends_at" > "calendar_events"."starts_at" and "calendar_events"."ends_at" - "calendar_events"."starts_at" <= interval '7 days'),
	CONSTRAINT "calendar_events_remind_ck" CHECK (("calendar_events"."remind_minutes" is null) = ("calendar_events"."remind_at" is null) and ("calendar_events"."remind_minutes" is null or "calendar_events"."remind_minutes" between 0 and 10080)),
	CONSTRAINT "calendar_events_cancelled_ck" CHECK (("calendar_events"."status" = 'CANCELLED') = ("calendar_events"."cancelled_at" is not null)),
	CONSTRAINT "calendar_events_idempotency_ck" CHECK (("calendar_events"."idempotency_hash" is null) = ("calendar_events"."request_hash" is null))
);
--> statement-breakpoint
CREATE TABLE "calendar_feeds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"token_hint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "calendar_feeds_hint_ck" CHECK (length("calendar_feeds"."token_hint") between 1 and 8)
);
--> statement-breakpoint
ALTER TABLE "calendar_event_attendees" ADD CONSTRAINT "calendar_event_attendees_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event_attendees" ADD CONSTRAINT "calendar_event_attendees_event_fk" FOREIGN KEY ("agency_id","event_id") REFERENCES "public"."calendar_events"("agency_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event_attendees" ADD CONSTRAINT "calendar_event_attendees_contact_fk" FOREIGN KEY ("agency_id","contact_id") REFERENCES "public"."contacts"("agency_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_feeds" ADD CONSTRAINT "calendar_feeds_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calendar_event_attendees_user_idx" ON "calendar_event_attendees" USING btree ("agency_id","user_id","starts_at","event_id") WHERE "calendar_event_attendees"."user_id" is not null;--> statement-breakpoint
CREATE INDEX "calendar_event_attendees_event_idx" ON "calendar_event_attendees" USING btree ("agency_id","event_id");--> statement-breakpoint
CREATE INDEX "calendar_event_attendees_contact_idx" ON "calendar_event_attendees" USING btree ("agency_id","contact_id") WHERE "calendar_event_attendees"."contact_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_event_attendees_user_uq" ON "calendar_event_attendees" USING btree ("agency_id","event_id","user_id") WHERE "calendar_event_attendees"."user_id" is not null;--> statement-breakpoint
CREATE INDEX "calendar_events_agency_idx" ON "calendar_events" USING btree ("agency_id","starts_at","id");--> statement-breakpoint
CREATE INDEX "calendar_events_listing_idx" ON "calendar_events" USING btree ("agency_id","listing_id") WHERE "calendar_events"."listing_id" is not null;--> statement-breakpoint
CREATE INDEX "calendar_events_reminder_idx" ON "calendar_events" USING btree ("remind_at","id") WHERE "calendar_events"."status" = 'SCHEDULED' and "calendar_events"."remind_at" is not null and "calendar_events"."reminded_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_events_idempotency_uq" ON "calendar_events" USING btree ("agency_id","idempotency_hash") WHERE "calendar_events"."idempotency_hash" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_feeds_token_uq" ON "calendar_feeds" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_feeds_live_uq" ON "calendar_feeds" USING btree ("agency_id","user_id") WHERE "calendar_feeds"."revoked_at" is null;