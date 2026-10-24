CREATE TABLE "lead_stage_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"from_stage_id" uuid,
	"from_entered_at" timestamp with time zone,
	"to_stage_id" uuid NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"actor_user_id" uuid,
	CONSTRAINT "lead_stage_history_from_ck" CHECK (("lead_stage_history"."from_stage_id" is null) = ("lead_stage_history"."from_entered_at" is null)),
	CONSTRAINT "lead_stage_history_ms_ck" CHECK ("lead_stage_history"."changed_at" = date_trunc('milliseconds', "lead_stage_history"."changed_at", 'UTC'))
);
--> statement-breakpoint
CREATE TABLE "pipeline_stages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"seed_key" text,
	"name" text,
	"status" text NOT NULL,
	"kind" text GENERATED ALWAYS AS (case when status = 'WON' then 'WON' when status in ('LOST', 'SPAM') then 'LOST' else 'OPEN' end) STORED NOT NULL,
	"position" integer NOT NULL,
	"archived_at" timestamp with time zone,
	"idempotency_hash" text,
	"request_hash" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_stages_agency_id_uq" UNIQUE("agency_id","id"),
	CONSTRAINT "pipeline_stages_status_ck" CHECK ("pipeline_stages"."status" in ('NEW', 'IN_PROGRESS', 'WON', 'LOST', 'SPAM')),
	CONSTRAINT "pipeline_stages_seed_ck" CHECK ("pipeline_stages"."seed_key" is null or ("pipeline_stages"."seed_key" in ('NEW', 'IN_PROGRESS', 'WON', 'LOST', 'SPAM') and "pipeline_stages"."seed_key" = "pipeline_stages"."status")),
	CONSTRAINT "pipeline_stages_name_ck" CHECK ("pipeline_stages"."name" is not null or "pipeline_stages"."seed_key" is not null),
	CONSTRAINT "pipeline_stages_name_len_ck" CHECK ("pipeline_stages"."name" is null or length("pipeline_stages"."name") between 1 and 60),
	CONSTRAINT "pipeline_stages_entry_ck" CHECK ("pipeline_stages"."status" <> 'NEW' or "pipeline_stages"."archived_at" is null),
	CONSTRAINT "pipeline_stages_position_ck" CHECK ("pipeline_stages"."position" >= 0),
	CONSTRAINT "pipeline_stages_idempotency_ck" CHECK (("pipeline_stages"."idempotency_hash" is null) = ("pipeline_stages"."request_hash" is null))
);
--> statement-breakpoint
ALTER TABLE "activities" DROP CONSTRAINT "activities_type_ck";--> statement-breakpoint
-- S10-03: NOT NULL after the backfill at the end of this migration.
ALTER TABLE "leads" ADD COLUMN "stage_id" uuid;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "stage_rank" text COLLATE "C";--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "stage_entered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lead_stage_history" ADD CONSTRAINT "lead_stage_history_lead_fk" FOREIGN KEY ("agency_id","lead_id") REFERENCES "public"."leads"("agency_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_stage_history" ADD CONSTRAINT "lead_stage_history_to_fk" FOREIGN KEY ("agency_id","to_stage_id") REFERENCES "public"."pipeline_stages"("agency_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_stage_history" ADD CONSTRAINT "lead_stage_history_from_fk" FOREIGN KEY ("agency_id","from_stage_id") REFERENCES "public"."pipeline_stages"("agency_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lead_stage_history_lead_idx" ON "lead_stage_history" USING btree ("agency_id","lead_id","changed_at","id");--> statement-breakpoint
CREATE INDEX "lead_stage_history_agency_changed_idx" ON "lead_stage_history" USING btree ("agency_id","changed_at","from_stage_id","to_stage_id","from_entered_at");--> statement-breakpoint
CREATE INDEX "pipeline_stages_agency_position_idx" ON "pipeline_stages" USING btree ("agency_id","position","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_stages_seed_uq" ON "pipeline_stages" USING btree ("agency_id","seed_key") WHERE "pipeline_stages"."seed_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_stages_entry_uq" ON "pipeline_stages" USING btree ("agency_id") WHERE "pipeline_stages"."status" = 'NEW';--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_stages_name_uq" ON "pipeline_stages" USING btree ("agency_id",lower("name")) WHERE "pipeline_stages"."name" is not null and "pipeline_stages"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_stages_idempotency_uq" ON "pipeline_stages" USING btree ("agency_id","idempotency_hash") WHERE "pipeline_stages"."idempotency_hash" is not null;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_stage_fk" FOREIGN KEY ("agency_id","stage_id") REFERENCES "public"."pipeline_stages"("agency_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leads_agency_stage_created_idx" ON "leads" USING btree ("agency_id","stage_id","created_ms","id");--> statement-breakpoint
CREATE INDEX "leads_agency_stage_rank_idx" ON "leads" USING btree ("agency_id","stage_id","stage_rank","id","stage_entered_at");--> statement-breakpoint
CREATE INDEX "leads_agency_stage_assigned_rank_idx" ON "leads" USING btree ("agency_id","stage_id","assigned_user_id","stage_rank","id");--> statement-breakpoint
-- S10-03: a wider list, added NOT VALID (no scan under the lock) and validated after (no write lock while it scans).
ALTER TABLE "activities" ADD CONSTRAINT "activities_type_ck" CHECK ("type" in ('CALL', 'EMAIL', 'MEETING', 'VIEWING', 'OTHER', 'NOTE_ADDED', 'CONTACT_MERGED', 'LEAD_CREATED', 'LEAD_UPDATED', 'LISTING_STATUS_CHANGED', 'STAGE_CHANGED')) NOT VALID;--> statement-breakpoint
ALTER TABLE "activities" VALIDATE CONSTRAINT "activities_type_ck";--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_stage_rank_ck" CHECK ("stage_rank" ~ '^[0-9a-z]*[1-9a-z]$' and length("stage_rank") <= 200);--> statement-breakpoint
-- S10-03 backfill (pre-launch data: one statement each, no batching — the leads table holds test data only): the five
-- default stages for every agency (the crm service's `DEFAULT_STAGES` seeds later agencies on their first write), each
-- lead into the stage of its status (entered when it was created; a time rank, newest first — `timeRank`), and its
-- first history row. `agencies` and `leads` FORCE row level security (pnpm db:rls), which hides their rows from the owner
-- running this migration: lift it for the backfill, inside the migration transaction, and restore it (as 0033, 0052).
DO $$
DECLARE agencies_forced boolean;
DECLARE leads_forced boolean;
BEGIN
  SELECT relforcerowsecurity INTO agencies_forced FROM pg_class WHERE oid = 'public.agencies'::regclass;
  SELECT relforcerowsecurity INTO leads_forced FROM pg_class WHERE oid = 'public.leads'::regclass;
  ALTER TABLE "agencies" NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE "leads" NO FORCE ROW LEVEL SECURITY;
  insert into pipeline_stages (id, agency_id, seed_key, status, position)
  select encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid()) placing
           substring(int8send((extract(epoch from clock_timestamp()) * 1000)::bigint + d.pos) from 3) from 1 for 6),
           52, 1), 53, 1), 'hex')::uuid,
         a.agency_id, d.k, d.k, d.pos
    from agencies a
   cross join (values ('NEW', 0), ('IN_PROGRESS', 1), ('WON', 2), ('LOST', 3), ('SPAM', 4)) as d(k, pos)
  on conflict do nothing;
  update leads l
     set stage_id = s.id,
         stage_entered_at = date_trunc('milliseconds', l.created_at, 'UTC'),
         stage_rank = (
           select string_agg(substr('0123456789abcdefghijklmnopqrstuvwxyz',
                    ((101559956668415 - (extract(epoch from date_trunc('milliseconds', l.created_at, 'UTC')) * 1000)::bigint)
                      / power(36::numeric, 8 - g)::bigint % 36)::int + 1, 1), '' order by g)
             from generate_series(0, 8) g
         ) || right(replace(l.id::text, '-', ''), 4) || 'i'
    from pipeline_stages s
   where s.agency_id = l.agency_id and s.seed_key = l.status;
  insert into lead_stage_history (id, agency_id, lead_id, from_stage_id, from_entered_at, to_stage_id, changed_at, actor_user_id)
  select encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid()) placing
           substring(int8send((extract(epoch from l.created_at) * 1000)::bigint) from 3) from 1 for 6), 52, 1), 53, 1), 'hex')::uuid,
         l.agency_id, l.id, null, null, l.stage_id, l.stage_entered_at, null
    from leads l;
  IF agencies_forced THEN ALTER TABLE "agencies" FORCE ROW LEVEL SECURITY; END IF;
  IF leads_forced THEN ALTER TABLE "leads" FORCE ROW LEVEL SECURITY; END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "leads" ALTER COLUMN "stage_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ALTER COLUMN "stage_rank" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ALTER COLUMN "stage_entered_at" SET NOT NULL;--> statement-breakpoint
