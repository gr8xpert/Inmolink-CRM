CREATE TABLE "dedupe_canonical_pins" (
	"listing_id" uuid PRIMARY KEY NOT NULL,
	"dispute_id" uuid NOT NULL,
	"pinned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dedupe_cluster_members" (
	"listing_id" uuid PRIMARY KEY NOT NULL,
	"cluster_id" uuid NOT NULL,
	"owner_agency_id" uuid NOT NULL,
	"rank" smallint NOT NULL,
	"via" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dedupe_cluster_members_via_ck" CHECK ("dedupe_cluster_members"."via" in ('AUTO', 'CONFIRMED')),
	CONSTRAINT "dedupe_cluster_members_rank_ck" CHECK ("dedupe_cluster_members"."rank" >= 0)
);
--> statement-breakpoint
CREATE TABLE "dedupe_clusters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"canonical_listing_id" uuid NOT NULL,
	"size" smallint NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dedupe_clusters_size_ck" CHECK ("dedupe_clusters"."size" between 2 and 64)
);
--> statement-breakpoint
CREATE TABLE "dedupe_disputes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"cluster_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"opened_by_user_id" uuid NOT NULL,
	"resolved_by_user_id" uuid,
	"resolution_note" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dedupe_disputes_kind_ck" CHECK ("dedupe_disputes"."kind" in ('NOT_DUPLICATE', 'CANONICAL')),
	CONSTRAINT "dedupe_disputes_status_ck" CHECK ("dedupe_disputes"."status" in ('OPEN', 'UPHELD', 'REJECTED')),
	CONSTRAINT "dedupe_disputes_reason_ck" CHECK (char_length("dedupe_disputes"."reason") between 1 and 1000),
	CONSTRAINT "dedupe_disputes_resolved_ck" CHECK (("dedupe_disputes"."status" = 'OPEN') = ("dedupe_disputes"."resolved_at" is null and "dedupe_disputes"."resolved_by_user_id" is null)),
	CONSTRAINT "dedupe_disputes_note_ck" CHECK ("dedupe_disputes"."resolution_note" is null or char_length("dedupe_disputes"."resolution_note") between 1 and 1000)
);
--> statement-breakpoint
CREATE TABLE "dedupe_listing_clusters" (
	"agency_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"cluster_id" uuid NOT NULL,
	"rank" smallint NOT NULL,
	"via" text NOT NULL,
	"member_ids" uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dedupe_listing_clusters_pk" PRIMARY KEY("agency_id","listing_id"),
	CONSTRAINT "dedupe_listing_clusters_via_ck" CHECK ("dedupe_listing_clusters"."via" in ('AUTO', 'CONFIRMED')),
	CONSTRAINT "dedupe_listing_clusters_members_ck" CHECK (cardinality("dedupe_listing_clusters"."member_ids") between 2 and 64)
);
--> statement-breakpoint
CREATE TABLE "dedupe_pair_decisions" (
	"listing_a" uuid NOT NULL,
	"listing_b" uuid NOT NULL,
	"decision" text NOT NULL,
	"source" text NOT NULL,
	"decided_by_agency_id" uuid,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dedupe_pair_decisions_pk" PRIMARY KEY("listing_a","listing_b"),
	CONSTRAINT "dedupe_pair_decisions_order_ck" CHECK ("dedupe_pair_decisions"."listing_a" < "dedupe_pair_decisions"."listing_b"),
	CONSTRAINT "dedupe_pair_decisions_decision_ck" CHECK ("dedupe_pair_decisions"."decision" in ('CONFIRMED', 'NOT_DUPLICATE')),
	CONSTRAINT "dedupe_pair_decisions_source_ck" CHECK ("dedupe_pair_decisions"."source" in ('REVIEW', 'DISPUTE'))
);
--> statement-breakpoint
CREATE TABLE "dedupe_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"other_listing_id" uuid NOT NULL,
	"score" real NOT NULL,
	"signals" jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dedupe_reviews_status_ck" CHECK ("dedupe_reviews"."status" in ('PENDING', 'CONFIRMED', 'NOT_DUPLICATE')),
	CONSTRAINT "dedupe_reviews_decided_ck" CHECK (("dedupe_reviews"."status" = 'PENDING') = ("dedupe_reviews"."decided_by_user_id" is null and "dedupe_reviews"."decided_at" is null)),
	CONSTRAINT "dedupe_reviews_score_ck" CHECK ("dedupe_reviews"."score" >= 0 and "dedupe_reviews"."score" <= 1),
	CONSTRAINT "dedupe_reviews_self_ck" CHECK ("dedupe_reviews"."listing_id" <> "dedupe_reviews"."other_listing_id")
);
--> statement-breakpoint
ALTER TABLE "dedupe_cluster_members" ADD CONSTRAINT "dedupe_cluster_members_cluster_id_dedupe_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."dedupe_clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dedupe_disputes" ADD CONSTRAINT "dedupe_disputes_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dedupe_listing_clusters" ADD CONSTRAINT "dedupe_listing_clusters_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dedupe_reviews" ADD CONSTRAINT "dedupe_reviews_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dedupe_cluster_members_cluster_idx" ON "dedupe_cluster_members" USING btree ("cluster_id","rank");--> statement-breakpoint
CREATE UNIQUE INDEX "dedupe_disputes_open_uq" ON "dedupe_disputes" USING btree ("listing_id") WHERE "dedupe_disputes"."status" = 'OPEN';--> statement-breakpoint
CREATE INDEX "dedupe_disputes_agency_idx" ON "dedupe_disputes" USING btree ("agency_id","created_at","id");--> statement-breakpoint
CREATE INDEX "dedupe_disputes_status_idx" ON "dedupe_disputes" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "dedupe_listing_clusters_listing_uq" ON "dedupe_listing_clusters" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "dedupe_listing_clusters_page_idx" ON "dedupe_listing_clusters" USING btree ("agency_id","created_at","listing_id");--> statement-breakpoint
CREATE INDEX "dedupe_pair_decisions_b_idx" ON "dedupe_pair_decisions" USING btree ("listing_b");--> statement-breakpoint
CREATE UNIQUE INDEX "dedupe_reviews_pair_uq" ON "dedupe_reviews" USING btree ("agency_id","listing_id","other_listing_id");--> statement-breakpoint
CREATE INDEX "dedupe_reviews_queue_idx" ON "dedupe_reviews" USING btree ("agency_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "dedupe_reviews_listing_idx" ON "dedupe_reviews" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "dedupe_reviews_other_idx" ON "dedupe_reviews" USING btree ("other_listing_id");