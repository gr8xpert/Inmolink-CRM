-- S12-F16: one pinned search_path for every SECURITY DEFINER function. The definers of 0130 (client registrations),
-- 0133 (viewing requests), 0135/0136/0140 (chat, network threads) ran with `pg_catalog, public`; S11-F5 set
-- `pg_catalog, pg_temp` (no schema a role can create objects in, pg_temp last). Re-created with `create or replace`
-- (applied migrations are never edited): same owner (app_owner), same grants (create or replace keeps the revokes),
-- same triggers; every non-catalog name in the bodies is already schema-qualified (`public.`).
-- S12-F12 review: `chat_messages_fanout` refuses a message in a NETWORK thread whose post closed or whose agencies are
-- no longer listed with its own error (P0001, hint `network_closed`), so the service maps only that to
-- CHAT_THREAD_CLOSED; every other refusal (42501) still propagates.
create or replace function public.chat_messages_fanout() returns trigger language plpgsql security definer
  set search_path = pg_catalog, pg_temp as $$
declare
  peer uuid;
  closed timestamptz;
  thread_kind text;
  post_id uuid;
  thread_peer uuid;
begin
  if pg_trigger_depth() = 1 then
    select t.closed_at, t.kind, t.network_post_id, t.peer_agency_id into closed, thread_kind, post_id, thread_peer
      from public.chat_threads t
     where t.agency_id = new.agency_id and t.id = new.thread_id;
    if closed is not null then
      raise exception 'chat_messages: thread % is closed', new.thread_id using errcode = '42501';
    end if;
    if thread_kind = 'NETWORK' and not (
      exists (select 1 from public.network_posts p
               where p.id = post_id and p.status = 'OPEN' and p.expires_at > now()
                 and p.agency_id in (new.agency_id, thread_peer))
      and exists (select 1 from public.agency_directory d where d.agency_id = new.agency_id and d.listed)
      and exists (select 1 from public.agency_directory d where d.agency_id = thread_peer and d.listed)) then
      raise exception 'chat_messages: network thread % is closed (post closed or an agency not listed)', new.thread_id
        using errcode = 'P0001', hint = 'network_closed';
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
create or replace function public.client_registrations_receipt() returns trigger language plpgsql security definer
  set search_path = pg_catalog, pg_temp as $$
declare
  owner_days integer;
  requested interval := new.expires_at - new.registered_at;
begin
  new.registered_at := now();
  new.expires_at := new.registered_at + requested;
  select s.registration_validity_days into owner_days
    from public.agency_settings s where s.agency_id = new.target_agency_id;
  if owner_days is not null then
    new.expires_at := least(new.expires_at, new.registered_at + make_interval(days => owner_days));
  end if;
  insert into public.client_registration_receipts
    (registration_id, agency_id, introducer_agency_id, target_kind, target_id, registered_at, expires_at)
  values (new.id, new.target_agency_id, new.agency_id, new.target_kind, new.target_id, new.registered_at, new.expires_at);
  return new;
end $$;
--> statement-breakpoint
create or replace function public.viewing_request_receipts_sync() returns trigger language plpgsql security definer
  set search_path = pg_catalog, pg_temp as $$
begin
  if (old.status, old.awaiting, old.proposed_start_at, old.scheduled_at, old.expires_at, old.outcome, old.outcome_at,
      old.closed_by, old.owner_accepted_at, old.owner_accepted_by, old.updated_at)
     is not distinct from
     (new.status, new.awaiting, new.proposed_start_at, new.scheduled_at, new.expires_at, new.outcome, new.outcome_at,
      new.closed_by, new.owner_accepted_at, new.owner_accepted_by, new.updated_at) then
    return null;
  end if;
  update public.viewing_requests v
     set status = new.status, awaiting = new.awaiting, proposed_start_at = new.proposed_start_at,
         scheduled_at = new.scheduled_at, expires_at = new.expires_at, outcome = new.outcome,
         outcome_at = new.outcome_at, closed_by = new.closed_by, owner_accepted_at = new.owner_accepted_at,
         owner_accepted_by = new.owner_accepted_by, updated_at = new.updated_at
   where v.id = new.request_id and v.agency_id = new.introducer_agency_id and v.owner_agency_id = new.agency_id
     and (v.status, v.awaiting, v.proposed_start_at, v.scheduled_at, v.expires_at, v.outcome, v.outcome_at,
          v.closed_by, v.owner_accepted_at, v.owner_accepted_by, v.updated_at)
         is distinct from
         (new.status, new.awaiting, new.proposed_start_at, new.scheduled_at, new.expires_at, new.outcome,
          new.outcome_at, new.closed_by, new.owner_accepted_at, new.owner_accepted_by, new.updated_at);
  if not found and not exists (
    select 1 from public.viewing_requests v
     where v.id = new.request_id and v.agency_id = new.introducer_agency_id and v.owner_agency_id = new.agency_id) then
    raise exception 'viewing_request_receipts %: the introducer''s request is missing', new.request_id
      using errcode = '23514';
  end if;
  return null;
