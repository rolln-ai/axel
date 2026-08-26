-- Bind every personal access token to a live workspace membership.
--
-- 0011 documented that removing a member revoked their CLI access, but the
-- original table only referenced users and workspaces independently. Delete
-- existing orphaned credentials before enforcing that invariant in Postgres.

DELETE FROM personal_access_tokens pat
 WHERE NOT EXISTS (
   SELECT 1
     FROM workspace_members wm
    WHERE wm.workspace_id = pat.workspace_id
      AND wm.user_id = pat.user_id
 );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'personal_access_tokens_membership_fkey'
       AND conrelid = 'personal_access_tokens'::regclass
  ) THEN
    ALTER TABLE personal_access_tokens
      ADD CONSTRAINT personal_access_tokens_membership_fkey
      FOREIGN KEY (workspace_id, user_id)
      REFERENCES workspace_members(workspace_id, user_id)
      ON DELETE CASCADE;
  END IF;
END
$$;
