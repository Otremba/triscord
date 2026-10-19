-- Additive only. Apply once to existing databases after 0002_profile.sql.
-- Do not apply ALTER statements again to a database created from schema.sql.
ALTER TABLE accounts ADD COLUMN banner_url TEXT;
ALTER TABLE accounts ADD COLUMN avatar_custom INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS profile_media (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('avatar', 'banner')),
  hash TEXT NOT NULL,
  mime TEXT NOT NULL CHECK(mime IN ('image/png', 'image/jpeg', 'image/gif')),
  size INTEGER NOT NULL CHECK(size > 0 AND size <= 1048576),
  data BLOB NOT NULL CHECK(length(data) = size),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(account_id, kind)
);
