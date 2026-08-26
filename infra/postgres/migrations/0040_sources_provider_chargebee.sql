-- Migration 0040: allow 'chargebee' as an inbound webhook provider.
--
-- Chargebee secures webhooks with HTTP Basic Auth; the ingest worker now has a
-- verifier for it (verifyChargebeeBasicAuth in @axel/shared). Previously
-- provider-inference could detect Chargebee but a Chargebee source had no
-- verifier and the provider value couldn't even be stored, so it silently fell
-- back to token-only. Widen the sources.provider CHECK so a Chargebee source
-- can be persisted.
--
-- The original CHECK is an inline column constraint with an auto-generated
-- name, so drop whatever provider-related CHECK exists and re-add a
-- canonically-named one. Idempotent: re-running drops and re-adds it.

DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'sources'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%provider%'
  LOOP
    EXECUTE format('ALTER TABLE sources DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE sources
  ADD CONSTRAINT sources_provider_check
  CHECK (provider IN ('custom', 'stripe', 'github', 'shopify', 'chargebee'));
