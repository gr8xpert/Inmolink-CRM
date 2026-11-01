# Rate-limit coverage per route (S16-03)

Generated on 2026-11-01 from `rateLimitCoverage(app)` (platform rate-limit) over the built apps; the tests
`apps/{api,feed-api}/src/rate-limit-coverage.test.ts` fail when a new route is off without an exemption. HEAD
routes share their GET route's rules and are not listed. Next route handlers: `tests/workspace/security-coverage.test.ts`.
Summary and decisions: [security-R1.md](security-R1.md) §5.

## api (326 routes)

| Method | Route | Limited by |
|---|---|---|
| GET | `/healthz` | exempt: health probe |
| GET | `/readyz` | exempt: health probe |
| GET | `/v1/agency` | `agencies.read.ip`, `agencies.read.user` |
| GET | `/v1/agency-directory` | `agencies.directory.ip`, `agencies.directory.user`, `agencies.directory.tenant` |
| GET | `/v1/agency/ai-features` | `agencies.read.ip`, `agencies.read.user` |
| PUT | `/v1/agency/ai-features/:feature` | `agencies.write.ip`, `agencies.write.user` |
| GET | `/v1/agency/audit-log` | `compliance.read.ip`, `compliance.read.user` |
| GET | `/v1/agency/data-exports` | `compliance.read.ip`, `compliance.read.user` |
| POST | `/v1/agency/data-exports` | `compliance.export.ip`, `compliance.export.user` |
| GET | `/v1/agency/data-exports/:id` | `compliance.export.get.ip`, `compliance.export.get.user` |
| PUT | `/v1/agency/details` | `agencies.write.ip`, `agencies.write.user` |
| GET | `/v1/agency/preferred-agencies` | `agencies.read.ip`, `agencies.read.user` |
| POST | `/v1/agency/preferred-agencies` | `agencies.write.ip`, `agencies.write.user` |
| DELETE | `/v1/agency/preferred-agencies/:agencyId` | `agencies.write.ip`, `agencies.write.user` |
| PATCH | `/v1/agency/preferred-agencies/:agencyId` | `agencies.write.ip`, `agencies.write.user` |
| GET | `/v1/agency/profile` | `agencies.read.ip`, `agencies.read.user` |
| PUT | `/v1/agency/profile` | `agencies.write.ip`, `agencies.write.user` |
| DELETE | `/v1/agency/profile/logo` | `agencies.write.ip`, `agencies.write.user` |
| PUT | `/v1/agency/profile/logo` | `agencies.logo.ip`, `agencies.logo.user`, `agencies.logo.tenant` |
| GET | `/v1/agency/profile/logo/url` | `agencies.read.ip`, `agencies.read.user` |
| GET | `/v1/agency/retention` | `compliance.read.ip`, `compliance.read.user` |
| PUT | `/v1/agency/retention` | `compliance.retention.ip`, `compliance.retention.user` |
| GET | `/v1/agency/settings` | `agencies.read.ip`, `agencies.read.user` |
| PUT | `/v1/agency/settings` | `agencies.write.ip`, `agencies.write.user` |
| GET | `/v1/agency/verification` | `verification.read.ip`, `verification.read.user` |
| POST | `/v1/agency/verification` | `verification.write.ip`, `verification.write.user` |
| POST | `/v1/agency/verification/documents` | `verification.upload.ip`, `verification.upload.user`, `verification.upload.tenant` |
| DELETE | `/v1/agency/verification/documents/:id` | `verification.write.ip`, `verification.write.user` |
| GET | `/v1/api-keys` | `identity.apikeys.read.ip`, `identity.apikeys.read.user` |
| POST | `/v1/api-keys` | `identity.apikeys.write.ip`, `identity.apikeys.write.user`, `identity.apikeys.write.tenant` |
| DELETE | `/v1/api-keys/:keyId` | `identity.apikeys.write.ip`, `identity.apikeys.write.user`, `identity.apikeys.write.tenant` |
| POST | `/v1/api-keys/:keyId/rotate` | `identity.apikeys.write.ip`, `identity.apikeys.write.user`, `identity.apikeys.write.tenant` |
| GET | `/v1/billing` | `billing.read.ip`, `billing.read.user` |
| POST | `/v1/billing/checkout` | `billing.stripe.ip`, `billing.stripe.user`, `billing.stripe.tenant` |
| GET | `/v1/billing/invoices` | `billing.read.ip`, `billing.read.user` |
| POST | `/v1/billing/portal` | `billing.stripe.ip`, `billing.stripe.user`, `billing.stripe.tenant` |
| POST | `/v1/billing/stripe/webhook` | `billing.webhook.backstop.ip` |
| GET | `/v1/bookmark-folders` | `properties.read.ip`, `properties.read.user` |
| POST | `/v1/bookmark-folders` | `properties.write.ip`, `properties.write.user`, `properties.write.tenant` |
| DELETE | `/v1/bookmark-folders/:id` | `properties.write.ip`, `properties.write.user`, `properties.write.tenant` |
| PUT | `/v1/bookmark-folders/:id` | `properties.write.ip`, `properties.write.user`, `properties.write.tenant` |
| GET | `/v1/bookmark-folders/:id/bookmarks` | `properties.read.ip`, `properties.read.user` |
| POST | `/v1/bookmarks` | `properties.write.ip`, `properties.write.user`, `properties.write.tenant` |
| DELETE | `/v1/bookmarks/:id` | `properties.write.ip`, `properties.write.user`, `properties.write.tenant` |
| PATCH | `/v1/bookmarks/:id` | `properties.write.ip`, `properties.write.user`, `properties.write.tenant` |
| GET | `/v1/chat/threads` | `chat.read.ip`, `chat.read.user` |
| POST | `/v1/chat/threads` | `chat.create.ip`, `chat.create.user` |
| GET | `/v1/chat/threads/:id` | `chat.read.ip`, `chat.read.user` |
| GET | `/v1/chat/threads/:id/messages` | `chat.read.ip`, `chat.read.user` |
| POST | `/v1/chat/threads/:id/messages` | `chat.send.ip`, `chat.send.user` |
| POST | `/v1/chat/threads/:id/read` | `chat.write.ip`, `chat.write.user` |
| POST | `/v1/chat/viewing-threads` | `chat.create.ip`, `chat.create.user` |
| GET | `/v1/crm/activities` | `crm.activities.read.ip`, `crm.activities.read.user` |
| POST | `/v1/crm/activities` | `crm.activities.write.ip`, `crm.activities.write.user`, `crm.activities.write.tenant` |
| GET | `/v1/crm/calendar/events` | `crm.calendar.read.ip`, `crm.calendar.read.user` |
| POST | `/v1/crm/calendar/events` | `crm.calendar.write.ip`, `crm.calendar.write.user`, `crm.calendar.write.tenant` |
| GET | `/v1/crm/calendar/events/:id` | `crm.calendar.read.ip`, `crm.calendar.read.user` |
| PATCH | `/v1/crm/calendar/events/:id` | `crm.calendar.write.ip`, `crm.calendar.write.user`, `crm.calendar.write.tenant` |
| DELETE | `/v1/crm/calendar/feed` | `crm.calendar.feed.ip`, `crm.calendar.feed.user` |
| GET | `/v1/crm/calendar/feed` | `crm.calendar.read.ip`, `crm.calendar.read.user` |
| POST | `/v1/crm/calendar/feed` | `crm.calendar.feed.ip`, `crm.calendar.feed.user` |
| GET | `/v1/crm/contact-imports` | `crm.read.ip`, `crm.read.user` |
| POST | `/v1/crm/contact-imports` | `crm.import.ip`, `crm.import.user`, `crm.import.tenant` |
| GET | `/v1/crm/contact-imports/:id` | `crm.read.ip`, `crm.read.user` |
| POST | `/v1/crm/contact-imports/:id/start` | `crm.import.ip`, `crm.import.user`, `crm.import.tenant` |
| GET | `/v1/crm/contacts` | `crm.read.ip`, `crm.read.user` |
| POST | `/v1/crm/contacts` | `crm.write.ip`, `crm.write.user`, `crm.write.tenant` |
| GET | `/v1/crm/contacts/:id` | `crm.read.ip`, `crm.read.user` |
| PATCH | `/v1/crm/contacts/:id` | `crm.write.ip`, `crm.write.user`, `crm.write.tenant` |
| GET | `/v1/crm/contacts/:id/consents` | `crm.read.ip`, `crm.read.user` |
| POST | `/v1/crm/contacts/:id/erase` | `crm.write.ip`, `crm.write.user`, `crm.write.tenant`, `crm.erase.user`, `crm.erase.tenant` |
| POST | `/v1/crm/contacts/:id/merge` | `crm.write.ip`, `crm.write.user`, `crm.write.tenant` |
| GET | `/v1/crm/contacts/:id/notes` | `crm.read.ip`, `crm.read.user` |
| POST | `/v1/crm/contacts/:id/notes` | `crm.write.ip`, `crm.write.user`, `crm.write.tenant` |
| POST | `/v1/crm/contacts/lookup` | `crm.read.ip`, `crm.read.user` |
| GET | `/v1/crm/kpis/response-time` | `crm.kpi.read.ip`, `crm.kpi.read.user` |
| GET | `/v1/crm/lead-introductions` | `crm.leads.read.ip`, `crm.leads.read.user` |
| GET | `/v1/crm/lead-routing` | `crm.leads.read.ip`, `crm.leads.read.user` |
| PUT | `/v1/crm/lead-routing` | `crm.leads.write.ip`, `crm.leads.write.user`, `crm.leads.write.tenant` |
| GET | `/v1/crm/leads` | `crm.leads.read.ip`, `crm.leads.read.user` |
| POST | `/v1/crm/leads` | `crm.leads.write.ip`, `crm.leads.write.user`, `crm.leads.write.tenant` |
| GET | `/v1/crm/leads/:id` | `crm.leads.read.ip`, `crm.leads.read.user` |
| PATCH | `/v1/crm/leads/:id` | `crm.leads.write.ip`, `crm.leads.write.user`, `crm.leads.write.tenant` |
| POST | `/v1/crm/leads/:id/move` | `crm.pipeline.write.ip`, `crm.pipeline.write.user`, `crm.pipeline.write.tenant` |
| GET | `/v1/crm/leads/:id/stage-history` | `crm.pipeline.read.ip`, `crm.pipeline.read.user` |
| GET | `/v1/crm/pipeline/board` | `crm.pipeline.read.ip`, `crm.pipeline.read.user` |
| GET | `/v1/crm/pipeline/report` | `crm.pipeline.read.ip`, `crm.pipeline.read.user` |
| GET | `/v1/crm/pipeline/stages` | `crm.pipeline.read.ip`, `crm.pipeline.read.user` |
| POST | `/v1/crm/pipeline/stages` | `crm.pipeline.write.ip`, `crm.pipeline.write.user`, `crm.pipeline.write.tenant` |
| PATCH | `/v1/crm/pipeline/stages/:id` | `crm.pipeline.write.ip`, `crm.pipeline.write.user`, `crm.pipeline.write.tenant` |
| GET | `/v1/crm/pipeline/stages/:id/leads` | `crm.pipeline.read.ip`, `crm.pipeline.read.user` |
| PUT | `/v1/crm/pipeline/stages/order` | `crm.pipeline.write.ip`, `crm.pipeline.write.user`, `crm.pipeline.write.tenant` |
| GET | `/v1/crm/prospects` | `crm.prospects.read.ip`, `crm.prospects.read.user` |
| POST | `/v1/crm/prospects` | `crm.prospects.write.ip`, `crm.prospects.write.user`, `crm.prospects.write.tenant` |
| DELETE | `/v1/crm/prospects/:id` | `crm.prospects.write.ip`, `crm.prospects.write.user`, `crm.prospects.write.tenant` |
| GET | `/v1/crm/prospects/:id` | `crm.prospects.read.ip`, `crm.prospects.read.user` |
| PATCH | `/v1/crm/prospects/:id` | `crm.prospects.write.ip`, `crm.prospects.write.user`, `crm.prospects.write.tenant` |
| POST | `/v1/crm/prospects/:id/convert` | `crm.prospects.write.ip`, `crm.prospects.write.user`, `crm.prospects.write.tenant` |
| POST | `/v1/crm/prospects/:id/move` | `crm.prospects.write.ip`, `crm.prospects.write.user`, `crm.prospects.write.tenant` |
| GET | `/v1/crm/prospects/board` | `crm.prospects.read.ip`, `crm.prospects.read.user` |
| GET | `/v1/crm/prospects/follow-ups` | `crm.prospects.read.ip`, `crm.prospects.read.user` |
| GET | `/v1/crm/prospects/stages/:stage` | `crm.prospects.read.ip`, `crm.prospects.read.user` |
| GET | `/v1/crm/tasks` | `crm.tasks.read.ip`, `crm.tasks.read.user` |
| POST | `/v1/crm/tasks` | `crm.tasks.write.ip`, `crm.tasks.write.user`, `crm.tasks.write.tenant` |
| DELETE | `/v1/crm/tasks/:id` | `crm.tasks.write.ip`, `crm.tasks.write.user`, `crm.tasks.write.tenant` |
| GET | `/v1/crm/tasks/:id` | `crm.tasks.read.ip`, `crm.tasks.read.user` |
| PATCH | `/v1/crm/tasks/:id` | `crm.tasks.write.ip`, `crm.tasks.write.user`, `crm.tasks.write.tenant` |
| GET | `/v1/developments` | `developments.read.ip`, `developments.read.user` |
| POST | `/v1/developments` | `developments.write.ip`, `developments.write.user`, `developments.write.tenant` |
| DELETE | `/v1/developments/:id` | `developments.write.ip`, `developments.write.user`, `developments.write.tenant` |
| GET | `/v1/developments/:id` | `developments.read.ip`, `developments.read.user` |
| PATCH | `/v1/developments/:id` | `developments.write.ip`, `developments.write.user`, `developments.write.tenant` |
| PUT | `/v1/developments/:id/access` | `developments.write.ip`, `developments.write.user`, `developments.write.tenant` |
| GET | `/v1/developments/:id/documents` | `developments.read.ip`, `developments.read.user` |
| POST | `/v1/developments/:id/documents` | `developments.write.ip`, `developments.write.user`, `developments.write.tenant` |
| DELETE | `/v1/developments/:id/documents/:documentId` | `developments.write.ip`, `developments.write.user`, `developments.write.tenant` |
| PATCH | `/v1/developments/:id/documents/:documentId` | `developments.write.ip`, `developments.write.user`, `developments.write.tenant` |
| GET | `/v1/developments/:id/documents/:documentId/url` | `developments.read.ip`, `developments.read.user` |
| GET | `/v1/developments/:id/price-lists` | `developments.read.ip`, `developments.read.user` |
| POST | `/v1/developments/:id/price-lists` | `developments.write.ip`, `developments.write.user`, `developments.write.tenant` |
| GET | `/v1/developments/:id/price-lists/:version` | `developments.read.ip`, `developments.read.user` |
| POST | `/v1/developments/:id/price-lists/:version/approve` | `developments.write.ip`, `developments.write.user`, `developments.write.tenant` |
| GET | `/v1/developments/:id/units` | `developments.read.ip`, `developments.read.user` |
| POST | `/v1/developments/:id/units` | `developments.write.ip`, `developments.write.user`, `developments.write.tenant` |
| DELETE | `/v1/developments/:id/units/:unitId` | `developments.write.ip`, `developments.write.user`, `developments.write.tenant` |
| PATCH | `/v1/developments/:id/units/:unitId` | `developments.write.ip`, `developments.write.user`, `developments.write.tenant` |
| POST | `/v1/developments/:id/units/bulk` | `developments.write.ip`, `developments.write.user`, `developments.write.tenant` |
| GET | `/v1/documents/:documentId` | `documents.read.ip`, `documents.read.user` |
| POST | `/v1/documents/brochures` | `documents.render.ip`, `documents.render.user`, `documents.render.tenant` |
| POST | `/v1/documents/portfolios` | `documents.render.ip`, `documents.render.user`, `documents.render.tenant` |
| GET | `/v1/imports/connections` | `imports.read.ip`, `imports.read.user` |
| POST | `/v1/imports/connections` | `imports.write.ip`, `imports.write.user`, `imports.write.tenant` |
| DELETE | `/v1/imports/connections/:id` | `imports.write.ip`, `imports.write.user`, `imports.write.tenant` |
| GET | `/v1/imports/connections/:id` | `imports.read.ip`, `imports.read.user` |
| PATCH | `/v1/imports/connections/:id` | `imports.write.ip`, `imports.write.user`, `imports.write.tenant` |
| POST | `/v1/imports/connections/:id/resume` | `imports.write.ip`, `imports.write.user`, `imports.write.tenant` |
| GET | `/v1/imports/connections/:id/runs` | `imports.read.ip`, `imports.read.user` |
| POST | `/v1/imports/connections/:id/runs` | `imports.write.ip`, `imports.write.user`, `imports.write.tenant`, `imports.run.user`, `imports.run.tenant` |
| POST | `/v1/imports/mapper/dry-run` | `imports.write.ip`, `imports.write.user`, `imports.write.tenant` |
| POST | `/v1/imports/mapper/preview` | `imports.preview.ip`, `imports.preview.user` |
| POST | `/v1/imports/mapper/sample` | `imports.sample.user`, `imports.sample.tenant` |
| POST | `/v1/imports/mapper/sample-url` | `imports.sample.user`, `imports.sample.tenant` |
| GET | `/v1/imports/mapping-profiles` | `imports.read.ip`, `imports.read.user` |
| POST | `/v1/imports/mapping-profiles` | `imports.write.ip`, `imports.write.user`, `imports.write.tenant` |
| GET | `/v1/imports/mapping-profiles/:id` | `imports.read.ip`, `imports.read.user` |
| PATCH | `/v1/imports/mapping-profiles/:id` | `imports.write.ip`, `imports.write.user`, `imports.write.tenant` |
| GET | `/v1/imports/runs/:runId` | `imports.read.ip`, `imports.read.user` |
| GET | `/v1/imports/runs/:runId/errors` | `imports.read.ip`, `imports.read.user` |
| POST | `/v1/imports/sheets` | `imports.sheet.user`, `imports.sheet.tenant` |
| POST | `/v1/imports/sheets/import` | `imports.run.user`, `imports.run.tenant` |
| GET | `/v1/invites` | `identity.team.read.ip`, `identity.team.read.user` |
| POST | `/v1/invites` | `identity.team.write.ip`, `identity.team.write.user`, `identity.invite.tenant`, `identity.invite.user.day` |
| DELETE | `/v1/invites/:inviteId` | `identity.team.write.ip`, `identity.team.write.user` |
| POST | `/v1/listing-bulk-actions` | `properties.bulk.ip`, `properties.bulk.user`, `properties.bulk.tenant` |
| GET | `/v1/listing-bulk-actions/:id` | `properties.read.ip`, `properties.read.user` |
| GET | `/v1/listing-overrides/:targetKind/:targetId` | `properties.read.ip`, `properties.read.user` |
| DELETE | `/v1/listing-overrides/:targetKind/:targetId/:locale` | `properties.write.ip`, `properties.write.user`, `properties.write.tenant` |
| PUT | `/v1/listing-overrides/:targetKind/:targetId/:locale` | `properties.write.ip`, `properties.write.user`, `properties.write.tenant` |
| POST | `/v1/listing-studio-batches` | `ai-features.studio-bulk.ip`, `ai-features.studio-bulk.user`, `ai-features.studio-bulk.tenant` |
| GET | `/v1/listing-views` | `properties.read.ip`, `properties.read.user` |
| POST | `/v1/listing-views` | `properties.write.ip`, `properties.write.user`, `properties.write.tenant` |
| DELETE | `/v1/listing-views/:id` | `properties.write.ip`, `properties.write.user`, `properties.write.tenant` |
| PUT | `/v1/listing-views/:id` | `properties.write.ip`, `properties.write.user`, `properties.write.tenant` |
| GET | `/v1/listings` | `properties.read.ip`, `properties.read.user` |
| POST | `/v1/listings` | `properties.write.ip`, `properties.write.user`, `properties.write.tenant` |
| DELETE | `/v1/listings/:id` | `properties.write.ip`, `properties.write.user`, `properties.write.tenant` |
| GET | `/v1/listings/:id` | `properties.read.ip`, `properties.read.user` |
| PATCH | `/v1/listings/:id` | `properties.write.ip`, `properties.write.user`, `properties.write.tenant` |
| GET | `/v1/listings/:id/bookmarks` | `properties.read.ip`, `properties.read.user` |
| POST | `/v1/listings/:id/confirm` | `properties.write.ip`, `properties.write.user`, `properties.write.tenant` |
| GET | `/v1/listings/:id/content` | `properties.read.ip`, `properties.read.user` |
| GET | `/v1/listings/:id/documents` | `media.read.ip`, `media.read.user` |
| POST | `/v1/listings/:id/documents` | `media.write.ip`, `media.write.user`, `media.write.tenant` |
| DELETE | `/v1/listings/:id/documents/:documentId` | `media.write.ip`, `media.write.user`, `media.write.tenant` |
| GET | `/v1/listings/:id/documents/:documentId/url` | `media.read.ip`, `media.read.user` |
| PUT | `/v1/listings/:id/features` | `properties.write.ip`, `properties.write.user`, `properties.write.tenant` |
| GET | `/v1/listings/:id/media` | `media.read.ip`, `media.read.user` |
| DELETE | `/v1/listings/:id/media/:mediaId` | `media.write.ip`, `media.write.user`, `media.write.tenant` |
| PATCH | `/v1/listings/:id/media/:mediaId` | `media.write.ip`, `media.write.user`, `media.write.tenant` |
| PUT | `/v1/listings/:id/media/order` | `media.write.ip`, `media.write.user`, `media.write.tenant` |
| GET | `/v1/listings/:id/quality` | `quality.read.ip`, `quality.read.user` |
| POST | `/v1/listings/:id/restore` | `properties.write.ip`, `properties.write.user`, `properties.write.tenant` |
| POST | `/v1/listings/:id/studio` | `ai-features.studio.ip`, `ai-features.studio.user`, `ai-features.studio.tenant` |
| DELETE | `/v1/listings/:id/translations/:locale` | `properties.write.ip`, `properties.write.user`, `properties.write.tenant` |
| PUT | `/v1/listings/:id/translations/:locale` | `properties.write.ip`, `properties.write.user`, `properties.write.tenant` |
| POST | `/v1/listings/:id/videos` | `media.write.ip`, `media.write.user`, `media.write.tenant` |
| GET | `/v1/me` | `identity.me.ip`, `identity.me.user` |
| GET | `/v1/me/capabilities` | `identity.capabilities.ip`, `identity.capabilities.user` |
| POST | `/v1/media/check` | `media.write.ip`, `media.write.user`, `media.write.tenant` |
| POST | `/v1/media/register` | `media.write.ip`, `media.write.user`, `media.write.tenant` |
| GET | `/v1/members` | `identity.team.read.ip`, `identity.team.read.user` |
| POST | `/v1/members/:userId/deactivate` | `identity.team.write.ip`, `identity.team.write.user` |
| PUT | `/v1/members/:userId/role` | `identity.team.write.ip`, `identity.team.write.user` |
| GET | `/v1/mls/received-registrations` | `mls.read.ip`, `mls.read.user` |
| GET | `/v1/mls/received-viewing-requests` | `mls.read.ip`, `mls.read.user` |
| GET | `/v1/mls/registrations` | `mls.read.ip`, `mls.read.user` |
| POST | `/v1/mls/registrations` | `mls.write.ip`, `mls.write.user`, `mls.write.tenant` |
| GET | `/v1/mls/viewing-requests` | `mls.read.ip`, `mls.read.user` |
| POST | `/v1/mls/viewing-requests` | `mls.write.ip`, `mls.write.user`, `mls.write.tenant` |
| GET | `/v1/mls/viewing-requests/:id` | `mls.read.ip`, `mls.read.user` |
| POST | `/v1/mls/viewing-requests/:id/accept` | `mls.write.ip`, `mls.write.user`, `mls.write.tenant` |
| POST | `/v1/mls/viewing-requests/:id/cancel` | `mls.write.ip`, `mls.write.user`, `mls.write.tenant` |
| POST | `/v1/mls/viewing-requests/:id/decline` | `mls.write.ip`, `mls.write.user`, `mls.write.tenant` |
| POST | `/v1/mls/viewing-requests/:id/outcome` | `mls.write.ip`, `mls.write.user`, `mls.write.tenant` |
| POST | `/v1/mls/viewing-requests/:id/reschedule` | `mls.write.ip`, `mls.write.user`, `mls.write.tenant` |
| GET | `/v1/mls/viewing-requests/:id/terms` | `mls.read.ip`, `mls.read.user` |
| GET | `/v1/network/posts` | `network.board.read.ip`, `network.board.read.user` |
| POST | `/v1/network/posts` | `network.board.post.ip`, `network.board.post.user`, `network.board.post.tenant` |
| GET | `/v1/network/posts/:id` | `network.board.read.ip`, `network.board.read.user` |
| POST | `/v1/network/posts/:id/close` | `network.board.write.ip`, `network.board.write.user` |
| POST | `/v1/network/posts/:id/replies` | `network.board.reply.ip`, `network.board.reply.user`, `network.board.reply.tenant` |
| POST | `/v1/network/search` | `search.network.ip`, `search.network.user`, `search.network.tenant` |
| GET | `/v1/network/subscriptions` | `network.board.read.ip`, `network.board.read.user` |
| POST | `/v1/network/subscriptions` | `network.board.write.ip`, `network.board.write.user` |
| DELETE | `/v1/network/subscriptions/:id` | `network.board.write.ip`, `network.board.write.user` |
| PUT | `/v1/network/subscriptions/:id` | `network.board.write.ip`, `network.board.write.user` |
| POST | `/v1/network/threads/:id/join` | `network.board.write.ip`, `network.board.write.user` |
| GET | `/v1/notifications` | `notifications.read.ip`, `notifications.read.user` |
| GET | `/v1/notifications/preferences` | `notifications.read.ip`, `notifications.read.user` |
| PATCH | `/v1/notifications/preferences/:type` | `notifications.write.ip`, `notifications.write.user` |
| POST | `/v1/notifications/read` | `notifications.write.ip`, `notifications.write.user` |
| POST | `/v1/notifications/read-all` | `notifications.read-all.ip`, `notifications.read-all.user` |
| GET | `/v1/notifications/unread-count` | `notifications.read.ip`, `notifications.read.user` |
| GET | `/v1/onboarding` | `onboarding.read.ip`, `onboarding.read.user` |
| GET | `/v1/portal-channels` | `exports.read.ip`, `exports.read.user` |
| GET | `/v1/portal-connections` | `exports.read.ip`, `exports.read.user` |
| POST | `/v1/portal-connections` | `exports.write.ip`, `exports.write.user`, `exports.write.tenant` |
| DELETE | `/v1/portal-connections/:connectionId` | `exports.write.ip`, `exports.write.user`, `exports.write.tenant` |
| GET | `/v1/portal-connections/:connectionId` | `exports.read.ip`, `exports.read.user` |
| PATCH | `/v1/portal-connections/:connectionId` | `exports.write.ip`, `exports.write.user`, `exports.write.tenant` |
| GET | `/v1/portal-connections/:connectionId/issues` | `exports.read.ip`, `exports.read.user` |
| GET | `/v1/portal-connections/:connectionId/properties` | `exports.read.ip`, `exports.read.user` |
| PUT | `/v1/portal-connections/:connectionId/properties` | `exports.write.ip`, `exports.write.user`, `exports.write.tenant` |
| GET | `/v1/portal-connections/:connectionId/runs` | `exports.read.ip`, `exports.read.user` |
| GET | `/v1/portal-connections/:connectionId/selection` | `exports.read.ip`, `exports.read.user` |
| DELETE | `/v1/portal-connections/:connectionId/token` | `exports.write.ip`, `exports.write.user`, `exports.write.tenant` |
| POST | `/v1/portal-connections/:connectionId/token` | `exports.write.ip`, `exports.write.user`, `exports.write.tenant` |
| GET | `/v1/saved-searches` | `matching.saved-searches.read.ip`, `matching.saved-searches.read.user` |
| POST | `/v1/saved-searches` | `matching.saved-searches.write.ip`, `matching.saved-searches.write.user` |
| DELETE | `/v1/saved-searches/:id` | `matching.saved-searches.write.ip`, `matching.saved-searches.write.user` |
| PUT | `/v1/saved-searches/:id` | `matching.saved-searches.write.ip`, `matching.saved-searches.write.user` |
| GET | `/v1/selections` | `presentations.read.ip`, `presentations.read.user` |
| POST | `/v1/selections` | `presentations.write.ip`, `presentations.write.user`, `presentations.write.tenant` |
| GET | `/v1/selections/:id` | `presentations.read.ip`, `presentations.read.user` |
| PATCH | `/v1/selections/:id` | `presentations.write.ip`, `presentations.write.user`, `presentations.write.tenant` |
| GET | `/v1/selections/:id/interactions` | `presentations.read.ip`, `presentations.read.user` |
| POST | `/v1/selections/:id/link` | `presentations.write.ip`, `presentations.write.user`, `presentations.write.tenant` |
| POST | `/v1/selections/:id/pdf` | `documents.render.ip`, `documents.render.user`, `documents.render.tenant` |
| POST | `/v1/session/client-mode` | `identity.client-mode.start.ip`, `identity.client-mode.start.user` |
| GET | `/v1/sites` | `websites.read.ip`, `websites.read.user` |
| POST | `/v1/sites` | `websites.write.ip`, `websites.write.user`, `websites.write.tenant` |
| GET | `/v1/sites/:siteId` | `websites.read.ip`, `websites.read.user` |
| PATCH | `/v1/sites/:siteId` | `websites.write.ip`, `websites.write.user`, `websites.write.tenant` |
| DELETE | `/v1/sites/:siteId/feed` | `websites.write.ip`, `websites.write.user`, `websites.write.tenant` |
| GET | `/v1/sites/:siteId/feed` | `websites.read.ip`, `websites.read.user` |
| POST | `/v1/sites/:siteId/feed/token` | `websites.write.ip`, `websites.write.user`, `websites.write.tenant` |
| GET | `/v1/social/accounts` | `social.read.ip`, `social.read.user` |
| DELETE | `/v1/social/accounts/:accountId` | `social.write.ip`, `social.write.user` |
| POST | `/v1/social/connect` | `social.write.ip`, `social.write.user`, `social.connect.user`, `social.connect.tenant` |
| POST | `/v1/social/connect/callback` | `social.write.ip`, `social.write.user`, `social.connect.user`, `social.connect.tenant` |
| GET | `/v1/social/posts` | `social.read.ip`, `social.read.user` |
| POST | `/v1/social/posts` | `social.write.ip`, `social.write.user` |
| GET | `/v1/social/posts/:postId` | `social.read.ip`, `social.read.user` |
| PATCH | `/v1/social/posts/:postId` | `social.write.ip`, `social.write.user` |
| POST | `/v1/social/posts/:postId/cancel` | `social.write.ip`, `social.write.user` |
| POST | `/v1/social/posts/:postId/captions` | `social.write.ip`, `social.write.user` |
| GET | `/v1/staff-access` | `identity.team.read.ip`, `identity.team.read.user` |
| GET | `/v1/staff/agencies` | `staff.tenants.ip`, `staff.tenants.user` |
| GET | `/v1/staff/agencies/:agencyId` | `staff.tenants.ip`, `staff.tenants.user` |
| GET | `/v1/staff/agencies/:agencyId/billing` | `staff.admin.read.ip`, `staff.admin.read.user` |
| PUT | `/v1/staff/agencies/:agencyId/give-to-get` | `staff.tenants.ip`, `staff.tenants.user` |
| GET | `/v1/staff/agencies/:agencyId/members` | `staff.identity.read.ip`, `staff.identity.read.user` |
| GET | `/v1/staff/agencies/:agencyId/onboarding` | `staff.onboarding.ip`, `staff.onboarding.user` |
| GET | `/v1/staff/ai-spend` | `staff.admin.read.ip`, `staff.admin.read.user` |
| GET | `/v1/staff/audit-logs` | `staff.audit.ip`, `staff.audit.user` |
| GET | `/v1/staff/feature-flags` | `staff.admin.read.ip`, `staff.admin.read.user` |
| PUT | `/v1/staff/feature-flags/:key` | `staff.admin.write.ip`, `staff.admin.write.user` |
| GET | `/v1/staff/impersonations` | `staff.identity.read.ip`, `staff.identity.read.user` |
| POST | `/v1/staff/impersonations` | `staff.impersonation.ip`, `staff.impersonation.user` |
| POST | `/v1/staff/impersonations/:id/end` | `staff.impersonation.ip`, `staff.impersonation.user` |
| POST | `/v1/staff/imports/connections/:id/resume` | `staff.imports.write.ip`, `staff.imports.write.user` |
| GET | `/v1/staff/imports/health` | `staff.imports.read.ip`, `staff.imports.read.user` |
| GET | `/v1/staff/me` | `staff.identity.read.ip`, `staff.identity.read.user` |
| GET | `/v1/staff/migration/validations` | `staff.admin.read.ip`, `staff.admin.read.user` |
| GET | `/v1/staff/migration/validations/:id` | `staff.admin.read.ip`, `staff.admin.read.user` |
| GET | `/v1/staff/operations` | `staff.admin.read.ip`, `staff.admin.read.user` |
| POST | `/v1/staff/operations` | `staff.admin.write.ip`, `staff.admin.write.user` |
| GET | `/v1/staff/operations/:id` | `staff.admin.read.ip`, `staff.admin.read.user` |
| POST | `/v1/staff/operations/:id/cancel` | `staff.admin.write.ip`, `staff.admin.write.user` |
| POST | `/v1/staff/plan-grants` | `staff.admin.write.ip`, `staff.admin.write.user` |
| POST | `/v1/staff/plan-grants/:id/revoke` | `staff.admin.write.ip`, `staff.admin.write.user` |
| PUT | `/v1/staff/price-locks` | `staff.admin.write.ip`, `staff.admin.write.user` |
| GET | `/v1/staff/queues/health` | `staff.admin.read.ip`, `staff.admin.read.user` |
| GET | `/v1/staff/support/tickets` | `staff.support.ip`, `staff.support.user` |
| GET | `/v1/staff/support/tickets/:id` | `staff.support.ip`, `staff.support.user` |
| PATCH | `/v1/staff/support/tickets/:id` | `staff.support.ip`, `staff.support.user` |
| GET | `/v1/staff/support/tickets/:id/attachments/:attachmentId/url` | `staff.support.ip`, `staff.support.user` |
| POST | `/v1/staff/support/tickets/:id/messages` | `staff.support.ip`, `staff.support.user` |
| GET | `/v1/staff/taxonomy` | `staff.taxonomy.read.ip`, `staff.taxonomy.read.user` |
| PUT | `/v1/staff/taxonomy/catalog-order` | `staff.taxonomy.write.ip`, `staff.taxonomy.write.user` |
| PUT | `/v1/staff/taxonomy/catalog/:id` | `staff.taxonomy.write.ip`, `staff.taxonomy.write.user` |
| POST | `/v1/staff/taxonomy/catalog/:kind/:id/aliases` | `staff.taxonomy.write.ip`, `staff.taxonomy.write.user` |
| DELETE | `/v1/staff/taxonomy/catalog/:kind/:id/aliases/:aliasId` | `staff.taxonomy.write.ip`, `staff.taxonomy.write.user` |
| GET | `/v1/staff/taxonomy/catalog/:kind/:scope/:id` | `staff.taxonomy.read.ip`, `staff.taxonomy.read.user` |
| POST | `/v1/staff/taxonomy/locations` | `staff.taxonomy.write.ip`, `staff.taxonomy.write.user` |
| PUT | `/v1/staff/taxonomy/locations-order` | `staff.taxonomy.write.ip`, `staff.taxonomy.write.user` |
| GET | `/v1/staff/taxonomy/locations/:id` | `staff.taxonomy.read.ip`, `staff.taxonomy.read.user` |
| PATCH | `/v1/staff/taxonomy/locations/:id` | `staff.taxonomy.write.ip`, `staff.taxonomy.write.user` |
| POST | `/v1/staff/taxonomy/locations/:id/aliases` | `staff.taxonomy.write.ip`, `staff.taxonomy.write.user` |
| DELETE | `/v1/staff/taxonomy/locations/:id/aliases/:aliasId` | `staff.taxonomy.write.ip`, `staff.taxonomy.write.user` |
| GET | `/v1/staff/taxonomy/locations/:id/children` | `staff.taxonomy.read.ip`, `staff.taxonomy.read.user` |
| GET | `/v1/staff/taxonomy/unmatched` | `staff.taxonomy.read.ip`, `staff.taxonomy.read.user` |
| POST | `/v1/staff/taxonomy/unmatched/:id/ignore` | `staff.taxonomy.write.ip`, `staff.taxonomy.write.user` |
| POST | `/v1/staff/taxonomy/unmatched/:id/map` | `staff.taxonomy.write.ip`, `staff.taxonomy.write.user` |
| GET | `/v1/staff/verification-requests` | `staff.verification.ip`, `staff.verification.user` |
| GET | `/v1/staff/verification-requests/:id` | `staff.verification.ip`, `staff.verification.user` |
| POST | `/v1/staff/verification-requests/:id/decision` | `staff.verification.ip`, `staff.verification.user` |
| GET | `/v1/staff/verification-requests/:id/documents/:documentId/url` | `staff.verification.ip`, `staff.verification.user` |
| GET | `/v1/support/tickets` | `support.read.ip`, `support.read.user` |
| POST | `/v1/support/tickets` | `support.write.ip`, `support.write.user`, `support.write.tenant` |
| GET | `/v1/support/tickets/:id` | `support.read.ip`, `support.read.user` |
| POST | `/v1/support/tickets/:id/attachments` | `support.upload.ip`, `support.upload.user`, `support.upload.tenant` |
| GET | `/v1/support/tickets/:id/attachments/:attachmentId/url` | `support.read.ip`, `support.read.user` |
| POST | `/v1/support/tickets/:id/messages` | `support.write.ip`, `support.write.user`, `support.write.tenant` |
| POST | `/v1/support/tickets/:id/resolve` | `support.write.ip`, `support.write.user`, `support.write.tenant` |
| GET | `/v1/taxonomy` | `taxonomy.read.ip`, `taxonomy.read.user` |

