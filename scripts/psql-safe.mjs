#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { getCACertificates } from "node:tls";

const SECRET_ENV_KEYS = [
  "DATABASE_URL",
  "DATABASE_MIGRATION_URL",
  "DATABASE_RUNTIME_URL",
  "DATABASE_VERIFY_URL",
  "DATABASE_MIGRATION_ROLE",
  "DATABASE_MIGRATION_LOGIN_ROLE",
  "DATABASE_MIGRATION_EXISTING_LOGIN_ROLES",
  "DATABASE_MIGRATION_OWNER_PARENT_ROLES",
  "DATABASE_MIGRATION_OWNER_CAN_CREATE_ROLES",
  "DATABASE_MIGRATION_ROLE_REQUIRED",
  "AXEL_NEW_DATABASE_PASSWORD",
];

const LIBPQ_OVERRIDE_ENV_KEYS = [
  "PGAPPNAME",
  "PGCONNECT_TIMEOUT",
  "PGDATABASE",
  "PGHOST",
  "PGHOSTADDR",
  "PGLOADBALANCEHOSTS",
  "PGOPTIONS",
  "PGPASSFILE",
  "PGPORT",
  "PGREQUIREPEER",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGTARGETSESSIONATTRS",
  "PGUSER",
];

const FORBIDDEN_URL_PARAMETERS = new Set([
  "dbname",
  "connect_timeout",
  "host",
  "hostaddr",
  "options",
  "passfile",
  "password",
  "port",
  "service",
  "sslpassword",
  "user",
]);

const SAFE_OPTIONS_WITH_VALUE = new Set([
  "-c",
  "--command",
  "-f",
  "--file",
  "-v",
  "--set",
]);

const SAFE_FLAG_OPTIONS = new Set([
  "--no-align",
  "--quiet",
  "--single-transaction",
  "--tuples-only",
]);

function fail(code) {
  process.stderr.write(`${code}\n`);
  process.exit(1);
}

function parseDatabaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail("psql_safe_invalid_database_url");
  }

  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
    || !url.hostname
    || !url.username
    || url.pathname.length < 2
  ) {
    fail("psql_safe_invalid_database_url");
  }

  if (url.hash) fail("psql_safe_forbidden_url_fragment");

  for (const key of url.searchParams.keys()) {
    const normalized = key.toLowerCase();
    if (FORBIDDEN_URL_PARAMETERS.has(normalized)) {
      fail("psql_safe_forbidden_password_parameter");
    }
  }

  let password;
  try {
    password = decodeURIComponent(url.password);
  } catch {
    fail("psql_safe_invalid_database_url");
  }
  const encodedPassword = url.password;
  if (!encodedPassword || !password) fail("psql_safe_database_password_required");
  if ([...password].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  })) {
    fail("psql_safe_invalid_database_password");
  }
  url.password = "";

  return {
    password,
    encodedPassword,
    url,
  };
}

function migrationRoleFromEnvironment() {
  const required = process.env.DATABASE_MIGRATION_ROLE_REQUIRED;
  if (required !== undefined && required !== "0" && required !== "1") {
    fail("psql_safe_invalid_migration_role_requirement");
  }
  const role = process.env.DATABASE_MIGRATION_ROLE;
  if (!role) {
    if (required === "1") fail("psql_safe_migration_role_required");
    return undefined;
  }
  if (!/^[a-z][a-z0-9_]{2,62}$/.test(role)) {
    fail("psql_safe_invalid_migration_role");
  }
  return role;
}

function redactionTokens(password, encodedPassword) {
  if (!password) return [];
  const tokens = new Set([
    password,
    encodedPassword,
    encodeURIComponent(password),
  ]);
  return [...tokens]
    .filter((token) => token.length > 0)
    .sort((left, right) => right.length - left.length);
}

function redact(value, tokens) {
  let result = value;
  for (const token of tokens) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escaped, "giu"), "[REDACTED]");
  }
  return result.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/giu, "[REDACTED_DSN]");
}

