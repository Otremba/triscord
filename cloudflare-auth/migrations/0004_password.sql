-- Additive migration: sign-in with a nick and an optional password, besides Google (18/10/2026).
-- An account created by nick has id 'n_<random hex>' and an empty email. password_hash is
-- 'pbkdf2-sha256$<iterations>$<salt hex>$<hash hex>', NULL until the user sets one. failed_logins and
-- locked_until throttle password guessing per account.
-- Same idempotency note as 0002_profile.sql: scripts/migrate.mjs skips columns that already exist.

ALTER TABLE accounts ADD COLUMN password_hash TEXT;
ALTER TABLE accounts ADD COLUMN failed_logins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN locked_until INTEGER;
