CREATE TABLE "agency_directory" (
	"agency_id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" "agency_kind" NOT NULL,
	"listed" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "preferred_agencies" (
	"agency_id" uuid NOT NULL,
	"preferred_agency_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "preferred_agencies_agency_id_preferred_agency_id_pk" PRIMARY KEY("agency_id","preferred_agency_id"),
	CONSTRAINT "preferred_agencies_not_self_ck" CHECK ("preferred_agencies"."agency_id" <> "preferred_agencies"."preferred_agency_id")
);
--> statement-breakpoint
CREATE TABLE "preferred_agency_notes" (
	"agency_id" uuid NOT NULL,
	"preferred_agency_id" uuid NOT NULL,
	"name_when_added" text NOT NULL,
	"note" text,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "preferred_agency_notes_agency_id_preferred_agency_id_pk" PRIMARY KEY("agency_id","preferred_agency_id"),
	CONSTRAINT "preferred_agency_notes_note_ck" CHECK ("preferred_agency_notes"."note" is null or char_length("preferred_agency_notes"."note") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "agency_directory" ADD CONSTRAINT "agency_directory_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preferred_agencies" ADD CONSTRAINT "preferred_agencies_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preferred_agencies" ADD CONSTRAINT "preferred_agencies_preferred_agency_id_agencies_agency_id_fk" FOREIGN KEY ("preferred_agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preferred_agency_notes" ADD CONSTRAINT "preferred_agency_notes_relationship_fk" FOREIGN KEY ("agency_id","preferred_agency_id") REFERENCES "public"."preferred_agencies"("agency_id","preferred_agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "preferred_agencies_list_idx" ON "preferred_agencies" USING btree ("agency_id","created_at","preferred_agency_id");--> statement-breakpoint
CREATE INDEX "preferred_agencies_preferred_idx" ON "preferred_agencies" USING btree ("preferred_agency_id","agency_id");