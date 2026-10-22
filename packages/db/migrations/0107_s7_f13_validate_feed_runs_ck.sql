-- Validates the check S7-F12 added NOT VALID: the scan takes SHARE UPDATE EXCLUSIVE, which blocks neither reads nor writes.
ALTER TABLE "feed_runs" VALIDATE CONSTRAINT "feed_runs_error_detail_ck";
