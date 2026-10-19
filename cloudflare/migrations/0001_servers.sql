-- Additive migration: adds the server (guild) layer to the shared
-- triscord-accounts D1 database. This lives under cloudflare/migrations
-- (the hub worker's own migrations directory) rather than under
-- cloudflare-auth/, even though it is the same physical database, because
-- these tables are owned/read/written by the hub worker, not the auth
-- worker: servers/membership/invites. cloudflare-auth/schema.sql is left
-- untouched.
-- Apply with: wrangler d1 execute triscord-accounts --file migrations/0001_servers.sql
--
-- Uses CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS throughout
-- (unlike cloudflare-auth/migrations/0002_profile.sql's ALTER TABLE ADD
-- COLUMN, which SQLite has no IF NOT EXISTS form for) so this file is
-- idempotent and safe to re-run verbatim.

CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS server_members (
  server_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, account_id)
);

-- Membership lookups also need "which servers is this account in" (GET
-- /servers), the reverse direction from the primary key.
CREATE INDEX IF NOT EXISTS server_members_account ON server_members(account_id);

CREATE TABLE IF NOT EXISTS server_invites (
  code TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  max_uses INTEGER,
  uses INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS server_invites_server ON server_invites(server_id);
