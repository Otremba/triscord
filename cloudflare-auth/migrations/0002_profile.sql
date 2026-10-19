-- Additive migration: adds profile columns to an existing `accounts` table.
-- Apply with: wrangler d1 execute triscord-accounts --file migrations/0002_profile.sql
--
-- IMPORTANT: plain SQLite (and D1) does not support
-- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so this file is not idempotent
-- at the SQL-engine level by itself — re-running it verbatim against a
-- database that already has these columns will fail each statement with
-- "duplicate column name". Whatever applies this file (our tests, or a
-- wrangler wrapper) must tolerate that specific error per statement to make
-- re-application safe; it never indicates data loss, since ADD COLUMN only
-- adds a nullable column.
--
-- Never run DROP TABLE / DROP COLUMN here: the production `accounts` table
-- already has real user rows.

ALTER TABLE accounts ADD COLUMN display_name TEXT;
ALTER TABLE accounts ADD COLUMN pronouns TEXT;
ALTER TABLE accounts ADD COLUMN bio TEXT;
ALTER TABLE accounts ADD COLUMN note TEXT;
ALTER TABLE accounts ADD COLUMN banner_color TEXT;
ALTER TABLE accounts ADD COLUMN nameplate TEXT;
ALTER TABLE accounts ADD COLUMN avatar_decoration_url TEXT;
ALTER TABLE accounts ADD COLUMN display_name_style TEXT;
ALTER TABLE accounts ADD COLUMN profile_theme_start TEXT;
ALTER TABLE accounts ADD COLUMN profile_theme_end TEXT;
