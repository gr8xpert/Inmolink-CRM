import { withSystem } from '@inmolink/db';
import { mailer } from '@inmolink/platform/email';
import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import * as identity from '../identity';
import { supportConfig } from './config';
import { renderInboxEmail, renderStaffReplyEmail } from './emails';
import * as repo from './repo';

/**
 * support worker jobs (S13-05, PATTERNS §12). One e-mail per `support.message.posted` event (`jobId` = the event):
 * a staff reply goes to the member who opened the ticket (while still an active member); a new ticket or a member's
 * reply goes to the support inbox (`SUPPORT_INBOX_EMAIL`, when set). An internal note is no message: it has no event
 * and this job cannot load one. Fair share by agency; the send happens outside the transaction.
 */
export const supportJobs = {
  sendMessageEmail: defineJob({
    name: 'support.sendMessageEmail',
    pool: 'email',
    payload: z.object({ eventId: z.uuid(), agencyId: z.uuid(), messageId: z.uuid(), isNew: z.boolean() }),
    jobId: (p) => p.eventId,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 30_000,
    async run(p, { log }) {
      const { webUrl, staffInbox } = supportConfig();
      if (!webUrl) throw new Error('support: webUrl is not configured');
      const message = await withSystem('support.sendMessageEmail', async (tx) => {
        const m = await repo.getMessageForEmail(tx, p.agencyId, p.messageId);
        if (!m) return null;
        const ticket = { ticketId: m.ticketId, subject: m.subject, category: m.category, priority: m.priority };
        if (m.authorKind === 'STAFF') {
          const to = await identity.memberRecipient(tx, p.agencyId, m.createdBy);
          return to ? renderStaffReplyEmail(to, ticket, webUrl) : null;
        }
        return staffInbox ? renderInboxEmail(staffInbox, ticket, p.isNew, webUrl) : null;
      });
      if (!message) {
        log.info('support e-mail skipped (no recipient)');
        return;
      }
      // Outside the transaction (CLAUDE.md rule 6).
      await mailer().send(message);
      log.info('support e-mail sent');
    },
  }),
};
