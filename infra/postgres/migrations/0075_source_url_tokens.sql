-- Separate, opt-in credential for webhook senders that cannot set headers.
-- Existing sources remain header/provider authenticated. Store only the hash.
ALTER TABLE public.sources
  ADD COLUMN IF NOT EXISTS url_token_hash text
    CONSTRAINT sources_url_token_hash_format
    CHECK (url_token_hash IS NULL OR url_token_hash ~ '^[0-9a-f]{64}$');