-- S10-03 guard: a lead's status is its stage's (the crm service writes both). A stage the row names but this session
-- cannot see is left to the FK. Security invoker, EXECUTE revoked: triggers fire without it.
create function leads_stage_guard() returns trigger language plpgsql security invoker set search_path = public as $$
declare
  stage_status text;
begin
  select s.status into stage_status from pipeline_stages s where s.agency_id = new.agency_id and s.id = new.stage_id;
  if stage_status is not null and stage_status <> new.status then
    raise exception 'leads: a lead''s status is its stage''s (%, not %)', stage_status, new.status using errcode = '23514';
  end if;
  return new;
end $$;
--> statement-breakpoint
revoke all on function leads_stage_guard() from public;
--> statement-breakpoint
create trigger leads_stage_guard before insert or update of stage_id, status on leads
  for each row execute function leads_stage_guard();
--> statement-breakpoint
-- S10-03 history writer: the lead's first stage and every move, with the stay it closes and the session's member.
-- SECURITY DEFINER owned by app_owner (this migration's role), search_path pinned, executable by nobody: app_user only
-- reads `lead_stage_history` (registry `userReadOnly`); the owner appends through its `definer_append` policy.
create function lead_stage_history_append() returns trigger language plpgsql security definer
  set search_path = pg_catalog, public as $$
begin
  if tg_op = 'UPDATE' and new.stage_id is not distinct from old.stage_id then
    return null;
  end if;
  insert into public.lead_stage_history
    (id, agency_id, lead_id, from_stage_id, from_entered_at, to_stage_id, changed_at, actor_user_id)
  values (
    encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid()) placing
      substring(int8send((extract(epoch from clock_timestamp()) * 1000)::bigint) from 3) from 1 for 6), 52, 1), 53, 1), 'hex')::uuid,
    new.agency_id, new.id,
    case when tg_op = 'UPDATE' then old.stage_id end,
    case when tg_op = 'UPDATE' then old.stage_entered_at end,
    new.stage_id, new.stage_entered_at,
    public.app_user_id()
  );
  return null;
end $$;
--> statement-breakpoint
revoke all on function lead_stage_history_append() from public;
--> statement-breakpoint
create trigger leads_stage_history after insert or update of stage_id on leads
  for each row execute function lead_stage_history_append();
--> statement-breakpoint
-- S10-03 guard: stages are archived, never deleted by a request (the history names them), and keep the status they
-- stand for, their seed key, agency and idempotency hashes. Only app_user is restricted (migrations, app_system are not).
create function pipeline_stages_guard() returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if current_user <> 'app_user' then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    raise exception 'pipeline_stages: stages are archived, never deleted' using errcode = '42501';
  end if;
  if new.status is distinct from old.status or new.seed_key is distinct from old.seed_key
     or new.agency_id is distinct from old.agency_id or new.idempotency_hash is distinct from old.idempotency_hash
     or new.request_hash is distinct from old.request_hash then
    raise exception 'pipeline_stages: status, seed key, agency and idempotency hashes never change' using errcode = '42501';
  end if;
  return new;
end $$;
--> statement-breakpoint
revoke all on function pipeline_stages_guard() from public;
--> statement-breakpoint
create trigger pipeline_stages_guard before update or delete on pipeline_stages
  for each row execute function pipeline_stages_guard();
