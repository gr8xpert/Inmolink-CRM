-- R2-05b guards (security review). signature_signers: a request path (app_user) inserts a signer only into an OPEN
-- request, with nothing invited or signed yet — only the worker (app_system) records invitations and
-- signatures. signature_events: for every role but app_owner / app_system, the database stamps the event's time (the
-- page's code and failure limits count by it: no backdating) and an OTP_SENT row's expiry is at most 10 minutes away
-- (`SIGNING_CODE_TTL_SECONDS`).
create function signature_signers_guard() returns trigger language plpgsql security invoker
  set search_path = pg_catalog, public as $$
begin
  if current_user in ('app_owner', 'app_system') then
    return new;
  end if;
  if new.signed_at is not null or new.signature_event_id is not null or new.invited_at is not null then
    raise exception 'signature_signers: a new signer is neither invited nor signed' using errcode = '23514';
  end if;
  -- a request the caller sees (RLS: its own agency's) must still be OPEN; another agency's row is refused by RLS
  -- after this trigger, and a signer on another agency's request is never read (`signing_signer()` joins on agency)
  if exists (select 1 from public.signature_requests r where r.id = new.request_id and r.status <> 'OPEN') then
    raise exception 'signature_signers: signers join an open request only' using errcode = '23514';
  end if;
  new.created_at := now();
  new.updated_at := now();
  return new;
end $$;
--> statement-breakpoint
revoke all on function signature_signers_guard() from public;
--> statement-breakpoint
create trigger signature_signers_guard before insert on signature_signers
  for each row execute function signature_signers_guard();
--> statement-breakpoint
create function signature_events_guard() returns trigger language plpgsql security invoker
  set search_path = pg_catalog, public as $$
begin
  if current_user in ('app_owner', 'app_system') then
    return new;
  end if;
  new.created_at := now();
  if new.otp_expires_at is not null and new.otp_expires_at > now() + interval '10 minutes' then
    new.otp_expires_at := now() + interval '10 minutes';
  end if;
  return new;
end $$;
--> statement-breakpoint
revoke all on function signature_events_guard() from public;
--> statement-breakpoint
create trigger signature_events_guard before insert on signature_events
  for each row execute function signature_events_guard();
