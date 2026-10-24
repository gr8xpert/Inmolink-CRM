CREATE TABLE "chat_messages" (
	"agency_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"sender_agency_id" uuid NOT NULL,
	"sender_user_id" uuid NOT NULL,
	"sender_name" text NOT NULL,
	"body" text NOT NULL,
	"client_key" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_messages_pk" PRIMARY KEY("agency_id","id"),
	CONSTRAINT "chat_messages_body_ck" CHECK (char_length("chat_messages"."body") between 1 and 4000),
	CONSTRAINT "chat_messages_sender_name_ck" CHECK (char_length("chat_messages"."sender_name") <= 200)
);
--> statement-breakpoint
CREATE TABLE "chat_participants" (
	"agency_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_read_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	CONSTRAINT "chat_participants_pk" PRIMARY KEY("agency_id","thread_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "chat_threads" (
	"agency_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"kind" text NOT NULL,
	"peer_agency_id" uuid,
	"title" text,
	"subject" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "chat_threads_pk" PRIMARY KEY("agency_id","id"),
	CONSTRAINT "chat_threads_kind_ck" CHECK ("chat_threads"."kind" in ('DIRECT', 'VIEWING')),
	CONSTRAINT "chat_threads_peer_ck" CHECK (("chat_threads"."kind" = 'VIEWING') = ("chat_threads"."peer_agency_id" is not null)
        and ("chat_threads"."peer_agency_id" is null or "chat_threads"."peer_agency_id" <> "chat_threads"."agency_id")),
	CONSTRAINT "chat_threads_title_ck" CHECK ("chat_threads"."title" is null or char_length("chat_threads"."title") between 1 and 120),
	CONSTRAINT "chat_threads_subject_ck" CHECK ("chat_threads"."subject" is null or char_length("chat_threads"."subject") between 1 and 120)
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_thread_fk" FOREIGN KEY ("agency_id","thread_id") REFERENCES "public"."chat_threads"("agency_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_participants" ADD CONSTRAINT "chat_participants_thread_fk" FOREIGN KEY ("agency_id","thread_id") REFERENCES "public"."chat_threads"("agency_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_messages_thread_created_idx" ON "chat_messages" USING btree ("agency_id","thread_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_client_key_uq" ON "chat_messages" USING btree ("agency_id","sender_user_id","client_key") WHERE "chat_messages"."client_key" is not null;--> statement-breakpoint
CREATE INDEX "chat_participants_inbox_idx" ON "chat_participants" USING btree ("agency_id","user_id","last_message_at","thread_id");--> statement-breakpoint
CREATE INDEX "chat_participants_thread_idx" ON "chat_participants" USING btree ("thread_id");--> statement-breakpoint
-- S11-03 thread insert guard: a member's thread names them as its starter and starts now (the database's clock); its
-- subject is the worker's to set. Workers, migrations and the definer copy are not restricted.
create function chat_threads_insert_guard() returns trigger language plpgsql security invoker
  set search_path = pg_catalog, public as $$
begin
  if current_user = 'app_user' then
    new.created_by_user_id := public.app_user_id();
    new.subject := null;
    new.closed_at := null;
    new.created_at := now();
    new.updated_at := now();
    new.last_message_at := now();
  end if;
  return new;
end $$;
--> statement-breakpoint
revoke all on function chat_threads_insert_guard() from public;
--> statement-breakpoint
create trigger chat_threads_insert_guard before insert on chat_threads
  for each row execute function chat_threads_insert_guard();
--> statement-breakpoint
-- S11-03 thread copy: a `VIEWING` thread inserted by one agency appends the other agency's copy, only when a viewing
-- request with the thread's id is between exactly those two agencies (either side may open it first; the second
-- opening finds its copy there and appends nothing). SECURITY DEFINER owned by app_owner, executable by nobody; it
-- reads `viewing_requests` and appends through `chat_threads`' `definer_append` policy. A copy (trigger depth > 1)
-- appends nothing.
create function chat_threads_mirror() returns trigger language plpgsql security definer
  set search_path = pg_catalog, public as $$
begin
  if new.peer_agency_id is null or pg_trigger_depth() > 1 then
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
create trigger chat_threads_mirror after insert on chat_threads
  for each row execute function chat_threads_mirror();
--> statement-breakpoint
-- S11-03 thread change guard: a request never deletes a thread copy, and only the starter of a `DIRECT` thread renames
-- it (no other column is updatable by app_user). Workers and the definer triggers are not restricted.
create function chat_threads_guard() returns trigger language plpgsql security invoker
  set search_path = pg_catalog, public as $$
begin
  if current_user = 'app_user' then
    if tg_op = 'DELETE' then
      raise exception 'chat_threads: threads are not deleted' using errcode = '42501';
    end if;
    if old.title is distinct from new.title
       and (old.kind <> 'DIRECT' or old.created_by_user_id is distinct from public.app_user_id()) then
      raise exception 'chat_threads: only the starter renames a direct thread' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;
--> statement-breakpoint
revoke all on function chat_threads_guard() from public;
--> statement-breakpoint
create trigger chat_threads_guard before update or delete on chat_threads
  for each row execute function chat_threads_guard();
