-- R2-04c guard (code review). For every role but app_owner (migrations): a dispute's agency, deal, opener and creation
-- never change; the database stamps its creation (no backdating into the oldest-first staff queue); its status moves
-- OPEN → RESOLVED only, and staff (app_staff) resolve it only as themselves (`resolved_by_user_id` = the staff member,
-- stamped `resolved_at`), never rewriting the party's reason. Members never update a dispute (RLS: no update policy).
create function deal_disputes_guard() returns trigger language plpgsql security invoker
  set search_path = pg_catalog, public as $$
begin
  if current_user = 'app_owner' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;
  if (new.id, new.agency_id, new.deal_id, new.opened_by_user_id, new.created_at)
     is distinct from (old.id, old.agency_id, old.deal_id, old.opened_by_user_id, old.created_at) then
    raise exception 'deal_disputes: the dispute''s deal, opener and creation are fixed' using errcode = '23514';
  end if;
  if new.status is distinct from old.status and not (old.status = 'OPEN' and new.status = 'RESOLVED') then
    raise exception 'deal_disputes: a dispute moves from OPEN to RESOLVED only' using errcode = '23514';
  end if;
  if current_user = 'app_staff' then
    if old.status <> 'OPEN' or new.status <> 'RESOLVED' or new.reason is distinct from old.reason
       or new.resolved_by_user_id is distinct from public.app_user_id() then
      raise exception 'deal_disputes: staff resolve an open dispute, as themselves' using errcode = '23514';
    end if;
    new.resolved_at := now();
    new.updated_at := now();
  end if;
  return new;
end $$;
--> statement-breakpoint
revoke all on function deal_disputes_guard() from public;
--> statement-breakpoint
create trigger deal_disputes_guard before insert or update on deal_disputes
  for each row execute function deal_disputes_guard();
