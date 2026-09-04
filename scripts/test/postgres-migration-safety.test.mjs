import assert from "node:assert/strict";
import test from "node:test";
import {
  migrationTransactionMode,
  unsafeMigrationSessionControl,
} from "../postgres-migration-safety.mjs";

test("rejects migration commands that can escape the stable owner session", () => {
  for (const sql of [
    "RESET ROLE;",
    "RESET SESSION AUTHORIZATION;",
    "RESET ALL;",
    "DISCARD ALL;",
    "SET LOCAL ROLE another_owner;",
    "SET SESSION AUTHORIZATION another_login;",
    "SET search_path TO attacker, public;",
    "SET LOCAL SCHEMA 'attacker';",
    "SELECT set_config('search_path', 'attacker', false);",
    "SELECT set_config('role', 'another_owner', false);",
    "SELECT set_config($name$search_path$name$, 'attacker', false);",
    "ALTER TABLE public.events OWNER TO another_owner;",
    "ALTER TABLE public.events OWNER/* split */TO another_owner;",
    "SET/* split */ROLE another_owner;",
    'SET "role" TO another_owner;',
    'SET "search_path" TO attacker, public;',
    'SELECT pg_catalog."set_config"(\'role\', \'another_owner\', false);',
    'SELECT pg_catalog.U&"set\\005fconfig"(\'role\', \'another_owner\', false);',
    'SELECT U&"set!005fconfig" UESCAPE \'!\'(\'role\', \'another_owner\', false);',
    "REASSIGN/* split */OWNED BY current_user TO another_owner;",
    "DO $$ BEGIN EXECUTE 'SET ' || 'ROLE another_owner'; END $$;",
    "DO $$ BEGIN EXECUTE 'SE' || 'T ROLE another_owner'; END $$;",
    "DO $$ DECLARE \"function\" text := 'GRANT SELECT ON public.events TO PUBLIC'; BEGIN EXECUTE \"function\"; END $$;",
    "DO $$ BEGIN EXECUTE format('ALTER TABLE example DROP CONSTRAINT %I', 'x') || '; SET search_path TO pg_catalog'; END $$;",
    "DO E'BEGIN PERFORM set_config(\\'role\\', \\'another_owner\\', false); END';",
    "DO U&'BEGIN PERFORM set_config(\\0072ole, another_owner, false); END';",
    "CREATE SCHEMA isolated AUTHORIZATION another_owner;",
    "CREATE DATABASE other OWNER = another_owner;",
    "CREATE ROLE webhook_reader LOGIN;",
    'CREATE "ROLE" webhook_reader LOGIN;',
    "CREATE USER webhook_reader;",
    "ALTER ROLE current_user SUPERUSER;",
    "ALTER GROUP axel_owner ADD USER retired_migrator;",
    "CREATE GROUP webhook_readers;",
    "DROP GROUP webhook_readers;",
    "DROP OWNED BY current_user;",
    "DROP ROLE axel_runtime;",
    "GRANT SELECT ON ALL TABLES IN SCHEMA public TO PUBLIC;",
    "ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC;",
    "REVOKE axel_runtime FROM current_user;",
    "CREATE FUNCTION leak() RETURNS void LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';",
    "CREATE EXTENSION postgres_fdw;",
    "ALTER EXTENSION vector UPDATE;",
    "DROP EXTENSION vector CASCADE;",
    "\\c another_database",
    "  \\connect another_database",
    "\\include unreviewed.sql",
  ]) {
    assert.equal(unsafeMigrationSessionControl(sql), true, sql);
  }
});

test("classifies migrations that cannot use the atomic wrapper", () => {
  assert.equal(
    migrationTransactionMode("BEGIN; ALTER TABLE example ADD COLUMN value text; COMMIT;"),
    "explicit_transaction",
  );
  assert.equal(
    migrationTransactionMode("CREATE INDEX CONCURRENTLY example_idx ON example (id);"),
    "concurrent_index",
  );
  assert.equal(
    migrationTransactionMode("CREATE UNIQUE INDEX CONCURRENTLY example_idx ON example (id);"),
    "concurrent_index",
  );
  assert.equal(
    migrationTransactionMode("DO $$ BEGIN PERFORM 1; END $$; ALTER TABLE example ADD value text;"),
    "atomic",
  );
  assert.equal(
    migrationTransactionMode('SELECT U&"set\\005fconfig";'),
    "invalid",
  );
});

test("accepts ordinary schema and migration statements", () => {
  assert.equal(
    unsafeMigrationSessionControl(`
      CREATE TABLE IF NOT EXISTS public.example (id bigint PRIMARY KEY);
      ALTER TABLE public.example ADD COLUMN IF NOT EXISTS value text;
      CREATE TRIGGER example_guard BEFORE INSERT ON public.example
        FOR EACH ROW EXECUTE FUNCTION public.example_guard();
    `),
    false,
  );
  assert.equal(
    unsafeMigrationSessionControl(`
      -- SET ROLE mentioned in a comment is inert.
      SELECT 'OWNER TO and set_config are inert string content';
      DO $$
      BEGIN
        EXECUTE format('ALTER TABLE example DROP CONSTRAINT %I', 'old_check');
      END
      $$;
    `),
    false,
  );
  assert.equal(
    unsafeMigrationSessionControl(`
      REVOKE ALL PRIVILEGES ON TABLE delivery_canary_receipts FROM PUBLIC;
      REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC;
      REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
      REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public FROM PUBLIC;
      CREATE OR REPLACE FUNCTION public.axel_minimize_billing_event_payload()
      RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
      BEGIN
        NEW.payload := '{}'::pg_catalog.jsonb;
        RETURN NEW;
      END;
      $$;
      REVOKE EXECUTE ON FUNCTION public.axel_minimize_billing_event_payload()
        FROM PUBLIC;
      ALTER DEFAULT PRIVILEGES
        REVOKE EXECUTE ON ROUTINES FROM PUBLIC;
    `),
    false,
  );
});
