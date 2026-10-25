-- S12-F12 message fan-out, extended for `NETWORK` threads (S11 review): listed / open was checked only when the thread
-- was created, so messages kept flowing after the post closed or an agency was de-verified. A member's message in a
-- `NETWORK` thread now also needs its post OPEN and unexpired and both agencies listed (`agency_directory.listed`:
-- VERIFIED), else 42501; the `network.closePostThreads` job then marks the closed post's threads read-only. Otherwise as
-- S11-03: a member's message (trigger depth 1) must come from a participant of the thread, as its own agency, into a
-- thread that is not closed; every copy moves its thread's and its participants' `last_message_at` (the sender's own
-- message counts as read); a member's message in a `VIEWING` or `NETWORK` thread appends the other agency's copy (no
-- idempotency key). SECURITY DEFINER owned by app_owner, executable by nobody: it reads `network_posts` and
-- `agency_directory` (`definer_read`, as `chat_threads_mirror`), reads and updates both agencies' threads and
-- participants and appends the copy through their `definer_*` policies. AFTER INSERT: the thread's foreign key is
-- checked first.
create or replace function chat_messages_fanout() returns trigger language plpgsql security definer
  set search_path = pg_catalog, public as $$
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
        using errcode = '42501';
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
