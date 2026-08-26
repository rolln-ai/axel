-- Bind a pull source's current credential reference to that exact source and
-- workspace. Without this tuple, a corrupted or future write path can make the
-- pull worker decrypt and use another tenant's API/database credential.

-- Existing mismatches are unsafe to retain. A missing/misbound credential must
-- make the source fail closed until the operator sets it again.
UPDATE pull_sources ps
   SET credentials_ref = NULL,
       updated_at = now()
 WHERE ps.credentials_ref IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
       FROM pull_source_credentials psc
      WHERE psc.id = ps.credentials_ref
        AND psc.pull_source_id = ps.id
        AND psc.workspace_id = ps.workspace_id
   );

CREATE UNIQUE INDEX IF NOT EXISTS pull_source_credentials_binding_idx
  ON pull_source_credentials (id, pull_source_id, workspace_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'pull_sources_credentials_binding_fkey'
       AND conrelid = 'pull_sources'::regclass
  ) THEN
    ALTER TABLE pull_sources
      ADD CONSTRAINT pull_sources_credentials_binding_fkey
      FOREIGN KEY (credentials_ref, id, workspace_id)
      REFERENCES pull_source_credentials(id, pull_source_id, workspace_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$$;
