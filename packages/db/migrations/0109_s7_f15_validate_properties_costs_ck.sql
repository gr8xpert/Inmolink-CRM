-- Validates the check S7-F14 added NOT VALID: the scan takes SHARE UPDATE EXCLUSIVE, which blocks neither reads nor writes.
ALTER TABLE "properties" VALIDATE CONSTRAINT "properties_costs_ck";
