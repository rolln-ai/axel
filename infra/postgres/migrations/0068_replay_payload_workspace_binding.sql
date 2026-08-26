-- Replay workers hold account-wide raw-payload credentials. Bind every active
-- replay object's key to the workspace stored on the replay row so a buggy or
-- compromised producer cannot use that worker as a cross-tenant read proxy.

-- Preserve historical audit rows, but quarantine any unsafe row that could
-- still be claimed by a worker.
UPDATE replay_requests
   SET state = 'failed',
       finished_at = COALESCE(finished_at, now()),
       error_message = 'replay_payload_workspace_mismatch'
 WHERE state IN ('pending', 'in_progress')
   AND NOT (
     split_part(r2_key, '/', 1) IN ('events', 'pull')
     AND split_part(r2_key, '/', 2) = workspace_id
     AND split_part(r2_key, '/', 3) <> ''
     AND r2_key NOT LIKE '%//%'
     AND r2_key !~ '(^|/)([.]{1,2})(/|$)'
   );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'replay_requests_workspace_r2_key_check'
       AND conrelid = 'replay_requests'::regclass
  ) THEN
    ALTER TABLE replay_requests
      ADD CONSTRAINT replay_requests_workspace_r2_key_check
      CHECK (
        state IN ('done', 'failed')
        OR (
          split_part(r2_key, '/', 1) IN ('events', 'pull')
          AND split_part(r2_key, '/', 2) = workspace_id
          AND split_part(r2_key, '/', 3) <> ''
          AND r2_key NOT LIKE '%//%'
          AND r2_key !~ '(^|/)([.]{1,2})(/|$)'
        )
      ) NOT VALID;
  END IF;
END
$$;

ALTER TABLE replay_requests
  VALIDATE CONSTRAINT replay_requests_workspace_r2_key_check;
