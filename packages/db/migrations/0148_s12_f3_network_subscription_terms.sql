CREATE TABLE "network_subscription_terms" (
	"agency_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"transaction_type" text NOT NULL,
	"property_type_ids" uuid[],
	"price_min_cents" bigint,
	"price_max_cents" bigint,
	CONSTRAINT "network_subscription_terms_pk" PRIMARY KEY("agency_id","subscription_id","location_id","kind"),
	CONSTRAINT "network_subscription_terms_kind_ck" CHECK ("network_subscription_terms"."kind" in ('*', 'BUYER_REQUEST', 'PROPERTY_OFFER', 'DISTRESSED', 'DEVELOPER_ANNOUNCEMENT')),
	CONSTRAINT "network_subscription_terms_transaction_ck" CHECK ("network_subscription_terms"."transaction_type" in ('*', 'SALE', 'RENT_LONG_TERM', 'RENT_SHORT_TERM'))
);
--> statement-breakpoint
ALTER TABLE "network_subscription_terms" ADD CONSTRAINT "network_subscription_terms_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_subscription_terms" ADD CONSTRAINT "network_subscription_terms_subscription_fk" FOREIGN KEY ("agency_id","subscription_id") REFERENCES "public"."network_subscriptions"("agency_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "network_subscription_terms_walk_idx" ON "network_subscription_terms" USING btree ("location_id","kind","transaction_type","agency_id","user_id","price_min_cents","price_max_cents","property_type_ids");--> statement-breakpoint
-- S12-F3 subscription terms: `network_subscription_terms` follows its subscription. AFTER INSERT OR UPDATE on
-- `network_subscriptions` (a change of anything the walk reads replaces the rows; the rest leaves them); a DELETE
-- cascades. SECURITY INVOKER: the member writes their own rows under the table's policies (user_id = app_user_id()).
create function network_subscriptions_terms_sync() returns trigger language plpgsql security invoker
  set search_path = pg_catalog, public as $$
begin
  if tg_op = 'UPDATE' then
    if (new.user_id, new.kinds, new.transaction_type, new.property_type_ids, new.location_ids, new.price_min_cents,
        new.price_max_cents) is not distinct from (old.user_id, old.kinds, old.transaction_type, old.property_type_ids,
        old.location_ids, old.price_min_cents, old.price_max_cents) then
      return null;
    end if;
    delete from public.network_subscription_terms t where t.agency_id = old.agency_id and t.subscription_id = old.id;
  end if;
  insert into public.network_subscription_terms
    (agency_id, subscription_id, user_id, location_id, kind, transaction_type, property_type_ids, price_min_cents,
     price_max_cents)
  select new.agency_id, new.id, new.user_id, l, k, coalesce(new.transaction_type, '*'), new.property_type_ids,
         new.price_min_cents, new.price_max_cents
    from unnest(coalesce(new.location_ids, array['00000000-0000-0000-0000-000000000000'::uuid])) l
   cross join unnest(coalesce(new.kinds, array['*'])) k
  on conflict do nothing;
  return null;
end $$;
--> statement-breakpoint
revoke all on function network_subscriptions_terms_sync() from public;
--> statement-breakpoint
create trigger network_subscriptions_terms_sync after insert or update on network_subscriptions
  for each row execute function network_subscriptions_terms_sync();
--> statement-breakpoint
-- S12-F3 backfill (pre-launch data, one statement): the terms of the subscriptions as they are now. The owner reads
-- every agency's subscriptions with forced RLS lifted for this statement only (0052's pattern).
DO $$
DECLARE subscriptions_forced boolean;
BEGIN
  SELECT relforcerowsecurity INTO subscriptions_forced FROM pg_class WHERE oid = 'public.network_subscriptions'::regclass;
  ALTER TABLE "network_subscriptions" NO FORCE ROW LEVEL SECURITY;
  INSERT INTO "network_subscription_terms"
    ("agency_id", "subscription_id", "user_id", "location_id", "kind", "transaction_type", "property_type_ids",
     "price_min_cents", "price_max_cents")
  SELECT s."agency_id", s."id", s."user_id", l, k, coalesce(s."transaction_type", '*'), s."property_type_ids",
         s."price_min_cents", s."price_max_cents"
    FROM "network_subscriptions" s
   CROSS JOIN LATERAL unnest(coalesce(s."location_ids", array['00000000-0000-0000-0000-000000000000'::uuid])) l
   CROSS JOIN LATERAL unnest(coalesce(s."kinds", array['*'])) k
  ON CONFLICT DO NOTHING;
  IF subscriptions_forced THEN ALTER TABLE "network_subscriptions" FORCE ROW LEVEL SECURITY; END IF;
END $$;
