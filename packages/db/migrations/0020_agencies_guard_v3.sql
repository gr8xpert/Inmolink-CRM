-- S1-06: replaces the 0012 guard on agencies.
--   * Tenants (app_user) can no longer change the verified identity of their agency through a direct
--     table write: name, tax id and register number change only while the agency is PENDING (the
--     service already refused it with AGENCY_DETAILS_LOCKED; RLS cannot express column rules).
--   * Staff (app_staff) still change only the status: the check now compares the whole row except
--     status, version and updated_at, so columns added later (register_number now) are covered without
--     listing them here.
-- VERIFIED still needs an approved decision recorded in the same transaction (unchanged from 0012).
-- Security invoker, EXECUTE revoked (0006): triggers fire without it.
create or replace function agencies_guard() returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if current_user = 'app_staff' then
    if tg_op = 'DELETE' then
      raise exception 'agencies: staff suspend agencies, they do not delete them' using errcode = '42501';
    end if;
    -- A column staff may legitimately change later (e.g. a give-to-get exemption, a plan grant) must be
    -- added to this exclusion list in a new guard migration, or staff writes to it are refused here.
    if (to_jsonb(new) - array['status', 'version', 'updated_at']) is distinct from
       (to_jsonb(old) - array['status', 'version', 'updated_at']) then
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
  if old.status <> 'PENDING'
     and (new.name, new.tax_id, new.register_number) is distinct from (old.name, old.tax_id, old.register_number) then
    raise exception 'agencies: name, tax id and register number of a verified agency are locked once the agency is verified' using errcode = '42501';
  end if;
  return new;
end $$;
--> statement-breakpoint
revoke all on function agencies_guard() from public;
