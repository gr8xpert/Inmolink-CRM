CREATE TABLE "network_post_authors" (
	"agency_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"idempotency_hash" text,
	"request_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "network_post_authors_pk" PRIMARY KEY("agency_id","post_id")
);
--> statement-breakpoint
CREATE TABLE "network_posts" (
	"agency_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"transaction_type" text,
	"property_type_ids" uuid[],
	"location_ids" uuid[],
	"location_scope_ids" uuid[],
	"feature_ids" uuid[],
	"price_min_cents" bigint,
	"price_max_cents" bigint,
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"beds_min" integer,
	"baths_min" integer,
	"area_min_m2" numeric(10, 2),
	"area_max_m2" numeric(10, 2),
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "network_posts_kind_ck" CHECK ("network_posts"."kind" in ('BUYER_REQUEST', 'PROPERTY_OFFER', 'DISTRESSED', 'DEVELOPER_ANNOUNCEMENT')),
	CONSTRAINT "network_posts_status_ck" CHECK ("network_posts"."status" in ('OPEN', 'CLOSED')),
	CONSTRAINT "network_posts_closed_ck" CHECK (("network_posts"."status" = 'CLOSED') = ("network_posts"."closed_at" is not null)),
	CONSTRAINT "network_posts_title_ck" CHECK (char_length("network_posts"."title") between 1 and 120),
	CONSTRAINT "network_posts_body_ck" CHECK (char_length("network_posts"."body") between 1 and 2000),
	CONSTRAINT "network_posts_transaction_ck" CHECK ("network_posts"."transaction_type" is null or "network_posts"."transaction_type" in ('SALE', 'RENT_LONG_TERM', 'RENT_SHORT_TERM')),
	CONSTRAINT "network_posts_arrays_ck" CHECK (coalesce(cardinality("network_posts"."property_type_ids"), 0) <= 20 and coalesce(cardinality("network_posts"."location_ids"), 0) <= 20
        and coalesce(cardinality("network_posts"."location_scope_ids"), 0) <= 100 and coalesce(cardinality("network_posts"."feature_ids"), 0) <= 20),
	CONSTRAINT "network_posts_price_ck" CHECK (("network_posts"."price_min_cents" is null or "network_posts"."price_min_cents" >= 0) and ("network_posts"."price_max_cents" is null or "network_posts"."price_max_cents" >= 0)
        and ("network_posts"."price_min_cents" is null or "network_posts"."price_max_cents" is null or "network_posts"."price_min_cents" <= "network_posts"."price_max_cents")),
	CONSTRAINT "network_posts_area_ck" CHECK ("network_posts"."area_min_m2" is null or "network_posts"."area_max_m2" is null or "network_posts"."area_min_m2" <= "network_posts"."area_max_m2"),
	CONSTRAINT "network_posts_rooms_ck" CHECK (("network_posts"."beds_min" is null or "network_posts"."beds_min" between 0 and 50) and ("network_posts"."baths_min" is null or "network_posts"."baths_min" between 0 and 50)),
	CONSTRAINT "network_posts_expiry_ck" CHECK ("network_posts"."expires_at" > "network_posts"."created_at")
);
--> statement-breakpoint
CREATE TABLE "network_subscriptions" (
	"agency_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kinds" text[],
	"transaction_type" text,
	"property_type_ids" uuid[],
	"location_ids" uuid[],
	"price_min_cents" bigint,
	"price_max_cents" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "network_subscriptions_pk" PRIMARY KEY("agency_id","id"),
	CONSTRAINT "network_subscriptions_name_ck" CHECK (char_length("network_subscriptions"."name") between 1 and 80),
	CONSTRAINT "network_subscriptions_kinds_ck" CHECK ("network_subscriptions"."kinds" is null or (cardinality("network_subscriptions"."kinds") between 1 and 4
        and "network_subscriptions"."kinds" <@ array['BUYER_REQUEST', 'PROPERTY_OFFER', 'DISTRESSED', 'DEVELOPER_ANNOUNCEMENT']::text[])),
	CONSTRAINT "network_subscriptions_transaction_ck" CHECK ("network_subscriptions"."transaction_type" is null or "network_subscriptions"."transaction_type" in ('SALE', 'RENT_LONG_TERM', 'RENT_SHORT_TERM')),
	CONSTRAINT "network_subscriptions_arrays_ck" CHECK (coalesce(cardinality("network_subscriptions"."property_type_ids"), 0) <= 20 and coalesce(cardinality("network_subscriptions"."location_ids"), 0) <= 20),
	CONSTRAINT "network_subscriptions_price_ck" CHECK ("network_subscriptions"."price_min_cents" is null or "network_subscriptions"."price_max_cents" is null or "network_subscriptions"."price_min_cents" <= "network_subscriptions"."price_max_cents")
);
--> statement-breakpoint
ALTER TABLE "chat_threads" DROP CONSTRAINT "chat_threads_kind_ck";--> statement-breakpoint
ALTER TABLE "chat_threads" DROP CONSTRAINT "chat_threads_peer_ck";--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "network_post_id" uuid;--> statement-breakpoint
-- the foreign key below needs its target unique index first
CREATE UNIQUE INDEX "network_posts_agency_id_uq" ON "network_posts" USING btree ("agency_id","id");--> statement-breakpoint
ALTER TABLE "network_post_authors" ADD CONSTRAINT "network_post_authors_post_fk" FOREIGN KEY ("agency_id","post_id") REFERENCES "public"."network_posts"("agency_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_posts" ADD CONSTRAINT "network_posts_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_subscriptions" ADD CONSTRAINT "network_subscriptions_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "network_post_authors_idempotency_uq" ON "network_post_authors" USING btree ("agency_id","idempotency_hash") WHERE "network_post_authors"."idempotency_hash" is not null;--> statement-breakpoint
CREATE INDEX "network_posts_open_idx" ON "network_posts" USING btree ("created_at","id") WHERE "network_posts"."status" = 'OPEN';--> statement-breakpoint
CREATE INDEX "network_posts_open_kind_idx" ON "network_posts" USING btree ("kind","created_at","id") WHERE "network_posts"."status" = 'OPEN';--> statement-breakpoint
CREATE INDEX "network_posts_agency_idx" ON "network_posts" USING btree ("agency_id","created_at","id");--> statement-breakpoint
CREATE INDEX "network_posts_expiry_idx" ON "network_posts" USING btree ("expires_at","id") WHERE "network_posts"."status" = 'OPEN';--> statement-breakpoint
CREATE INDEX "network_subscriptions_user_idx" ON "network_subscriptions" USING btree ("agency_id","user_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_threads_network_uq" ON "chat_threads" USING btree ("agency_id","network_post_id","peer_agency_id") WHERE "chat_threads"."network_post_id" is not null;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_network_ck" CHECK (("chat_threads"."kind" = 'NETWORK') = ("chat_threads"."network_post_id" is not null));--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_kind_ck" CHECK ("chat_threads"."kind" in ('DIRECT', 'VIEWING', 'NETWORK'));--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_peer_ck" CHECK (("chat_threads"."kind" in ('VIEWING', 'NETWORK')) = ("chat_threads"."peer_agency_id" is not null)
        and ("chat_threads"."peer_agency_id" is null or "chat_threads"."peer_agency_id" <> "chat_threads"."agency_id"));--> statement-breakpoint
-- S11-05 thread copy, extended for `NETWORK` threads (a reply to a network board post). A `NETWORK` thread inserted by
-- the replying agency must name an OPEN, unexpired post of its peer agency (`network_posts`); its subject becomes the
-- post's title on both copies, the post's agency gets its copy, and the post's author (`network_post_authors`) is
-- seated on it — or, when the author is no longer an active member, the agency's admins. A `VIEWING` thread is
-- copied as before (S11-03). SECURITY DEFINER owned by app_owner, executable by nobody; it reads `network_posts`,
-- `network_post_authors`, `agency_directory`, `agency_members` and `viewing_requests` (`definer_read`) and writes
-- `chat_threads` and `chat_participants` through their `definer_*` policies. A copy (trigger depth > 1) appends nothing.
create or replace function chat_threads_mirror() returns trigger language plpgsql security definer
  set search_path = pg_catalog, public as $$
declare
  post_title text;
  author uuid;
begin
  if new.peer_agency_id is null or pg_trigger_depth() > 1 then
    return null;
  end if;
  if new.kind = 'NETWORK' then
    select p.title into post_title from public.network_posts p
     where p.id = new.network_post_id and p.agency_id = new.peer_agency_id
       and p.status = 'OPEN' and p.expires_at > now()
       -- both agencies take part in the network now (listed: VERIFIED), as the posts' read policy requires
       and exists (select 1 from public.agency_directory d where d.agency_id = p.agency_id and d.listed)
       and exists (select 1 from public.agency_directory d where d.agency_id = new.agency_id and d.listed);
    if post_title is null then
      raise exception 'chat_threads %: no open network post of the other agency', new.id using errcode = '42501';
    end if;
    update public.chat_threads t set subject = post_title
     where t.agency_id = new.agency_id and t.id = new.id;
    insert into public.chat_threads
      (agency_id, id, kind, peer_agency_id, network_post_id, title, subject, created_by_user_id, created_at,
       updated_at, last_message_at)
    -- the poster's copy starts a millisecond before the reply that opened it (sent in the same transaction, at the same
    -- `now()`), so the post's author sees the thread unread
    values (new.peer_agency_id, new.id, 'NETWORK', new.agency_id, new.network_post_id, null, post_title, null,
       new.created_at - interval '1 millisecond', new.updated_at, new.last_message_at - interval '1 millisecond');
    -- the post's author while an active member of its agency, else the agency's active admins (at most 20)
    select a.created_by_user_id into author from public.network_post_authors a
      join public.agency_members m on m.agency_id = a.agency_id and m.user_id = a.created_by_user_id
     where a.agency_id = new.peer_agency_id and a.post_id = new.network_post_id
       and m.deactivated_at is null and m.role in ('AGENCY_ADMIN', 'DEVELOPER_ADMIN', 'AGENT', 'DEVELOPER_AGENT');
    if author is not null then
      insert into public.chat_participants (agency_id, thread_id, user_id, last_message_at)
      values (new.peer_agency_id, new.id, author, new.last_message_at - interval '1 millisecond')
      on conflict do nothing;
    else
      insert into public.chat_participants (agency_id, thread_id, user_id, last_message_at)
      select new.peer_agency_id, new.id, m.user_id, new.last_message_at - interval '1 millisecond'
        from public.agency_members m
       where m.agency_id = new.peer_agency_id and m.deactivated_at is null
         and m.role in ('AGENCY_ADMIN', 'DEVELOPER_ADMIN')
       order by m.created_at, m.user_id
       limit 20
      on conflict do nothing;
    end if;
    return null;
  end if;
  if not exists (
    select 1 from public.viewing_requests v
     where v.id = new.id
       and ((v.agency_id = new.agency_id and v.owner_agency_id = new.peer_agency_id)
            or (v.agency_id = new.peer_agency_id and v.owner_agency_id = new.agency_id))) then
    raise exception 'chat_threads %: no viewing request between these agencies', new.id using errcode = '42501';
  end if;
  insert into public.chat_threads
    (agency_id, id, kind, peer_agency_id, title, subject, created_by_user_id, created_at, updated_at, last_message_at)
  values (new.peer_agency_id, new.id, new.kind, new.agency_id, null, new.subject, null, new.created_at,
     new.updated_at, new.last_message_at)
  on conflict do nothing;
  -- the other agency opened it first: its copy must be this thread's other side
  if not exists (
    select 1 from public.chat_threads t
     where t.agency_id = new.peer_agency_id and t.id = new.id and t.kind = 'VIEWING'
       and t.peer_agency_id = new.agency_id) then
    raise exception 'chat_threads %: the other agency''s copy is not this thread''s', new.id using errcode = '42501';
  end if;
  return null;
