-- Bind a destination's current credential reference to that exact destination
-- and workspace. Runtime reads also enforce this tuple, but the database must
-- prevent a future write path or manual repair from creating a cross-tenant
-- credential confused-deputy.

-- Existing mismatches are unsafe to retain. A missing/misbound credential must
-- make delivery fail closed until the operator sets it again.
UPDATE destinations d
   SET credentials_ref = NULL,
       updated_at = now()
 WHERE d.credentials_ref IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
       FROM destination_credentials dc
      WHERE dc.id = d.credentials_ref
        AND dc.destination_id = d.id
        AND dc.workspace_id = d.workspace_id
   );

CREATE UNIQUE INDEX IF NOT EXISTS destination_credentials_binding_idx
  ON destination_credentials (id, destination_id, workspace_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'destinations_credentials_binding_fkey'
       AND conrelid = 'destinations'::regclass
  ) THEN
    ALTER TABLE destinations
      ADD CONSTRAINT destinations_credentials_binding_fkey
      FOREIGN KEY (credentials_ref, id, workspace_id)
      REFERENCES destination_credentials(id, destination_id, workspace_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$$;
