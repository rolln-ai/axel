-- Run separately from application migrations using the reviewed migration owner.
-- This is a capability grant, never a credential or role-membership change.
BEGIN;
SELECT format('SET LOCAL ROLE %I', :'owner_role') \gexec
-- Upgrade existing installations without assuming capability-role names.
-- Only the dashboard profile can insert AND update notification preferences.
-- Fresh installations receive the same privileges from the service profiles.
DO $impact_grants$
DECLARE dashboard_grantee record;
BEGIN
  FOR dashboard_grantee IN
    SELECT r.rolname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) a
    JOIN pg_roles r ON r.oid = a.grantee
    WHERE n.nspname = 'public' AND c.relname = 'notification_preferences'
      AND a.grantee <> c.relowner AND a.privilege_type IN ('INSERT', 'UPDATE')
    GROUP BY r.rolname HAVING count(DISTINCT a.privilege_type) = 2
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.pipeline_incidents, public.alert_email_outbox TO %I', dashboard_grantee.rolname);
  END LOOP;
END
$impact_grants$;

COMMIT;
