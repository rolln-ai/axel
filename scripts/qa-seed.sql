-- QA-bot seed data — exercise the Axel Postgres-source pipeline against the
-- Railway sandbox Postgres in QA_PG_DSN (see .env.example).
--
-- Run with:
--   psql "$QA_PG_DSN" -f scripts/qa-seed.sql
--
-- Idempotent: drops and recreates qa_bot_events. Five seed rows give the
-- pull-worker something to keyset-scan with `id` as the cursor column.

DROP TABLE IF EXISTS qa_bot_events;

CREATE TABLE qa_bot_events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  user_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX qa_bot_events_created_at_idx ON qa_bot_events (created_at);

INSERT INTO qa_bot_events (event_type, user_id, payload) VALUES
  ('signup',   'u_alice', '{"email": "alice@example.com", "plan": "free"}'::jsonb),
  ('signup',   'u_bob',   '{"email": "bob@example.com",   "plan": "pro"}'::jsonb),
  ('login',    'u_alice', '{"ip": "192.0.2.1", "ua": "axel-qa/1.0"}'::jsonb),
  ('purchase', 'u_alice', '{"amount": 12.5,  "sku": "sku_1"}'::jsonb),
  ('purchase', 'u_bob',   '{"amount": 199.0, "sku": "sku_42"}'::jsonb);

SELECT count(*) AS rows_seeded FROM qa_bot_events;
