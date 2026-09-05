import assert from "node:assert/strict";
import { existsSync, mkdtempSync, chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WRAPPER = path.join(ROOT, "scripts/psql-safe.mjs");

function fakePsql(source) {
  const dir = mkdtempSync(path.join(tmpdir(), "axel-psql-safe-"));
  const file = path.join(dir, "psql-fake.mjs");
  writeFileSync(file, `#!/usr/bin/env node\n${source}\n`, { mode: 0o700 });
  chmodSync(file, 0o700);
  return file;
}

function runWrapper(options = {}) {
  return spawnSync(process.execPath, [WRAPPER, ...(options.args ?? [])], {
    cwd: ROOT,
    encoding: "utf8",
    input: options.input ?? "",
    env: {
      ...process.env,
      ...(options.env ?? {}),
      DATABASE_URL:
        options.databaseUrl
        ?? "postgresql://runtime:p%40ss-WORD@db.example.test:5432/axel?sslmode=require",
      DATABASE_RUNTIME_URL: "must-not-reach-child",
      DATABASE_MIGRATION_OWNER_PARENT_ROLES: "must-not-reach-child",
      AXEL_NEW_DATABASE_PASSWORD: "must-not-reach-child-either",
      PGDATABASE: "must-not-override-url",
      PGHOST: "must-not-override-host",
      PGHOSTADDR: "192.0.2.1",
      PGOPTIONS: "-c role=must_not_apply",
      PGSERVICE: "must-not-apply",
      PGUSER: "must-not-override-user",
      ...(options.migrationRole === undefined
        ? {}
        : { DATABASE_MIGRATION_ROLE: options.migrationRole }),
      ...(options.requireMigrationRole === undefined
        ? {}
        : { DATABASE_MIGRATION_ROLE_REQUIRED: options.requireMigrationRole }),
      AXEL_PSQL_BIN: options.bin,
    },
  });
}

test("passes a password-free URL in argv and the password only in child env", () => {
  const bin = fakePsql(`
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      process.stdout.write(JSON.stringify({
        argv: process.argv.slice(2),
        passwordLength: process.env.PGPASSWORD?.length ?? 0,
        hasDatabaseUrl: Object.hasOwn(process.env, "DATABASE_URL"),
        hasRuntimeUrl: Object.hasOwn(process.env, "DATABASE_RUNTIME_URL"),
        hasCandidatePassword: Object.hasOwn(process.env, "AXEL_NEW_DATABASE_PASSWORD"),
        hasPgDatabase: Object.hasOwn(process.env, "PGDATABASE"),
        hasPgHost: Object.hasOwn(process.env, "PGHOST"),
        hasPgHostAddr: Object.hasOwn(process.env, "PGHOSTADDR"),
        hasPgOptions: Object.hasOwn(process.env, "PGOPTIONS"),
        hasPgService: Object.hasOwn(process.env, "PGSERVICE"),
        hasPgUser: Object.hasOwn(process.env, "PGUSER"),
        pgConnectTimeout: process.env.PGCONNECT_TIMEOUT,
        hasMigrationRole: Object.hasOwn(process.env, "DATABASE_MIGRATION_ROLE"),
        hasMigrationOwnerParentRoles: Object.hasOwn(
          process.env,
          "DATABASE_MIGRATION_OWNER_PARENT_ROLES",
        ),
        input,
      }));
    });
  `);
  const result = runWrapper({ bin, args: ["-At", "-c", "SELECT 1"], input: "stdin-ok" });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /p@ss-WORD|p%40ss-WORD/i);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed.argv, [
    "-X",
    "-w",
    "-v",
    "VERBOSITY=terse",
    "-v",
    "SHOW_CONTEXT=never",
    "[REDACTED_DSN]",
    "-At",
    "-c",
    "SELECT 1",
  ]);
  assert.equal(parsed.passwordLength, "p@ss-WORD".length);
  assert.equal(parsed.hasDatabaseUrl, false);
  assert.equal(parsed.hasRuntimeUrl, false);
  assert.equal(parsed.hasCandidatePassword, false);
  assert.equal(parsed.hasPgDatabase, false);
  assert.equal(parsed.hasPgHost, false);
  assert.equal(parsed.hasPgHostAddr, false);
  assert.equal(parsed.hasPgOptions, false);
  assert.equal(parsed.hasPgService, false);
  assert.equal(parsed.hasPgUser, false);
  assert.equal(parsed.pgConnectTimeout, "10");
  assert.equal(parsed.hasMigrationRole, false);
  assert.equal(parsed.hasMigrationOwnerParentRoles, false);
  assert.equal(parsed.input, "stdin-ok");
});