## feed-api (26 routes)

| Method | Route | Limited by |
|---|---|---|
| GET | `/healthz` | exempt: health probe |
| GET | `/readyz` | exempt: health probe |
| GET | `/v1/properties` | requireApiKey (key tier, agency ceiling, daily quota) |
| GET | `/v1/properties/:id` | requireApiKey (key tier, agency ceiling, daily quota) |
| GET | `/v1/types` | requireApiKey (key tier, agency ceiling, daily quota) |
| OPTIONS | `/v2/*` | `feed.ip` |
| GET | `/v2/calendars/:token/calendar.ics` | `calendar.ics.ip`, `calendar.ics.token` |
| GET | `/v2/changes` | requireApiKey (key tier, agency ceiling, daily quota) |
| GET | `/v2/developments` | requireApiKey (key tier, agency ceiling, daily quota) |
| GET | `/v2/developments/:ref` | requireApiKey (key tier, agency ceiling, daily quota) |
| GET | `/v2/developments/:ref/units` | requireApiKey (key tier, agency ceiling, daily quota) |
| GET | `/v2/feeds/:token/:file` | `feed.xml.ip`, `feed.xml.token` |
| POST | `/v2/leads` | `feed.ip` |
| GET | `/v2/listings` | requireApiKey (key tier, agency ceiling, daily quota) |
| GET | `/v2/listings/:ref` | requireApiKey (key tier, agency ceiling, daily quota) |
| GET | `/v2/plugin/package/:version` | `plugin.package.ip` |
| GET | `/v2/plugin/update` | `plugin.update.ip` |
| GET | `/v2/portal-feeds/:token/:file` | `portal-feed.xml.ip`, `portal-feed.xml.token` |
| GET | `/v2/search/ai` | requireApiKey (key tier, agency ceiling, daily quota) |
| GET | `/v2/sitemap` | requireApiKey (key tier, agency ceiling, daily quota) |
| GET | `/v2/taxonomy/catalog` | requireApiKey (key tier, agency ceiling, daily quota) |
| GET | `/v2/taxonomy/features` | requireApiKey (key tier, agency ceiling, daily quota) |
| GET | `/v2/taxonomy/locations` | requireApiKey (key tier, agency ceiling, daily quota) |
| GET | `/v2/taxonomy/locations/:id/children` | requireApiKey (key tier, agency ceiling, daily quota) |
| GET | `/v2/taxonomy/types` | requireApiKey (key tier, agency ceiling, daily quota) |
| POST | `/v2/viewing-requests` | `feed.ip` |