--> statement-breakpoint
-- S11-03 participants guard: a member may add themselves to their agency's copy of a `VIEWING` thread (the service
-- checked they may see the viewing request), or — in the transaction that started a `DIRECT` thread — its starter adds
-- the colleagues it was started with. Nobody joins a colleague's thread on their own. AFTER INSERT, so the thread's
-- foreign key is checked first. Workers (default participants of a viewing thread) are not restricted.
create function chat_participants_guard() returns trigger language plpgsql security invoker
  set search_path = pg_catalog, public as $$
begin
  if current_user = 'app_user' and not exists (
    select 1 from public.chat_threads t
     where t.agency_id = new.agency_id and t.id = new.thread_id
       and ((t.kind = 'VIEWING' and new.user_id = public.app_user_id())
            or (t.created_by_user_id = public.app_user_id() and t.created_at = now()))) then
    raise exception 'chat_participants: only a viewing thread is joined, only its starter adds members'
      using errcode = '42501';
  end if;
  return null;
end $$;
--> statement-breakpoint
revoke all on function chat_participants_guard() from public;
--> statement-breakpoint
create trigger chat_participants_guard after insert on chat_participants
  for each row execute function chat_participants_guard();
--> statement-breakpoint
-- S11-03 participant change guard: a member changes only their own read state (`last_read_at`, the only column app_user
-- may update) and nobody leaves or removes anyone through a request. Workers and the definer triggers are not
-- restricted.
create function chat_participants_change_guard() returns trigger language plpgsql security invoker
  set search_path = pg_catalog, public as $$
begin
  if current_user = 'app_user' then
    if tg_op = 'DELETE' then
      raise exception 'chat_participants: participants are not removed' using errcode = '42501';
    end if;
    if to_jsonb(old) is distinct from to_jsonb(new) and old.user_id is distinct from public.app_user_id() then
      raise exception 'chat_participants: a member changes only their own read state' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;
--> statement-breakpoint
revoke all on function chat_participants_change_guard() from public;
--> statement-breakpoint
create trigger chat_participants_change_guard before update or delete on chat_participants
  for each row execute function chat_participants_change_guard();
--> statement-breakpoint
-- S11-03 messages guard: a member's message is stamped with the database's clock; a message is never deleted by a
-- request (both agencies' copies are the record of the conversation; app_user cannot change one either: no column of
-- it is updatable).
create function chat_messages_guard() returns trigger language plpgsql security invoker
  set search_path = pg_catalog, public as $$
begin
  if current_user = 'app_user' then
    if tg_op = 'DELETE' then
      raise exception 'chat_messages: messages are not deleted' using errcode = '42501';
    end if;
    new.created_at := now();
    return new;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;
--> statement-breakpoint
revoke all on function chat_messages_guard() from public;
--> statement-breakpoint
create trigger chat_messages_guard before insert or delete on chat_messages
  for each row execute function chat_messages_guard();
--> statement-breakpoint
-- S11-03 message fan-out. A member's message (trigger depth 1) must come from a participant of the thread, as its own
-- agency, into a thread that is not closed. Every copy moves its thread's and its participants' `last_message_at` (the sender's own message counts as
-- read). A member's message in a `VIEWING` thread appends the other agency's copy (no idempotency key). SECURITY
-- DEFINER owned by app_owner, executable by nobody: it reads and updates both agencies' threads and participants and
-- appends the copy through their `definer_*` policies. AFTER INSERT: the thread's foreign key is checked first.
create function chat_messages_fanout() returns trigger language plpgsql security definer
  set search_path = pg_catalog, public as $$
declare
  peer uuid;
  closed timestamptz;
begin
  if pg_trigger_depth() = 1 then
    select t.closed_at into closed from public.chat_threads t
     where t.agency_id = new.agency_id and t.id = new.thread_id;
    if closed is not null then
      raise exception 'chat_messages: thread % is closed', new.thread_id using errcode = '42501';
    end if;
    if new.sender_agency_id <> new.agency_id or not exists (
      select 1 from public.chat_participants p
       where p.agency_id = new.agency_id and p.thread_id = new.thread_id and p.user_id = new.sender_user_id) then
      raise exception 'chat_messages: the sender is not a participant of thread %', new.thread_id
        using errcode = '42501';
    end if;
  end if;
  update public.chat_threads t
     set last_message_at = greatest(t.last_message_at, new.created_at), updated_at = now()
   where t.agency_id = new.agency_id and t.id = new.thread_id
  returning t.peer_agency_id into peer;
  update public.chat_participants p
     set last_message_at = greatest(p.last_message_at, new.created_at),
         last_read_at = case when p.user_id = new.sender_user_id and new.agency_id = new.sender_agency_id
                             then greatest(coalesce(p.last_read_at, new.created_at), new.created_at)
                             else p.last_read_at end
   where p.agency_id = new.agency_id and p.thread_id = new.thread_id;
  if new.agency_id = new.sender_agency_id and peer is not null then
    insert into public.chat_messages
      (agency_id, id, thread_id, sender_agency_id, sender_user_id, sender_name, body, client_key, created_at)
    values (peer, new.id, new.thread_id, new.sender_agency_id, new.sender_user_id, new.sender_name, new.body, null,
       new.created_at)
    on conflict do nothing;
  end if;
  return null;
end $$;
--> statement-breakpoint
revoke all on function chat_messages_fanout() from public;
--> statement-breakpoint
create trigger chat_messages_fanout after insert on chat_messages
  for each row execute function chat_messages_fanout();