test("verified TLS uses trusted roots and removes the temporary certificate bundle", () => {
  const bin = fakePsql(`
    import { readFileSync } from "node:fs";
    import { X509Certificate } from "node:crypto";
    const bundle = readFileSync(process.env.PGSSLROOTCERT, "utf8");
    const certificates = bundle.match(/-----BEGIN CERTIFICATE-----[\\s\\S]*?-----END CERTIFICATE-----/g);
    for (const certificate of certificates) new X509Certificate(certificate);
    process.stdout.write(JSON.stringify({ path: process.env.PGSSLROOTCERT, count: certificates.length }));
  `);
  const result = runWrapper({ bin, databaseUrl: "postgres://runtime:password@db.example.test/axel?sslmode=verify-full", env: { PGSSLROOTCERT: "" } });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.count > 0);
  assert.equal(existsSync(parsed.path), false);
});

test("explicit certificate roots and unverified local connections are preserved", () => {
  const bin = fakePsql(`process.stdout.write(JSON.stringify(process.env.PGSSLROOTCERT ?? null));`);
  for (const [ssl, root, expected] of [
    ["sslmode=verify-full", "/private/organization-ca.pem", "/private/organization-ca.pem"],
    ["sslmode=verify-full&sslrootcert=/private/url-ca.pem", "", ""],
    ["sslmode=disable", "", ""],
  ]) {
    const result = runWrapper({ bin, databaseUrl: `postgres://runtime:password@db.example.test/axel?${ssl}`, env: { PGSSLROOTCERT: root } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout), expected);
  }
});

test("Render SCRAM uses verified TLS without overriding explicit channel binding", () => {
  const bin = fakePsql(`process.stdout.write(JSON.stringify(process.env.PGCHANNELBINDING ?? null));`);
  for (const [mode, query, explicit, expected] of [
    ["render", "sslmode=verify-full", "", "disable"],
    ["render", "sslmode=verify-full", "require", "require"],
    ["render", "sslmode=verify-full&channel_binding=require", "", ""],
    ["render", "sslmode=require", "", ""],
    ["strict", "sslmode=verify-full", "", ""],
  ]) {
    const result = runWrapper({ bin, databaseUrl: `postgres://runtime:password@db.example.test/axel?${query}`,
      env: { DATABASE_ACCESS_MODE: mode, PGCHANNELBINDING: explicit } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout), expected);
  }
});

test("collapses command failures without forwarding query output or detail", () => {
  const bin = fakePsql(`
    const password = process.env.PGPASSWORD ?? "";
    process.stdout.write("decoded=" + password + " encoded=" + encodeURIComponent(password));
    process.stderr.write(" stderr=" + password.toUpperCase());
    process.exit(7);
  `);
  const result = runWrapper({ bin });

  assert.equal(result.status, 7);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /p@ss-WORD|p%40ss-WORD/i);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "psql_safe_command_failed\n");
});

