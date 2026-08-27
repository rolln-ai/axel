-- Record malformed delivery-queue envelopes without copying webhook payloads.
-- The original message remains in Cloudflare Queues and follows the queue's
-- bounded retry and dead-letter policy. This table gives operators a durable,
-- privacy-safe signal even if a DLQ item expires before investigation.

CREATE TABLE IF NOT EXISTS queue_quarantine (
  id bigserial PRIMARY KEY,
  queue_name text NOT NULL,
  cloudflare_message_id text NOT NULL,
  failure_code text NOT NULL,
  failure_field text,
  contract_version integer,
  attempts integer NOT NULL CHECK (attempts >= 1),
  content_type text,
  published_at timestamptz,
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  body_size_bytes integer NOT NULL CHECK (body_size_bytes >= 0),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  seen_count integer NOT NULL DEFAULT 1 CHECK (seen_count >= 1),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days',
  UNIQUE (queue_name, cloudflare_message_id)
);

CREATE INDEX IF NOT EXISTS queue_quarantine_last_seen_idx
  ON queue_quarantine (last_seen_at DESC);

CREATE INDEX IF NOT EXISTS queue_quarantine_expires_idx
  ON queue_quarantine (expires_at);

COMMENT ON TABLE queue_quarantine IS
  'Metadata-only audit records for malformed delivery queue messages. Never stores message bodies, headers, query values, credentials, or lease IDs.';
