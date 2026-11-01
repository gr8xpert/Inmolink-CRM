import { NOTIFICATION_TYPES } from '@inmolink/contracts';
import { withSystem, withSystemClient } from '@inmolink/db';
import { sql } from 'drizzle-orm';
import { agenciesPerChunk, type CopyValue, copyNewRows, forEachChunk } from './copy';
import { seedAnchor, seededLeadId } from './crm';
import { SEEDED_AT } from './identity';
import { PER_AGENCY } from './profile';
import { createRng, seededId } from './rng';
import type { Seeder } from './seeders';

/**
 * Notifications for the scale seed (S16-F4): ~50 per member over the `NOTIFICATION_DAYS` before the seed day (inside
 * the monthly partitions pg_partman keeps; retention drops them after 12 months, like real ones), 40 % unread — what
 * the bell's feed and unread count read. Lead assignments (a seeded lead's inbox link) and task reminders, with the
 * display params their emitters write (`{ subject }`: a name or a title, never contact details). In-app only: nothing
 * waits for the e-mail digest. A lead assignment links a lead of that member (`crm.ts`: lead `j` is `user(j % 5)`'s).
 *
 * Every seeded member also gets an **e-mail-off preference for every notification type** (in-app stays on): the DAILY
 * client profiles' digests, lead and task notices of a load run never e-mail a synthetic address (on staging they
 * would reach the e-mail provider). Written `on conflict do nothing`: a member's own choice is kept. COPY per chunk,
 * deterministic, idempotent.
 */

export const NOTIFICATION_DAYS = 30;
const MINUTE = 60_000;
const NAMES = ['Lucía García', 'Hugo Martínez', 'Emma Smith', 'Lars Johansson', 'Anna de Vries', 'Pablo Romero'];
const TASKS = ['Call back', 'Send new listings', 'Book a viewing', 'Follow up the offer'];

const COLUMNS = [
  'id',
  'agency_id',
  'created_at',
  'user_id',
  'type',
  'params',
  'link',
  'in_app',
  'email_pending',
  'read_at',
] as const;

const pgArray = (ids: readonly string[]) => `{${ids.join(',')}}`;

export const notificationsSeeder: Seeder = {
  name: 'notifications.notifications',

  async dev() {
    return { inserted: 0, total: 0 };
  },

  async scale({ agencies: count, seed, chunk, anchor: given, onProgress }) {
    const anchorMs = seedAnchor(given).getTime();
    const write = async (start: number, end: number) => {
      const rows: CopyValue[][] = [];
      for (let a = start; a < end; a++) {
        const rng = createRng(seed, `notifications:${a}`);
        const agencyId = seededId(seed, 'agencies', a);
        for (let n = 0; n < PER_AGENCY.notifications; n++) {
          const at = new Date(anchorMs - rng.int(1, NOTIFICATION_DAYS * 24 * 60) * MINUTE);
          const lead = rng.next() < 0.6;
          const read = rng.next() < 0.6;
          const u = n % PER_AGENCY.users;
          // lead u + 10k: assigned (its index mod 10 is u < 5, never crm.ts's LEAD_UNASSIGNED 9) and member u's
          const leadIndex = u + 10 * rng.int(0, Math.floor((PER_AGENCY.leads - 1 - u) / 10));
          rows.push([
            seededId(seed, `notifications:${a}`, n),
            agencyId,
            at,
            seededId(seed, `identity.users:${a}`, u),
            lead ? 'LEAD_ASSIGNED' : 'TASK_DUE',
            JSON.stringify({ subject: rng.pick(lead ? NAMES : TASKS) }),
            lead ? `/inbox/${seededLeadId(seed, a, leadIndex)}` : '/tasks',
            true,
            false,
            read ? new Date(at.getTime() + rng.int(1, 600) * MINUTE) : null,
          ]);
        }
      }
      const prefs: { agency_id: string; user_id: string; type: string }[] = [];
      for (let a = start; a < end; a++) {
        for (let u = 0; u < PER_AGENCY.users; u++) {
          const userId = seededId(seed, `identity.users:${a}`, u);
          for (const type of NOTIFICATION_TYPES)
            prefs.push({ agency_id: seededId(seed, 'agencies', a), user_id: userId, type });
        }
      }
      return withSystemClient('seed.notifications.scale', async (client) => {
        await client.query(
          `insert into notification_preferences (agency_id, user_id, type, enabled, in_app, email, updated_at)
           select x.agency_id, x.user_id, x.type, true, true, false, $2
             from jsonb_to_recordset($1::jsonb) as x(agency_id uuid, user_id uuid, type text)
           on conflict do nothing`,
          [JSON.stringify(prefs), SEEDED_AT],
        );
        return copyNewRows(client, 'notifications', COLUMNS, rows);
      });
    };
    const inserted = await forEachChunk(count, agenciesPerChunk(chunk, PER_AGENCY.notifications), write, onProgress);
    const agencyIds = Array.from({ length: count }, (_, a) => seededId(seed, 'agencies', a));
    const r = await withSystem('seed.notifications.count', (tx) =>
      tx.execute<{ n: number }>(
        // seeded ones have no source key (an emitter's always has one)
        sql`select count(*)::int as n from notifications
             where agency_id = any(${pgArray(agencyIds)}::uuid[]) and source_key is null`,
      ),
    );
    return { inserted, total: r.rows[0]?.n ?? 0 };
  },
};
