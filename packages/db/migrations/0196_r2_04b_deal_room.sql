CREATE TABLE "deal_documents" (
	"agency_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"deal_id" uuid NOT NULL,
	"uploader_agency_id" uuid NOT NULL,
	"uploaded_by_user_id" uuid NOT NULL,
	"uploader_name" text NOT NULL,
	"kind" text NOT NULL,
	"file_name" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by_user_id" uuid,
	CONSTRAINT "deal_documents_pk" PRIMARY KEY("agency_id","id"),
	CONSTRAINT "deal_documents_kind_ck" CHECK ("deal_documents"."kind" in ('OFFER', 'RESERVATION', 'ARRAS', 'DEED', 'INVOICE', 'OTHER')),
	CONSTRAINT "deal_documents_file_name_ck" CHECK (char_length("deal_documents"."file_name") between 1 and 200),
	CONSTRAINT "deal_documents_uploader_name_ck" CHECK (char_length("deal_documents"."uploader_name") <= 200),
	CONSTRAINT "deal_documents_size_ck" CHECK ("deal_documents"."size_bytes" between 1 and 20971520),
	CONSTRAINT "deal_documents_sha256_ck" CHECK ("deal_documents"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "deal_documents_removed_ck" CHECK (("deal_documents"."removed_at" is null) = ("deal_documents"."removed_by_user_id" is null))
);
--> statement-breakpoint
ALTER TABLE "chat_threads" DROP CONSTRAINT "chat_threads_kind_ck";--> statement-breakpoint
ALTER TABLE "chat_threads" DROP CONSTRAINT "chat_threads_peer_ck";--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "deal_id" uuid;--> statement-breakpoint
ALTER TABLE "deal_documents" ADD CONSTRAINT "deal_documents_deal_fk" FOREIGN KEY ("agency_id","deal_id") REFERENCES "public"."deals"("agency_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deal_documents_deal_idx" ON "deal_documents" USING btree ("agency_id","deal_id","created_at","id");--> statement-breakpoint
CREATE INDEX "deal_documents_storage_key_idx" ON "deal_documents" USING btree ("storage_key") WHERE "deal_documents"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "tasks_deal_idx" ON "tasks" USING btree ("agency_id","deal_id","status","due_sort_ms","id") WHERE "tasks"."deal_id" is not null and "tasks"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_kind_ck" CHECK ("chat_threads"."kind" in ('DIRECT', 'VIEWING', 'NETWORK', 'DEAL'));--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_peer_ck" CHECK (("chat_threads"."kind" in ('VIEWING', 'NETWORK', 'DEAL')) = ("chat_threads"."peer_agency_id" is not null)
        and ("chat_threads"."peer_agency_id" is null or "chat_threads"."peer_agency_id" <> "chat_threads"."agency_id"));--> statement-breakpoint
-- R2-04b deal threads: a `DEAL` thread inserted by one party appends the other party's copy, only when the inserting
-- agency's copy of a deal with the thread's id names exactly that other agency as its peer (the deal is the thread's;
-- the peer's own copy exists by `deals_mirror`). Either side may open it first; the second opening finds its copy
-- there and appends nothing. Otherwise unchanged from S12-F16 (0151): NETWORK and VIEWING threads as before.
create or replace function public.chat_threads_mirror() returns trigger language plpgsql security definer
  set search_path = pg_catalog, pg_temp as $$
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
  if new.kind = 'DEAL' then
    if not exists (
      select 1 from public.deals d
       where d.agency_id = new.agency_id and d.id = new.id and d.peer_agency_id = new.peer_agency_id) then
      raise exception 'chat_threads %: no deal between these agencies', new.id using errcode = '42501';
    end if;
  elsif new.kind = 'VIEWING' then
    if not exists (
      select 1 from public.viewing_requests v
       where v.id = new.id
         and ((v.agency_id = new.agency_id and v.owner_agency_id = new.peer_agency_id)
              or (v.agency_id = new.peer_agency_id and v.owner_agency_id = new.agency_id))) then
      raise exception 'chat_threads %: no viewing request between these agencies', new.id using errcode = '42501';
    end if;
  else
    raise exception 'chat_threads %: no such thread between agencies', new.id using errcode = '42501';
  end if;
  insert into public.chat_threads
    (agency_id, id, kind, peer_agency_id, title, subject, created_by_user_id, created_at, updated_at, last_message_at)
  values (new.peer_agency_id, new.id, new.kind, new.agency_id, null, new.subject, null, new.created_at,
     new.updated_at, new.last_message_at)
  on conflict do nothing;
  -- the other agency opened it first: its copy must be this thread's other side
  if not exists (
    select 1 from public.chat_threads t
     where t.agency_id = new.peer_agency_id and t.id = new.id and t.kind = new.kind
       and t.peer_agency_id = new.agency_id) then
    raise exception 'chat_threads %: the other agency''s copy is not this thread''s', new.id using errcode = '42501';
  end if;
  return null;
end $$;
--> statement-breakpoint
-- R2-04b participants guard: as S11-05 (0136), and a member may also add themselves to their agency's copy of a `DEAL`
-- thread (the service checked they may read the agency's deals). Workers and the definer triggers are not restricted.
create or replace function chat_participants_guard() returns trigger language plpgsql security invoker
  set search_path = pg_catalog, public as $$
begin
  if current_user = 'app_user' and not exists (
    select 1 from public.chat_threads t
     where t.agency_id = new.agency_id and t.id = new.thread_id
       and ((t.kind in ('VIEWING', 'NETWORK', 'DEAL') and new.user_id = public.app_user_id())
            or (t.created_by_user_id = public.app_user_id() and t.created_at = now()))) then
    raise exception 'chat_participants: only a viewing, network or deal thread is joined, only its starter adds members'
      using errcode = '42501';
  end if;
  return null;
end $$;
--> statement-breakpoint
-- R2-04b document guard. For every role but app_owner (migrations, the definer mirror) and app_system (workers):
-- app_user appends only its own agency's upload (its own copy, as itself, nothing removed) to its own copy of an open
-- deal, under the key the deal and id name — so a row never points at another deal's or agency's object; it changes a
-- document only by removing its own agency's upload of an open deal, as itself (stamped by the database); nothing else
-- of a document changes; a request never deletes one (a removed document stays as the deal's evidence).
create function deal_documents_guard() returns trigger language plpgsql security invoker
  set search_path = pg_catalog, public as $$
declare
  o jsonb;
  n jsonb;
begin
  if current_user <> 'app_user' then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    raise exception 'deal_documents: documents are not deleted' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.uploader_agency_id <> new.agency_id or new.uploaded_by_user_id is distinct from public.app_user_id()
       or new.removed_at is not null or new.removed_by_user_id is not null
       or new.storage_key <> 'deal-documents/' || new.deal_id::text || '/' || new.id::text then
      raise exception 'deal_documents: a member uploads as themself, under the deal''s key' using errcode = '42501';
    end if;
    if not exists (
      select 1 from public.deals d
       where d.agency_id = new.agency_id and d.id = new.deal_id and d.stage not in ('COMPLETION', 'FELL_THROUGH')) then
      raise exception 'deal_documents: no open deal of the agency' using errcode = '42501';
    end if;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;
  o := to_jsonb(old) - array['removed_at', 'removed_by_user_id', 'updated_at'];
  n := to_jsonb(new) - array['removed_at', 'removed_by_user_id', 'updated_at'];
  if o is distinct from n then
    raise exception 'deal_documents: a document never changes' using errcode = '42501';
  end if;
  if (new.removed_at, new.removed_by_user_id) is not distinct from (old.removed_at, old.removed_by_user_id) then
    new.updated_at := old.updated_at; -- nothing changed, so neither does its time
    return new;
  end if;
  if old.removed_at is not null or new.removed_by_user_id is distinct from public.app_user_id()
     or old.uploader_agency_id <> old.agency_id then
    raise exception 'deal_documents: only its uploading agency removes a document, once, as itself'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.deals d
     where d.agency_id = old.agency_id and d.id = old.deal_id and d.stage not in ('COMPLETION', 'FELL_THROUGH')) then
    raise exception 'deal_documents: a closed deal''s documents are fixed' using errcode = '42501';
  end if;
  new.removed_at := now();
  new.updated_at := now();
  return new;
end $$;
--> statement-breakpoint
revoke all on function deal_documents_guard() from public;
--> statement-breakpoint
create trigger deal_documents_guard before insert or update or delete on deal_documents
  for each row execute function deal_documents_guard();
--> statement-breakpoint
-- R2-04b mirror: an upload (the uploader's copy) appends the deal's other party's copy — the peer its own copy of the
-- deal names — and a removal reaches that copy in the same statement. SECURITY DEFINER owned by app_owner, search_path
-- pinned, executable by nobody: it reads `deals` (`definer_read`) and appends / updates `deal_documents` through their
-- `definer_append` / `definer_update` policies. The copy's own write (depth > 1) mirrors nothing.
create function deal_documents_mirror() returns trigger language plpgsql security definer
  set search_path = pg_catalog, pg_temp as $$
declare
  peer uuid;
begin
  if pg_trigger_depth() > 1 or new.uploader_agency_id <> new.agency_id then
    return null;
  end if;
  select d.peer_agency_id into peer from public.deals d where d.agency_id = new.agency_id and d.id = new.deal_id;
  if peer is null then
    raise exception 'deal_documents %: no deal of the agency', new.id using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    insert into public.deal_documents
      (agency_id, id, deal_id, uploader_agency_id, uploaded_by_user_id, uploader_name, kind, file_name, size_bytes,
       sha256, storage_key, created_at, updated_at)
    values (peer, new.id, new.deal_id, new.uploader_agency_id, new.uploaded_by_user_id, new.uploader_name, new.kind,
       new.file_name, new.size_bytes, new.sha256, new.storage_key, new.created_at, new.updated_at);
    return null;
  end if;
  if (old.removed_at, old.removed_by_user_id) is not distinct from (new.removed_at, new.removed_by_user_id) then
    return null;
  end if;
  update public.deal_documents c
     set removed_at = new.removed_at, removed_by_user_id = new.removed_by_user_id, updated_at = new.updated_at
   where c.agency_id = peer and c.id = new.id and c.deal_id = new.deal_id;
  if not found then
    raise exception 'deal_documents %: the peer''s copy is missing', new.id using errcode = '23514';
  end if;
  return null;
end $$;
--> statement-breakpoint
revoke all on function deal_documents_mirror() from public;
--> statement-breakpoint
create trigger deal_documents_mirror after insert or update on deal_documents
  for each row execute function deal_documents_mirror();