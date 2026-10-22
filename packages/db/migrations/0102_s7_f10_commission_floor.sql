-- migration-check: allow built CONCURRENTLY by `pnpm db:migrate` before this migration (concurrent-indexes.ts): a no-op then
CREATE INDEX IF NOT EXISTS "listing_search_commissions_floor_idx" ON "listing_search_commissions" USING btree ("target_id","commission_bp");
