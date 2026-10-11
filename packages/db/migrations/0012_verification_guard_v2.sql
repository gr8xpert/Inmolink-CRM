-- S1-03 security review: the database itself ties VERIFIED to a recorded decision. Staff (app_staff)
-- may set an agency VERIFIED only in the transaction that wrote an APPROVED verification decision for
-- it — by the same staff member, for the details version being changed. A staff use case that skips the
-- decision (or a bug) cannot verify an agency without reviewer and reason on record. Replaces 0011.
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
    if new.status = 'VERIFIED' and old.status is distinct from 'VERIFIED' and not exists (
         select 1 from agency_verification_requests r
          where r.agency_id = old.agency_id and r.status = 'APPROVED'
            and r.reviewer_user_id = app_user_id() and r.reviewed_version = old.version
            and r.xmin = xid(pg_current_xact_id())) then
      raise exception 'agencies: VERIFIED needs an approved decision recorded in this transaction' using errcode = '42501';
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
