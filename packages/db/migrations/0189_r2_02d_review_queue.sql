ALTER TABLE "client_profile_matches" DROP CONSTRAINT "client_profile_matches_status_ck";--> statement-breakpoint
ALTER TABLE "client_profile_matches" ADD COLUMN "selection_id" uuid;--> statement-breakpoint
ALTER TABLE "client_profile_matches" ADD CONSTRAINT "client_profile_matches_status_ck" CHECK ("client_profile_matches"."status" in ('PENDING_REVIEW', 'QUEUED', 'SENT', 'DISMISSED', 'EXPIRED', 'APPROVED'));--> statement-breakpoint
-- R2-02d: the review queue's moves. Tenants (`app_user`) never insert a match (only the matching worker writes one);
-- they change only `status`, `selection_id` and `updated_at` (column grants), along these moves: a pending match is
-- approved (into a selection), dismissed or expired; a dismissed one restored. Other roles
-- (app_system, migrations, the isolation suite's admin) are not checked.
create or replace function client_profile_matches_guard() returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if current_user <> 'app_user' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    raise exception 'client_profile_matches: matches are written by the matching worker only' using errcode = '42501';
  end if;
  if new is not distinct from old then
    return new;
  end if;
  if (old.status, new.status) not in (
       ('PENDING_REVIEW', 'APPROVED'), ('PENDING_REVIEW', 'DISMISSED'), ('PENDING_REVIEW', 'EXPIRED'),
       ('DISMISSED', 'PENDING_REVIEW')) then
    raise exception 'client_profile_matches: not a review move' using errcode = '42501';
  end if;
  if new.status = 'APPROVED' and new.selection_id is null then
    raise exception 'client_profile_matches: an approved match names its selection' using errcode = '42501';
  end if;
  -- the selection is one the member's RLS shows (their own agency's): never another agency's
  if new.selection_id is distinct from old.selection_id and new.selection_id is not null
     and not exists (select 1 from selections s where s.id = new.selection_id) then
    raise exception 'client_profile_matches: not a selection of the agency' using errcode = '42501';
  end if;
  if new.status <> 'APPROVED' and new.selection_id is distinct from old.selection_id then
    raise exception 'client_profile_matches: only an approval sets the selection' using errcode = '42501';
  end if;
  return new;
end $$;
--> statement-breakpoint
revoke all on function client_profile_matches_guard() from public;
--> statement-breakpoint
create trigger client_profile_matches_guard before insert or update on client_profile_matches
  for each row execute function client_profile_matches_guard();
