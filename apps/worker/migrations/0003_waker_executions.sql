-- DO NOT EDIT. Generated from src/lib/migrations.ts (getMigrations("")).
-- Regenerate with: pnpm --filter @hop/worker generate:migrations

CREATE TABLE waker_executions (
  execution_id   TEXT PRIMARY KEY,
  job_id         TEXT NOT NULL,
  job_name       TEXT NOT NULL,
  scheduled_for  INTEGER NOT NULL,
  status         TEXT NOT NULL,
  response_json  TEXT,
  claimed_at     INTEGER NOT NULL,
  completed_at   INTEGER
);
