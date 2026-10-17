-- BE-S3/S4: per-user token_version — bumping it revokes all of a user's sessions
-- (password change/reset, admin disable/demote). Keep in sync with the `schema_v2`
-- migration embedded in routes/setup.ts.

ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
