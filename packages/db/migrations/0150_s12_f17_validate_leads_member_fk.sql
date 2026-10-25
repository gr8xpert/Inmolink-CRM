-- S12-F17: the leads member FK (S11-F5, added NOT VALID in 0138 while the shared test database held orphan assignees
-- from the CRM filters perf seed) is validated. VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE: it scans `leads`
-- (index probes into agency_members) without blocking reads or writes. The perf seed now assigns real members and
-- purges a crashed run's rows before it seeds (tests/perf/crm-filters.int.test.ts).
ALTER TABLE "leads" VALIDATE CONSTRAINT "leads_assignee_member_fk";
