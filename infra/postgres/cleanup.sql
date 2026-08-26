-- Periodic cleanup helpers.
--
-- Two paths exist for running these:
-- 1. The router service calls `runCleanupPass` (apps/router/src/cleanup.ts)
--    on a 5-minute loop. This is the default and requires no DB cron.
-- 2. An operator can run these statements directly via psql or pg_cron if
--    the router cleanup loop is unavailable.
--
-- All statements are idempotent and bounded to a 5,000-row batch so a single
-- run never holds locks for more than a few seconds at modest scale.

-- Idempotency rows expire 14 days after the delivery completes. After that
-- they're not used by the delivery worker; keeping them only consumes disk.
DELETE FROM delivery_idempotency
 WHERE ctid IN (
   SELECT ctid FROM delivery_idempotency
    WHERE expires_at < now()
    LIMIT 5000
 );

-- Expired user sessions are still in the cookie cache for the user's browser
-- but are no longer accepted by the dashboard.
DELETE FROM user_sessions
 WHERE ctid IN (
   SELECT ctid FROM user_sessions
    WHERE expires_at < now()
    LIMIT 5000
 );

-- Workspace invites that were never accepted and have expired add no value;
-- accepted invites are kept for audit purposes regardless of expiry.
DELETE FROM workspace_invites
 WHERE ctid IN (
   SELECT ctid FROM workspace_invites
    WHERE expires_at < now()
      AND accepted_at IS NULL
    LIMIT 5000
 );

-- Old replay requests in `done` or `failed` state past 30 days are operational
-- noise; the audit_log keeps a permanent record of who requested the replay.
DELETE FROM replay_requests
 WHERE ctid IN (
   SELECT ctid FROM replay_requests
    WHERE state IN ('done', 'failed')
      AND finished_at < now() - INTERVAL '30 days'
    LIMIT 5000
 );