end $$;
--> statement-breakpoint
revoke all on function chat_threads_mirror() from public;
--> statement-breakpoint
-- S11-05 participants guard, extended: a member may add themselves to their agency's copy of a `VIEWING` or `NETWORK`
-- thread (the service checked they may), or — in the transaction that started a `DIRECT` or `NETWORK` thread — its
-- starter adds themselves and the colleagues it was started with. Workers and the definer triggers are not restricted.
create or replace function chat_participants_guard() returns trigger language plpgsql security invoker
  set search_path = pg_catalog, public as $$
begin
  if current_user = 'app_user' and not exists (
    select 1 from public.chat_threads t
     where t.agency_id = new.agency_id and t.id = new.thread_id
       and ((t.kind in ('VIEWING', 'NETWORK') and new.user_id = public.app_user_id())
            or (t.created_by_user_id = public.app_user_id() and t.created_at = now()))) then
    raise exception 'chat_participants: only a viewing or network thread is joined, only its starter adds members'
      using errcode = '42501';
  end if;
  return null;
end $$;
--> statement-breakpoint
revoke all on function chat_participants_guard() from public;
--> statement-breakpoint
-- S11-05 post guard: a request only closes its agency's open post (status OPEN -> CLOSED, stamped now) — it never
-- reopens one, nor changes what was published (the other columns are not updatable by app_user), nor deletes one.
-- Workers and migrations are not restricted.
create function network_posts_guard() returns trigger language plpgsql security invoker
  set search_path = pg_catalog, public as $$
begin
  if current_user = 'app_user' then
    if tg_op = 'DELETE' then
      raise exception 'network_posts: posts are closed, not deleted' using errcode = '42501';
    end if;
    if old.status is distinct from new.status or old.closed_at is distinct from new.closed_at then
      if not (old.status = 'OPEN' and new.status = 'CLOSED') then
        raise exception 'network_posts: a post is only closed' using errcode = '42501';
      end if;
      new.closed_at := now();
    end if;
    new.updated_at := now();
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;
--> statement-breakpoint
revoke all on function network_posts_guard() from public;
--> statement-breakpoint
create trigger network_posts_guard before update or delete on network_posts
  for each row execute function network_posts_guard();
