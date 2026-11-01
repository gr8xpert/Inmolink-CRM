# Alert index (S16-05)

Every Prometheus alert (`infra/monitoring/rules/*.yml`), its severity, how long the condition must hold, and the runbook
section its `runbook` annotation links to (notifications carry the full `runbook_url`). Routing, severities and
inhibitions: [observability.md](observability.md#alert-routing). `tests/workspace/monitoring.test.ts` fails when an
alert is missing here, has no runbook heading, never fires in its promtool test, or has no staged trigger
(`pnpm ops:alerts list`).

| Alert | Severity | For | Rules | Runbook |
|---|---|---|---|---|
| `AiProviderFailing` | warning | 5m | `ai.yml` | [ai-outage.md#ai-provider-failing](ai-outage.md#ai-provider-failing) |
| `AiProviderRejecting` | critical | 5m | `ai.yml` | [ai-outage.md#ai-provider-rejecting](ai-outage.md#ai-provider-rejecting) |
| `AiUsageRecordFailing` | warning | at once | `ai.yml` | [ai-outage.md#ai-usage-records-failing](ai-outage.md#ai-usage-records-failing) |
| `EndpointDown` | critical | 2m | `endpoints.yml` | [observability.md#endpoint-down](observability.md#endpoint-down) |
| `EndpointProbesMissing` | critical | 10m | `endpoints.yml` | [observability.md#endpoint-down](observability.md#endpoint-down) |
| `CertificateExpiringSoon` | warning | 1h | `endpoints.yml` | [observability.md#certificate-expiry](observability.md#certificate-expiry) |
| `CertificateExpiryCritical` | critical | 10m | `endpoints.yml` | [observability.md#certificate-expiry](observability.md#certificate-expiry) |
| `ImportFeedPaused` | warning | at once | `imports.yml` | [queues.md#a-feed-was-paused-importfeedpaused-s6-08](queues.md#a-feed-was-paused-importfeedpaused-s6-08) |
| `ImportQueueWaitHigh` | warning | 5m | `imports.yml` | [queues.md#feed-imports-wait-in-the-queue-importqueuewaithigh-s6-08](queues.md#feed-imports-wait-in-the-queue-importqueuewaithigh-s6-08) |
| `NodeDown` | critical | 2m | `node.yml` | [observability.md#node-down](observability.md#node-down) |
| `DiskUsageHigh` | critical | 15m | `node.yml` | [observability.md#disk-usage](observability.md#disk-usage) |
| `Watchdog` | none | at once | `postgres.yml` | [observability.md#watchdog-heartbeat](observability.md#watchdog-heartbeat) |
| `PostgresReplicaLagHigh` | critical | 30s | `postgres.yml` | [failover.md#replica-lag](failover.md#replica-lag) |
| `PostgresReplicaBehindBytes` | critical | 2m | `postgres.yml` | [failover.md#replica-lag](failover.md#replica-lag) |
| `PostgresReplicaNotStreaming` | critical | 2m | `postgres.yml` | [failover.md#replica-not-streaming](failover.md#replica-not-streaming) |
| `PostgresSlotRetainingWal` | critical | 5m | `postgres.yml` | [failover.md#replica-not-streaming](failover.md#replica-not-streaming) |
| `PostgresDown` | critical | 1m | `postgres.yml` | [failover.md](failover.md) |
| `WalArchivingFailing` | critical | at once | `postgres.yml` | [pitr-restore.md#archiving-failing](pitr-restore.md#archiving-failing) |
| `WalArchivingStale` | warning | 5m | `postgres.yml` | [pitr-restore.md#archiving-failing](pitr-restore.md#archiving-failing) |
| `BaseBackupMissing` | critical | at once | `postgres.yml` | [pitr-restore.md#base-backup-missing](pitr-restore.md#base-backup-missing) |
| `BaseBackupNeverReported` | critical | 26h | `postgres.yml` | [pitr-restore.md#base-backup-missing](pitr-restore.md#base-backup-missing) |
| `DeliveryQueueAgeHigh` | warning | 5m | `queues.yml` | [queues.md#jobs-pile-up-queue-age-alert](queues.md#jobs-pile-up-queue-age-alert) |
| `QueueAgeHigh` | warning | 15m | `queues.yml` | [queues.md#jobs-pile-up-queue-age-alert](queues.md#jobs-pile-up-queue-age-alert) |
| `RedisMemoryHigh` | warning | 10m | `redis.yml` | [website-api.md#redis-memory](website-api.md#redis-memory) |
| `RedisMemoryCritical` | critical | 2m | `redis.yml` | [website-api.md#redis-memory](website-api.md#redis-memory) |
| `RedisExporterDown` | critical | 5m | `redis.yml` | [website-api.md#redis-memory](website-api.md#redis-memory) |
| `SearchFallbackActive` | warning | 2m | `search.yml` | [search.md#fallback-active](search.md#fallback-active) |
| `SearchFallbackShareHigh` | warning | 10m | `search.yml` | [search.md#fallback-active](search.md#fallback-active) |
| `SearchBreakerFlapping` | warning | 5m | `search.yml` | [search.md#fallback-active](search.md#fallback-active) |
| `WebsiteChangesHeld` | warning | 5m | `search.yml` | [search.md#website-changes-held](search.md#website-changes-held) |
| `HmacRotationRehashPending` | critical | at once | `security.yml` | [hmac-key-rotation.md#rotation-steps](hmac-key-rotation.md#rotation-steps) |
| `SloErrorBudgetBurnFast` | critical | 2m | `slo.yml` | [observability.md#slo-error-budget-burn](observability.md#slo-error-budget-burn) |
| `SloErrorBudgetBurnSlow` | warning | 15m | `slo.yml` | [observability.md#slo-error-budget-burn](observability.md#slo-error-budget-burn) |
| `AppMetricsDown` | critical | 10m | `slo.yml` | [observability.md#app-metrics-down](observability.md#app-metrics-down) |
| `AppMetricsScraperDown` | warning | 5m | `slo.yml` | [observability.md#app-metrics-scraper-down](observability.md#app-metrics-scraper-down) |
| `WebsiteScrapingDetected` | warning | at once | `website.yml` | [website-api.md#scraping-detected](website-api.md#scraping-detected) |
| `WebsiteHoneytokenHit` | warning | at once | `website.yml` | [website-api.md#honeytoken-hit](website-api.md#honeytoken-hit) |
| `WebsiteEdgePurgeFailing` | warning | at once | `website.yml` | [cdn.md#purge-failing](cdn.md#purge-failing) |
| `RateLimitFailing` | critical | 5m | `website.yml` | [website-api.md#rate-limits-failing](website-api.md#rate-limits-failing) |
