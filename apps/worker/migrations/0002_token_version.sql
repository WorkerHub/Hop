-- DO NOT EDIT. Generated from src/lib/migrations.ts (getMigrations("")).
-- Regenerate with: pnpm --filter @hop/worker generate:migrations

ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
