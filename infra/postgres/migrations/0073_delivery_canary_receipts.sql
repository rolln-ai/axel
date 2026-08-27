-- Synthetic receipts for the production end-to-end delivery canary. The
-- native Postgres connector inserts only `payload`; the dashboard extracts the
-- probe identifier through an authenticated operator endpoint.

CREATE TABLE IF NOT EXISTS delivery_canary_receipts (
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_canary_receipts_shape_check CHECK (
    COALESCE(
      jsonb_typeof(payload) = 'object'
      AND payload ?& ARRAY[
        'event_type',
        'axel_canary_probe_id',
        'sent_at',
        'expected_runtime'
      ]::text[]
      AND payload - ARRAY[
        'event_type',
        'axel_canary_probe_id',
        'sent_at',
        'expected_runtime'
      ]::text[] = '{}'::jsonb
      AND payload ->> 'event_type' = 'axel.delivery_canary'
      AND payload ->> 'expected_runtime' = 'native'
      AND payload ->> 'axel_canary_probe_id'
        ~ '^axel_canary_[0-9]{10,16}_[0-9a-f]{12}$'
      AND payload ->> 'sent_at'
        ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$',
      false
    )
  ),
  CONSTRAINT delivery_canary_receipts_size_check CHECK (
    pg_column_size(payload) <= 1024
  )
);

CREATE INDEX IF NOT EXISTS delivery_canary_receipts_probe_time_idx
  ON delivery_canary_receipts (
    (payload ->> 'axel_canary_probe_id'),
    received_at DESC
  );

REVOKE ALL PRIVILEGES ON TABLE delivery_canary_receipts FROM PUBLIC;

COMMENT ON TABLE delivery_canary_receipts IS
  'Short-lived synthetic delivery-canary receipts. The shape and size checks prevent this table from accepting customer webhook payloads.';
