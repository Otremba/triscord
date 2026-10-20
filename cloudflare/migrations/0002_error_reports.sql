-- Additive migration: error reports sent by the desktop app (20/10). The log
-- text itself lives in the LOGS R2 bucket under reports/<id>.log; this table
-- is the index the admin page lists and the per-account rate limit counts.
-- Rows and objects older than 14 days are deleted by the Worker itself
-- (cloudflare/src/error_reports.js), so no bucket lifecycle rule is needed.
-- Apply with: wrangler d1 execute triscord-accounts --remote --file migrations/0002_error_reports.sql
-- Idempotent, like 0001_servers.sql.

CREATE TABLE IF NOT EXISTS error_reports (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  nick TEXT NOT NULL,
  version TEXT NOT NULL,
  signals TEXT NOT NULL,
  reason TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS error_reports_account ON error_reports(account_id, created_at);
CREATE INDEX IF NOT EXISTS error_reports_created ON error_reports(created_at);
