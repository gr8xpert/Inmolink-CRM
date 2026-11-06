CREATE TABLE "client_profile_affinities" (
	"profile_id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"keys" integer[] NOT NULL,
	"likes" integer[] NOT NULL,
	"dislikes" integer[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_profile_affinities_arrays_ck" CHECK (cardinality("client_profile_affinities"."keys") = cardinality("client_profile_affinities"."likes") and cardinality("client_profile_affinities"."keys") = cardinality("client_profile_affinities"."dislikes"))
);
--> statement-breakpoint
CREATE TABLE "client_profile_feedback" (
	"profile_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"signal" text NOT NULL,
	"signal_at" timestamp with time zone NOT NULL,
	"keys" integer[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_profile_feedback_profile_id_listing_id_pk" PRIMARY KEY("profile_id","listing_id"),
	CONSTRAINT "client_profile_feedback_signal_ck" CHECK ("client_profile_feedback"."signal" in ('LIKE', 'DISLIKE'))
);
--> statement-breakpoint
ALTER TABLE "client_profile_affinities" ADD CONSTRAINT "client_profile_affinities_profile_id_client_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."client_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_profile_affinities" ADD CONSTRAINT "client_profile_affinities_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_profile_feedback" ADD CONSTRAINT "client_profile_feedback_profile_id_client_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."client_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_profile_feedback" ADD CONSTRAINT "client_profile_feedback_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_profile_affinities_agency_idx" ON "client_profile_affinities" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX "client_profile_feedback_agency_idx" ON "client_profile_feedback" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX "selection_interactions_likes_idx" ON "selection_interactions" USING btree ("agency_id","target_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "selection_interactions"."kind" in ('LIKE', 'UNLIKE');