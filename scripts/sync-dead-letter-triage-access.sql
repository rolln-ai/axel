-- Run separately from application migrations using the reviewed migration owner.
-- This is a capability grant, never a credential or role-membership change.
BEGIN;
SELECT format('SET LOCAL ROLE %I', :'owner_role') \gexec
-- Upgrade existing installations without assuming capability-role names.
-- The delivery-workers profile is the only one that deletes both audit_log and
-- dead_letters. Dead-letter triage (migration 0078) needs it to update
-- dead_letters and to read dead_letter_mutes. Fresh installations receive the
-- same privileges from the service profiles.
DO $triage_grants$
DECLARE workers_grantee record;
BEGIN
  FOR workers_grantee IN
    SELECT r.rolname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) a
    JOIN pg_roles r ON r.oid = a.grantee
    WHERE n.nspname = 'public' AND c.relname IN ('audit_log', 'dead_letters')
      AND a.grantee <> c.relowner AND a.privilege_type = 'DELETE'
    GROUP BY r.rolname HAVING count(DISTINCT c.relname) = 2
  LOOP
    EXECUTE format('GRANT UPDATE ON TABLE public.dead_letters TO %I', workers_grantee.rolname);
    EXECUTE format('GRANT SELECT ON TABLE public.dead_letter_mutes TO %I', workers_grantee.rolname);
  END LOOP;
END
$triage_grants$;

COMMIT;
