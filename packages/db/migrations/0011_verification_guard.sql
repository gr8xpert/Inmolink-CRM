-- S1-03: column rules for staff verification. RLS decides which rows a role reaches; these triggers
-- decide which columns it may change. Staff (app_staff) change only an agency's status and the decision
-- of an open request; tenants never change a request after submitting it, nor a document once it is
-- attached. Security invoker, EXECUTE revoked (as in 0006): triggers fire without it.

-- agencies: replaces 0006. Tenant rules unchanged; app_staff may change only status.
create or replace function agencies_guard() returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if current_user = 'app_staff' then
    if tg_op = 'DELETE' then
      raise exception 'agencies: staff suspend agencies, they do not delete them' using errcode = '42501';
    end if;
    if (new.agency_id, new.kind, new.name, new.tax_id, new.address_line, new.city, new.postal_code, new.region,
        new.languages, new.onboarded_at, new.created_at)
       is distinct from (old.agency_id, old.kind, old.name, old.tax_id, old.address_line, old.city, old.postal_code,
        old.region, old.languages, old.onboarded_at, old.created_at) then
      raise exception 'agencies: staff change only the status' using errcode = '42501';
    end if;
    return new;
  end if;
  -- Only the request roles are restricted; workers (app_system), migrations and admins are not.
  if current_user not in ('app_user', 'app_auth') then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    raise exception 'agencies: only staff delete agencies' using errcode = '42501';
  end if;
  if new.status is distinct from old.status
     or (new.kind is distinct from old.kind and current_user <> 'app_auth')
     or (old.onboarded_at is not null and new.onboarded_at is distinct from old.onboarded_at) then
    raise exception 'agencies: status, kind and onboarding date change through staff only' using errcode = '42501';
  end if;
  return new;
end $$;
--> statement-breakpoint
create function agency_verification_requests_guard() returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if current_user not in ('app_user', 'app_staff') then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    raise exception 'agency_verification_requests: decisions are kept' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'SUBMITTED' or new.reviewed_version is not null or new.reviewer_user_id is not null
       or new.decision_reason is not null or new.decided_at is not null then
      raise exception 'agency_verification_requests: a request starts SUBMITTED, undecided' using errcode = '42501';
    end if;
    return new;
  end if;
  if new is not distinct from old then
    return new;
  end if;
  if current_user = 'app_user' then
    raise exception 'agency_verification_requests: only staff decide a request' using errcode = '42501';
  end if;
  -- app_staff: decide an open request once, as itself, with a reason; nothing else changes.
  if old.status <> 'SUBMITTED' then
    raise exception 'agency_verification_requests: the request was already decided' using errcode = '42501';
  end if;
  if new.status not in ('APPROVED', 'REJECTED') or new.reviewer_user_id is distinct from app_user_id()
     or new.reviewed_version is null or new.decided_at is null or coalesce(btrim(new.decision_reason), '') = '' then
    raise exception 'agency_verification_requests: a decision needs a status, the reviewer, the reviewed version and a reason'
      using errcode = '42501';
  end if;
  if (new.id, new.agency_id, new.details_version, new.submitted_by, new.submitted_at, new.created_at)
     is distinct from (old.id, old.agency_id, old.details_version, old.submitted_by, old.submitted_at, old.created_at) then
    raise exception 'agency_verification_requests: staff change only the decision' using errcode = '42501';
  end if;
  return new;
end $$;
--> statement-breakpoint
revoke all on function agency_verification_requests_guard() from public;
--> statement-breakpoint
create trigger agency_verification_requests_guard before insert or update or delete on agency_verification_requests
  for each row execute function agency_verification_requests_guard();
--> statement-breakpoint
create function agency_verification_documents_guard() returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if current_user <> 'app_user' then
    return coalesce(new, old);
  end if;
  if tg_op = 'INSERT' then
    if new.request_id is not null then
      raise exception 'agency_verification_documents: documents are attached on submission' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.request_id is not null then
      raise exception 'agency_verification_documents: a submitted document is kept' using errcode = '42501';
    end if;
    return old;
  end if;
  if new is not distinct from old then
    return new;
  end if;
  -- The only tenant update: attach an unattached document to the agency's own open request.
  if old.request_id is not null
     or (new.id, new.agency_id, new.kind, new.file_name, new.content_type, new.size_bytes, new.sha256,
         new.storage_key, new.uploaded_by, new.created_at)
        is distinct from (old.id, old.agency_id, old.kind, old.file_name, old.content_type, old.size_bytes,
         old.sha256, old.storage_key, old.uploaded_by, old.created_at)
     or not exists (select 1 from agency_verification_requests r
                     where r.id = new.request_id and r.agency_id = new.agency_id and r.status = 'SUBMITTED') then
    raise exception 'agency_verification_documents: a document only gets attached to the open request' using errcode = '42501';
  end if;
  return new;
end $$;
--> statement-breakpoint
revoke all on function agency_verification_documents_guard() from public;
--> statement-breakpoint
create trigger agency_verification_documents_guard before insert or update or delete on agency_verification_documents
  for each row execute function agency_verification_documents_guard();