test("rejects secret-bearing and identity-overriding URL parameters before spawning psql", () => {
  const bin = fakePsql(`process.stdout.write("child-ran");`);
  for (const parameter of [
    "password=hidden",
    "passfile=%2Ftmp%2Fpgpass",
    "sslpassword=hidden",
    "host=redirect.example.test",
    "service=redirect",
    "options=-c%20role%3Dredirect",
  ]) {
    const result = runWrapper({
      bin,
      databaseUrl: `postgresql://runtime@db.example.test/axel?${parameter}`,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "psql_safe_forbidden_password_parameter\n");
  }
});

test("pins migration sessions to a validated stable owner role", () => {
  const bin = fakePsql(`
    const databaseUrl = process.argv.find((argument) => argument.startsWith("postgres"));
    const startupOptions = new URL(databaseUrl).searchParams.get("options");
    process.stdout.write(JSON.stringify({
      argv: process.argv.slice(2),
      rolePinned: startupOptions?.includes("-crole=axel_owner") ?? false,
      searchPathPinned: startupOptions?.includes("-csearch_path=public") ?? false,
      hasMigrationRole: Object.hasOwn(process.env, "DATABASE_MIGRATION_ROLE"),
      hasMigrationRequirement: Object.hasOwn(process.env, "DATABASE_MIGRATION_ROLE_REQUIRED"),
    }));
  `);
  const result = runWrapper({
    bin,
    args: ["-At", "-c", "SELECT current_user"],
    migrationRole: "axel_owner",
    requireMigrationRole: "1",
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed.argv, [
    "-X",
    "-w",
    "-v",
    "VERBOSITY=terse",
    "-v",
    "SHOW_CONTEXT=never",
    "[REDACTED_DSN]",
    "-At",
    "-c",
    "SELECT current_user",
  ]);
  assert.equal(parsed.rolePinned, true);
  assert.equal(parsed.searchPathPinned, true);
  assert.equal(parsed.hasMigrationRole, false);
  assert.equal(parsed.hasMigrationRequirement, false);
});

test("requires an explicit URL password instead of libpq credential fallbacks", () => {
  const bin = fakePsql(`process.stdout.write("child-ran");`);
  const result = runWrapper({
    bin,
    databaseUrl: "postgresql://runtime@db.example.test/axel?sslmode=require",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "psql_safe_database_password_required\n");
});

test("rejects control characters before constructing the child environment", () => {
  const token = "nul-secret-must-not-appear";
  const bin = fakePsql(`process.stdout.write("child-ran");`);
  const result = runWrapper({
    bin,
    databaseUrl:
      `postgresql://runtime:${token}%00suffix@db.example.test/axel?sslmode=require`,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "psql_safe_invalid_database_password\n");
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(token, "i"));
});

test("fails closed when a required migration owner is missing or unsafe", () => {
  const bin = fakePsql(`process.stdout.write("child-ran");`);
  const missing = runWrapper({ bin, requireMigrationRole: "1" });
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, "");
  assert.equal(missing.stderr, "psql_safe_migration_role_required\n");

  const unsafe = runWrapper({
    bin,
    migrationRole: "owner; RESET ROLE",
    requireMigrationRole: "1",
  });
  assert.equal(unsafe.status, 1);
  assert.equal(unsafe.stdout, "");
  assert.equal(unsafe.stderr, "psql_safe_invalid_migration_role\n");
});

test("rejects URL fragments and caller-supplied connection overrides", () => {
  const bin = fakePsql(`process.stdout.write("child-ran");`);
  const fragment = runWrapper({
    bin,
    databaseUrl: "postgresql://runtime:password@db.example.test/axel#secret-fragment",
  });
  assert.equal(fragment.status, 1);
  assert.equal(fragment.stdout, "");
  assert.equal(fragment.stderr, "psql_safe_forbidden_url_fragment\n");

  for (const args of [
    ["-d", "postgresql://other:secret@redirect.example.test/db"],
    ["--dbname=redirect"],
    ["--dbna=postgresql://other:secret@redirect.example.test/db"],
    ["-hredirect.example.test"],
    ["--host", "redirect.example.test"],
    ["--ho=redirect.example.test"],
    ["-Uother"],
    ["--usern=other"],
    ["unexpected-positional"],
    ["--"],
  ]) {
    const result = runWrapper({ bin, args });
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.equal(result.stdout, "", JSON.stringify(args));
    assert.equal(result.stderr, "psql_safe_forbidden_connection_override\n", JSON.stringify(args));
  }
});

test("rejects a database password copied into an otherwise safe argument", () => {
  const bin = fakePsql(`process.stdout.write("child-ran");`);
  const result = runWrapper({ bin, args: ["-v", "candidate=p@Ss-wOrD"] });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "psql_safe_secret_in_argument\n");
});

test("rejects attempts to restore verbose psql error detail", () => {
  const bin = fakePsql(`process.stdout.write("child-ran");`);
  for (const args of [
    ["-v", "VERBOSITY=verbose"],
    ["--set", "show_context=always"],
    ["-c", "\\set VERBOSITY verbose"],
  ]) {
    const result = runWrapper({ bin, args });
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.equal(result.stdout, "", JSON.stringify(args));
    assert.equal(result.stderr, "psql_safe_protected_variable_override\n", JSON.stringify(args));
  }
});

test("uses fixed error codes for missing, malformed, and unavailable psql inputs", () => {
  const missing = spawnSync(process.execPath, [WRAPPER], {
    cwd: ROOT,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.equal(missing.status, 1);
  assert.equal(missing.stderr, "psql_safe_database_url_required\n");

  const malformed = runWrapper({
    bin: "/path/that/does/not/exist",
    databaseUrl: "not-a-postgres-url",
  });
  assert.equal(malformed.status, 1);
  assert.equal(malformed.stderr, "psql_safe_invalid_database_url\n");

  const unavailable = runWrapper({ bin: "/path/that/does/not/exist" });
  assert.equal(unavailable.status, 1);
  assert.equal(unavailable.stderr, "psql_safe_spawn_failed\n");
});

test("collapses connection failures without emitting database authority metadata", () => {
  const bin = fakePsql(`
    process.stderr.write(
      'psql: error: connection to server at "db.example.test" (192.0.2.10), port 5432 failed: FATAL: password authentication failed for user "runtime"\\n'
    );
    process.exit(2);
  `);
  const result = runWrapper({ bin });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "psql_safe_connection_failed\n");
  assert.doesNotMatch(result.stderr, /runtime|db\.example|192\.0\.2\.10|postgres/i);
});

test("pins the child locale before classifying connection failures", () => {
  const bin = fakePsql(`
    const localeIsSafe =
      process.env.LANG === "C"
      && process.env.LC_ALL === "C"
      && process.env.LC_MESSAGES === "C"
      && !Object.hasOwn(process.env, "LANGUAGE");
    if (localeIsSafe) {
      process.stderr.write(
        'psql: error: connection to server at "db.example.test" failed for user "runtime"\\n'
      );
    } else {
      process.stderr.write(
        'localized connection failure exposed db.example.test and runtime\\n'
      );
    }
    process.exit(2);
  `);
  const result = runWrapper({
    bin,
    env: {
      LANG: "hostile_LANG",
      LANGUAGE: "hostile_LANGUAGE",
      LC_ALL: "hostile_LC_ALL",
      LC_MESSAGES: "hostile_LC_MESSAGES",
    },
  });

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "psql_safe_connection_failed\n");
  assert.doesNotMatch(result.stderr, /runtime|db\.example|localized/i);
});
