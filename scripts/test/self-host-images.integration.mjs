import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const suffix = process.env.AXEL_TEST_IMAGE_TAG ?? "ci";
const image = (target) => `axel-${target}:${suffix}`;
const prefix = `axel-image-test-${process.pid}`;
const network = `${prefix}-network`;
const frontend = `${prefix}-frontend`;
const proxy = `${prefix}-proxy`;
const postgres = `${prefix}-postgres`;
const dashboard = `${prefix}-dashboard`;
const delivery = `${prefix}-delivery`;
const temporary = await mkdtemp(path.join(tmpdir(), "axel-image-test-"));
const docker = async (...args) => (await exec("docker", args, { maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
const password = "AxelImageTestPassword123!";
const email = "image-test@example.test";
const databasePasswords = Object.fromEntries(
  ["axel", "axel_migration", "axel_dashboard_app", "axel_delivery_app"]
    .map((role) => [role, randomBytes(32).toString("hex")]),
);
const sourceSecret = randomBytes(32).toString("hex");
const deliverySecret = randomBytes(32).toString("hex");
const databaseUrl = (role) => `postgresql://${role}:${databasePasswords[role]}@${postgres}:5432/axel?sslmode=disable`;
const environmentFile = async (name, values) => {
  const filename = path.join(temporary, name);
  await writeFile(filename, Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n"), { mode: 0o600 });
  return filename;
};
const waitUntil = async (check) => {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* The container may still be starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("image_startup_deadline_exceeded");
};
const portFor = async (container, port) => {
  const binding = await docker("port", container, `${port}/tcp`);
  assert.match(binding, /^127\.0\.0\.1:\d+$/);
  return Number(binding.split(":")[1]);
};
const request = (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
const containers = [proxy, dashboard, delivery, postgres];

try {
  // Application containers cannot reach providers. A test proxy connects the
  // internal network to host loopback without giving the applications egress.
  await docker("network", "create", "--internal", network);
  await docker("network", "create", frontend);
  await docker("run", "--detach", "--name", postgres, "--network", network,
    "--env", "POSTGRES_USER=axel", "--env", "POSTGRES_DB=axel",
    "--env", `POSTGRES_PASSWORD=${databasePasswords.axel}`,
    "postgres:16@sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94");
  await waitUntil(async () => { await docker("exec", postgres, "pg_isready", "-h", "127.0.0.1", "-U", "axel", "-d", "axel"); return true; });

  const migrationEnv = await environmentFile("migration.env", {
    DATABASE_ADMIN_URL: databaseUrl("axel"),
    DATABASE_MIGRATION_URL: databaseUrl("axel_migration"),
    DATABASE_DASHBOARD_URL: databaseUrl("axel_dashboard_app"),
    DATABASE_DELIVERY_URL: databaseUrl("axel_delivery_app"),
  });
  for (let pass = 0; pass < 2; pass++) {
    await docker("run", "--rm", "--network", network, "--read-only", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
      "--env-file", migrationEnv, image("migration"));
  }
  console.log("Migration image bootstrapped and rechecked Postgres with separate runtime roles.");

  const salt = randomBytes(16);
  const hash = `pbkdf2_sha256$310000$${salt.toString("base64url")}$${pbkdf2Sync(password, salt, 310000, 32, "sha256").toString("base64url")}`;
  await docker("exec", postgres, "psql", "-U", "axel", "-d", "axel", "-v", "ON_ERROR_STOP=1", "-c", `
    INSERT INTO workspaces(id, name, slug, billing_exempt) VALUES ('ws_image_test', 'Image test workspace', 'image-test', true);
    INSERT INTO users(id, email, name, password_hash, email_verified_at)
      VALUES ('usr_image_test', '${email}', 'Image test', '${hash}', now());
    INSERT INTO workspace_members(workspace_id, user_id, role) VALUES ('ws_image_test', 'usr_image_test', 'owner');
  `);

  const common = {
    AXEL_DEPLOYMENT_MODE: "self-hosted", AXEL_SELF_HOST_PROFILE: "small",
    AXEL_APP_URL: "http://localhost:3000", AXEL_INGEST_URL: "https://ingest.example.test",
    AXEL_DELIVERY_URL: "https://delivery.example.test", CREDENTIALS_MASTER_KEY: randomBytes(32).toString("hex"),
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), INGEST_ADMIN_TOKEN: randomBytes(32).toString("hex"),
    RAW_PAYLOAD_BUCKET: "image-test-payloads",
  };
  const dashboardEnv = await environmentFile("dashboard.env", {
    ...common, DATABASE_URL: databaseUrl("axel_dashboard_app"), CRON_SECRET: randomBytes(32).toString("hex"),
  });
  const deliveryEnv = await environmentFile("delivery.env", {
    ...common, DATABASE_URL: databaseUrl("axel_delivery_app"), DELIVERY_ROLE: "web",
    CLOUDFLARE_API_TOKEN: "synthetic-runtime-token", DELIVERY_QUEUE_ID: "b".repeat(32),
    SOURCE_LOOKUP_SHARED_SECRET: sourceSecret, DELIVERY_SHARED_SECRET: deliverySecret,
    POLL_MAX_IDLE_INTERVAL_MS: "60000", PORT: "10000",
  });
  await docker("run", "--detach", "--name", dashboard, "--network", network,
    "--env-file", dashboardEnv, image("dashboard"));
  await docker("run", "--detach", "--name", delivery, "--network", network,
    "--env-file", deliveryEnv, image("delivery"));
  const caddyfile = path.join(temporary, "Caddyfile");
  await writeFile(caddyfile, `:3000 {\n reverse_proxy ${dashboard}:3000\n}\n:10000 {\n reverse_proxy ${delivery}:10000\n}\n`);
  await docker("create", "--name", proxy, "--network", frontend,
    "--publish", "127.0.0.1::3000", "--publish", "127.0.0.1::10000",
    "--volume", `${caddyfile}:/etc/caddy/Caddyfile:ro`,
    "caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d");
  await docker("network", "connect", network, proxy);
  await docker("start", proxy);
  const dashboardUrl = `http://127.0.0.1:${await portFor(proxy, 3000)}`;
  const deliveryUrl = `http://127.0.0.1:${await portFor(proxy, 10000)}`;
  await waitUntil(async () => (await request(`${dashboardUrl}/login`)).ok);
  await waitUntil(async () => (await request(`${deliveryUrl}/health`)).ok);

  const login = await (await request(`${dashboardUrl}/login`)).text();
  assert.ok(login.includes('name="email"') && login.includes('name="password"'));
  const assets = [...login.matchAll(/(?:src|href)="(\/_next\/static\/[^"?]+\.(?:js|css))/g)].map((match) => match[1]);
  assert.ok(assets.some((asset) => asset.endsWith(".js")) && assets.some((asset) => asset.endsWith(".css")));
  for (const asset of new Set(assets)) assert.equal((await request(`${dashboardUrl}${asset}`)).status, 200);
  const openapi = await (await request(`${dashboardUrl}/openapi.yaml`)).text();
  assert.ok(openapi.includes(common.AXEL_APP_URL) && openapi.includes(common.AXEL_INGEST_URL));
  assert.ok(!openapi.includes("app.axelapp.ai"));

  assert.equal((await request(`${deliveryUrl}/internal/source`, { method: "POST", body: '{}' })).status, 401);
  const source = await request(`${deliveryUrl}/internal/source`, {
    method: "POST", headers: { "content-type": "application/json", "x-axel-shared-secret": sourceSecret },
    body: JSON.stringify({ source_id: "src_image_test_missing" }),
  });
  assert.equal(source.status, 200);
  assert.deepEqual(await source.json(), { source: null });
  assert.equal((await request(`${deliveryUrl}/metrics`)).status, 401);
  assert.equal((await request(`${deliveryUrl}/metrics`, { headers: { "x-axel-shared-secret": deliverySecret } })).status, 200);
  await docker("run", "--rm", "--network", "none", image("delivery"), "node", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { dueCronPaths } from '/app/scripts/self-host/cron.mjs';
    assert.ok(dueCronPaths(new Date('2026-09-14T15:00:00Z')).includes('/api/cron/nudges'));
    assert.notEqual(process.getuid(), 0);
  `);
  console.log("Dashboard assets and runtime origins passed; delivery served authenticated Postgres lookups and metrics; cron loaded.");
  if (process.argv.includes("--serve")) {
    console.log(`Browser QA: ${dashboardUrl}/login\nSynthetic login: ${email} / ${password}`);
    console.log("Ctrl-C removes the test containers and network.");
    const keepAlive = setInterval(() => {}, 60_000);
    try {
      await new Promise((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
    } finally {
      clearInterval(keepAlive);
    }
  }
} catch (error) {
  for (const container of containers) {
    console.error(await docker("logs", "--tail", "25", container).catch(() => ""));
  }
  throw error;
} finally {
  for (const container of containers) await docker("rm", "--force", "--volumes", container).catch(() => {});
  await docker("network", "rm", network).catch(() => {});
  await docker("network", "rm", frontend).catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
