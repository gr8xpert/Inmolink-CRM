import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from './migrate';
import { checkMigrationRlsData, checkMigrationSql, MIGRATION_CHECK_FROM, RLS_DATA_CHECK_FROM } from './migration-check';

describe('migration check (S4-F2)', () => {
  it('[S4-F2] refuses a non-CONCURRENTLY index and an unbatched backfill on a large table; waivers and small tables pass', () => {
    const index = 'CREATE INDEX "properties_x_idx" ON "properties" USING btree ("agency_id");';
    expect(checkMigrationSql(index)).toEqual([expect.objectContaining({ reason: expect.stringMatching(/index/) })]);
    expect(checkMigrationSql('CREATE UNIQUE INDEX "u" ON "property_media" ("sha256");')).toHaveLength(1);
    expect(checkMigrationSql('CREATE INDEX CONCURRENTLY "x" ON "properties" ("ref");')).toEqual([]);
    expect(checkMigrationSql('CREATE INDEX "x" ON "agencies" ("name");')).toEqual([]);
    // `properties_x` is not `properties`
    expect(checkMigrationSql('CREATE INDEX "x" ON "properties_archive" ("ref");')).toEqual([]);

    expect(checkMigrationSql('UPDATE "properties" SET "x" = 1;')).toHaveLength(1);
    expect(checkMigrationSql('  update public.property_media m set kind = $1')).toHaveLength(1);
    expect(checkMigrationSql('DELETE FROM "outbox_events" WHERE true;')).toHaveLength(1);
    expect(checkMigrationSql('INSERT INTO "property_privates" ("a") SELECT 1 FROM "properties";')).toHaveLength(1);
    expect(checkMigrationSql('INSERT INTO "property_privates" ("a") VALUES (1);')).toEqual([]);
    // a backfill inside a DO block is still a backfill
    expect(checkMigrationSql('DO $$ BEGIN UPDATE "properties" pr SET "x" = 1; END $$;')).toHaveLength(1);

    const waived = `-- migration-check: allow table is empty in production before S6 imports\n${index}`;
    expect(
      checkMigrationSql(`${waived}--> statement-breakpoint\nALTER TABLE "properties" ADD COLUMN "y" int;`),
    ).toEqual([]);
    expect(checkMigrationSql(`-- migration-check: allow\n${index}`)).toHaveLength(1); // a waiver names its reason
  });

  it('[S4-F2] every migration since the check passes it', () => {
    const files = readdirSync(MIGRATIONS_FOLDER).filter(
      (f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) >= MIGRATION_CHECK_FROM,
    );
    for (const f of files) {
      expect(checkMigrationSql(readFileSync(join(MIGRATIONS_FOLDER, f), 'utf8')), f).toEqual([]);
    }
  });

  it('[S4-F2] the check would have flagged the earlier listing backfills (0057, 0062)', () => {
    for (const f of ['0057_listing_location_levels.sql', '0062_listing_private_refs.sql']) {
      expect(checkMigrationSql(readFileSync(join(MIGRATIONS_FOLDER, f), 'utf8')).length, f).toBeGreaterThan(0);
    }
  });

  it('[S17-F43] a data change must lift FORCE RLS: 0182 would have been refused, 0183 passes', () => {
    const read = (f: string) => readFileSync(join(MIGRATIONS_FOLDER, f), 'utf8');
    expect(checkMigrationRlsData(read('0182_s17_f37_property_type_es_labels.sql'))).not.toEqual([]);
    expect(checkMigrationRlsData(read('0183_s17_f43_property_type_es_labels_rls.sql'))).toEqual([]);
    // A function body runs later as another role; a foreign key's ON DELETE or ON UPDATE is no data change.
    expect(
      checkMigrationRlsData('CREATE FUNCTION f() RETURNS void AS $$ BEGIN DELETE FROM "x"; END $$ LANGUAGE plpgsql;'),
    ).toEqual([]);
    expect(
      checkMigrationRlsData(
        'ALTER TABLE "a" ADD FOREIGN KEY ("b") REFERENCES "c" ON DELETE CASCADE ON UPDATE NO ACTION;',
      ),
    ).toEqual([]);
    expect(
      checkMigrationRlsData(
        'create trigger t_guard before insert or update on t for each row execute function t_guard();',
      ),
    ).toEqual([]);
    expect(checkMigrationRlsData('-- migration-check: allow no RLS on this table\nUPDATE "x" SET "y" = 1;')).toEqual(
      [],
    );
  });

  it('[S17-F43] every migration since the RLS data check passes it', () => {
    const files = readdirSync(MIGRATIONS_FOLDER).filter(
      (f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) >= RLS_DATA_CHECK_FROM,
    );
    for (const f of files) {
      expect(checkMigrationRlsData(readFileSync(join(MIGRATIONS_FOLDER, f), 'utf8')), f).toEqual([]);
    }
  });
});