function validatePsqlArgs(args, tokens) {
  let pendingOption;
  for (const arg of args) {
    if (typeof arg !== "string") fail("psql_safe_forbidden_connection_override");
    if (/postgres(?:ql)?:\/\//iu.test(arg)) fail("psql_safe_forbidden_connection_override");
    if (tokens.some((token) => token && arg.toLowerCase().includes(token.toLowerCase()))) {
      fail("psql_safe_secret_in_argument");
    }
    if (pendingOption) {
      if (["-v", "--set"].includes(pendingOption)) {
        const variable = arg.slice(0, arg.indexOf("=") === -1 ? undefined : arg.indexOf("="));
        if (["verbosity", "show_context"].includes(variable.toLowerCase())) {
          fail("psql_safe_protected_variable_override");
        }
      }
      if (
        ["-c", "--command"].includes(pendingOption)
        && /\\set\s+(?:VERBOSITY|SHOW_CONTEXT)\b/iu.test(arg)
      ) {
        fail("psql_safe_protected_variable_override");
      }
      pendingOption = undefined;
      continue;
    }
    if (SAFE_OPTIONS_WITH_VALUE.has(arg)) {
      pendingOption = arg;
      continue;
    }
    if (SAFE_FLAG_OPTIONS.has(arg) || /^-[Atq1]+$/.test(arg)) continue;
    // psql accepts unique abbreviations for long options (for example,
    // --dbna for --dbname), so a denylist of exact connection flags is not a
    // security boundary. Every caller option must instead be explicitly safe.
    fail("psql_safe_forbidden_connection_override");
  }
  if (pendingOption) fail("psql_safe_missing_option_value");
}

const rawDatabaseUrl = process.env.DATABASE_URL;
if (!rawDatabaseUrl) fail("psql_safe_database_url_required");

const { password, encodedPassword, url } = parseDatabaseUrl(rawDatabaseUrl);
const migrationRole = migrationRoleFromEnvironment();
if (migrationRole) {
  // Omitting pg_catalog makes PostgreSQL search it implicitly before public,
  // while leaving public as the creation target for the immutable migration
  // corpus's unqualified DDL. The migration-role preflight separately proves
  // that public is sealed and every existing object is owner-controlled.
  url.searchParams.set(
    "options",
    `-crole=${migrationRole} -csearch_path=public -clock_timeout=10s -cclient_min_messages=warning`,
  );
}
const serializedUrl = url.toString();
const queryIndex = serializedUrl.indexOf("?");
const sanitizedUrl = queryIndex === -1
  ? serializedUrl
  : `${serializedUrl.slice(0, queryIndex)}${serializedUrl.slice(queryIndex).replaceAll("+", "%20")}`;
const tokens = redactionTokens(password, encodedPassword);
const psqlArgs = process.argv.slice(2);
validatePsqlArgs(psqlArgs, tokens);
const childEnv = { ...process.env };
for (const key of SECRET_ENV_KEYS) delete childEnv[key];
for (const key of LIBPQ_OVERRIDE_ENV_KEYS) delete childEnv[key];
delete childEnv.AXEL_PSQL_BIN;
delete childEnv.LANGUAGE;
childEnv.LANG = "C";
childEnv.LC_ALL = "C";
childEnv.LC_MESSAGES = "C";
childEnv.PGCONNECT_TIMEOUT = "10";
if (password) childEnv.PGPASSWORD = password;
else delete childEnv.PGPASSWORD;

// libpq otherwise requires ~/.postgresql/root.crt even when Node successfully
// verifies the same public certificate. Keep explicit/private CA configuration
// intact; supply Node's trusted roots only when none was configured.
const sslMode = url.searchParams.get("sslmode") || childEnv.PGSSLMODE;
const defaultRoot = process.platform === "win32"
  ? path.join(process.env.APPDATA || homedir(), "postgresql", "root.crt")
  : path.join(homedir(), ".postgresql", "root.crt");
if (["verify-ca", "verify-full"].includes(sslMode)
  && !url.searchParams.has("sslrootcert")
  && !childEnv.PGSSLROOTCERT
  && !existsSync(defaultRoot)) {
  let caDirectory;
  try {
    const certificates = getCACertificates("default");
    if (certificates.length === 0) throw new Error("no_trusted_certificates");
    caDirectory = mkdtempSync(path.join(tmpdir(), "axel-psql-ca-"));
    process.once("exit", () => rmSync(caDirectory, { recursive: true, force: true }));
    childEnv.PGSSLROOTCERT = path.join(caDirectory, "root.crt");
    writeFileSync(childEnv.PGSSLROOTCERT, certificates.join("\n"), { mode: 0o600 });
  } catch {
    fail("psql_safe_certificate_setup_failed");
  }
}

const psqlBin = process.env.AXEL_PSQL_BIN || "psql";
let result;
try {
  result = spawnSync(
    psqlBin,
    [
      "-X",
      "-w",
      "-v",
      "VERBOSITY=terse",
      "-v",
      "SHOW_CONTEXT=never",
      sanitizedUrl,
      ...psqlArgs,
    ],
    {
      env: childEnv,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["inherit", "pipe", "pipe"],
      timeout: 25 * 60 * 1000,
    },
  );
} catch {
  fail("psql_safe_spawn_failed");
}

if (result.error) fail("psql_safe_spawn_failed");

const connectionFailure =
  result.status !== 0 && /(?:^|\n)psql:\s*error:/iu.test(result.stderr ?? "");
if (connectionFailure) {
  process.stderr.write("psql_safe_connection_failed\n");
} else if (result.status !== 0) {
  process.stderr.write("psql_safe_command_failed\n");
} else {
  if (result.stdout) process.stdout.write(redact(result.stdout, tokens));
  if (result.stderr) process.stderr.write(redact(result.stderr, tokens));
}

if (result.signal) {
  try {
    process.kill(process.pid, result.signal);
  } catch {
    process.exit(1);
  }
} else {
  process.exit(result.status ?? 1);
}