end $$;
--> statement-breakpoint
create or replace function public.viewing_requests_receipt() returns trigger language plpgsql security definer
  set search_path = pg_catalog, pg_temp as $$
begin
  insert into public.viewing_request_receipts
    (request_id, agency_id, introducer_agency_id, target_kind, target_id, status, awaiting, proposed_start_at,
     scheduled_at, expires_at, outcome, outcome_at, closed_by, commission_bp, commission_fixed_cents,
     commission_currency, split_bp, commission_includes_vat, terms_valid_until, terms_at, introducer_accepted_at,
     introducer_accepted_by, owner_accepted_at, owner_accepted_by, created_at, updated_at)
  values (new.id, new.owner_agency_id, new.agency_id, new.target_kind, new.target_id, new.status, new.awaiting,
     new.proposed_start_at, new.scheduled_at, new.expires_at, new.outcome, new.outcome_at, new.closed_by,
     new.commission_bp, new.commission_fixed_cents, new.commission_currency, new.split_bp,
     new.commission_includes_vat, new.terms_valid_until, new.terms_at, new.introducer_accepted_at,
     new.introducer_accepted_by, new.owner_accepted_at, new.owner_accepted_by, new.created_at, new.updated_at);
  return null;
end $$;
--> statement-breakpoint
create or replace function public.viewing_requests_sync() returns trigger language plpgsql security definer
  set search_path = pg_catalog, pg_temp as $$
begin
  if (old.status, old.awaiting, old.proposed_start_at, old.scheduled_at, old.expires_at, old.outcome, old.outcome_at,
      old.closed_by, old.owner_accepted_at, old.owner_accepted_by, old.updated_at)
     is not distinct from
     (new.status, new.awaiting, new.proposed_start_at, new.scheduled_at, new.expires_at, new.outcome, new.outcome_at,
      new.closed_by, new.owner_accepted_at, new.owner_accepted_by, new.updated_at) then
    return null;
  end if;
  update public.viewing_request_receipts r
     set status = new.status, awaiting = new.awaiting, proposed_start_at = new.proposed_start_at,
         scheduled_at = new.scheduled_at, expires_at = new.expires_at, outcome = new.outcome,
         outcome_at = new.outcome_at, closed_by = new.closed_by, owner_accepted_at = new.owner_accepted_at,
         owner_accepted_by = new.owner_accepted_by, updated_at = new.updated_at
   where r.request_id = new.id and r.agency_id = new.owner_agency_id and r.introducer_agency_id = new.agency_id
     and (r.status, r.awaiting, r.proposed_start_at, r.scheduled_at, r.expires_at, r.outcome, r.outcome_at,
          r.closed_by, r.owner_accepted_at, r.owner_accepted_by, r.updated_at)
         is distinct from
         (new.status, new.awaiting, new.proposed_start_at, new.scheduled_at, new.expires_at, new.outcome,
          new.outcome_at, new.closed_by, new.owner_accepted_at, new.owner_accepted_by, new.updated_at);
  if not found and not exists (
    select 1 from public.viewing_request_receipts r
     where r.request_id = new.id and r.agency_id = new.owner_agency_id and r.introducer_agency_id = new.agency_id) then
    raise exception 'viewing_requests %: the owner''s copy is missing', new.id using errcode = '23514';
  end if;
  return null;
end $$;
