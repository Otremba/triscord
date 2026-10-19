-- triscord-auth D1 schema: a single global accounts table plus sessions.
-- Apply with: wrangler d1 execute triscord-accounts --file schema.sql

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,           -- Google sub claim
  email TEXT NOT NULL,
  nick TEXT,
  nick_lower TEXT UNIQUE,
  avatar_url TEXT,
  banner_url TEXT,
  avatar_custom INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Profile fields. See migrations/0002_profile.sql for the additive
  -- migration that brings an existing (pre-profile) database up to this
  -- shape; this CREATE TABLE is only consulted for a brand-new database, so
  -- the two paths must stay in sync.
  display_name TEXT,             -- public, free (Discord: free)
  pronouns TEXT,                 -- public, free (Discord: free)
  bio TEXT,                      -- public, free (Discord: free)
  note TEXT,                     -- PRIVATE, free (Discord: free, "visible only to you")
  banner_color TEXT,             -- public, free, '#rrggbb' (Discord: free, static banner color)
  nameplate TEXT,                -- public, opaque cosmetic identifier (Discord uses a store SKU)
  avatar_decoration_url TEXT,    -- public, HTTPS decoration URL; not a Discord entitlement claim
  -- Nitro-gated in Discord; triscord makes these free for everyone.
  display_name_style TEXT,       -- public, opaque style id for the display name effect
  profile_theme_start TEXT,      -- public, '#rrggbb', profile gradient start
  profile_theme_end TEXT,        -- public, '#rrggbb', profile gradient end

  -- Nick sign-in (migrations/0004_password.sql): PBKDF2 hash, NULL until set; guessing throttle.
  password_hash TEXT,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_account ON sessions(account_id);

-- Kept in sync with migrations/0003_media.sql. Maximum two current assets
-- per account. Replacing or deleting an asset removes its previous bytes.
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
