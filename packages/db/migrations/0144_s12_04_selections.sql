CREATE TABLE "selection_interactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"selection_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"target_id" uuid,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "selection_interactions_kind_ck" CHECK ("selection_interactions"."kind" in ('VIEW', 'LIKE', 'UNLIKE', 'ENQUIRE')),
	CONSTRAINT "selection_interactions_target_ck" CHECK (("selection_interactions"."kind" not in ('LIKE', 'UNLIKE') or "selection_interactions"."target_id" is not null) and ("selection_interactions"."kind" <> 'VIEW' or "selection_interactions"."target_id" is null) and ("selection_interactions"."kind" = 'ENQUIRE') = ("selection_interactions"."message" is not null)),
	CONSTRAINT "selection_interactions_message_ck" CHECK ("selection_interactions"."message" is null or length("selection_interactions"."message") between 1 and 2000)
);
--> statement-breakpoint
CREATE TABLE "selection_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"selection_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"title_override" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "selection_items_position_ck" CHECK ("selection_items"."position" between 0 and 99),
	CONSTRAINT "selection_items_title_ck" CHECK ("selection_items"."title_override" is null or length("selection_items"."title_override") between 1 and 200),
	CONSTRAINT "selection_items_note_ck" CHECK ("selection_items"."note" is null or length("selection_items"."note") between 1 and 1000)
);
--> statement-breakpoint
CREATE TABLE "selections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"contact_id" uuid,
	"title" text NOT NULL,
	"message" text,
	"locale" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_hint" text NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "selections_title_ck" CHECK (length("selections"."title") between 1 and 200),
	CONSTRAINT "selections_message_ck" CHECK ("selections"."message" is null or length("selections"."message") between 1 and 2000),
	CONSTRAINT "selections_locale_ck" CHECK ("selections"."locale" ~ '^[a-z]{2}(-[A-Z]{2})?$'),
	CONSTRAINT "selections_version_ck" CHECK ("selections"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "activities" DROP CONSTRAINT "activities_type_ck";--> statement-breakpoint
ALTER TABLE "selection_interactions" ADD CONSTRAINT "selection_interactions_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "selection_interactions" ADD CONSTRAINT "selection_interactions_selection_id_selections_id_fk" FOREIGN KEY ("selection_id") REFERENCES "public"."selections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "selection_items" ADD CONSTRAINT "selection_items_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "selection_items" ADD CONSTRAINT "selection_items_selection_id_selections_id_fk" FOREIGN KEY ("selection_id") REFERENCES "public"."selections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "selections" ADD CONSTRAINT "selections_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "selection_interactions_selection_idx" ON "selection_interactions" USING btree ("selection_id","created_at");--> statement-breakpoint
CREATE INDEX "selection_interactions_agency_idx" ON "selection_interactions" USING btree ("agency_id");--> statement-breakpoint
CREATE UNIQUE INDEX "selection_items_position_uq" ON "selection_items" USING btree ("selection_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "selection_items_target_uq" ON "selection_items" USING btree ("selection_id","target_id");--> statement-breakpoint
CREATE INDEX "selection_items_agency_idx" ON "selection_items" USING btree ("agency_id");--> statement-breakpoint
CREATE UNIQUE INDEX "selections_token_uq" ON "selections" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "selections_agency_created_idx" ON "selections" USING btree ("agency_id","created_at","id");--> statement-breakpoint
CREATE INDEX "selections_contact_idx" ON "selections" USING btree ("agency_id","contact_id") WHERE "selections"."contact_id" is not null;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_type_ck" CHECK ("type" in ('CALL', 'EMAIL', 'MEETING', 'VIEWING', 'OTHER', 'NOTE_ADDED', 'CONTACT_MERGED', 'LEAD_CREATED', 'LEAD_UPDATED', 'LISTING_STATUS_CHANGED', 'STAGE_CHANGED', 'TASK_COMPLETED', 'SELECTION_VIEWED', 'SELECTION_LIKED', 'SELECTION_ENQUIRED'));