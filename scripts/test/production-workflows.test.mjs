import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) => readFileSync(path.join(root, file), "utf8");
const listWorkflowFiles = () =>
  readdirSync(path.join(root, ".github/workflows"))
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .map((file) => `.github/workflows/${file}`);

test("the supported Node runtime is pinned consistently", () => {
  const nodeVersion = read(".node-version").trim();
  const rootPackage = JSON.parse(read("package.json"));
  assert.match(nodeVersion, /^22\.\d+\.\d+$/);
  assert.equal(rootPackage.engines.node, ">=22.13.0 <23");
  assert.equal(rootPackage.packageManager, "pnpm@9.12.0");
  assert.equal(rootPackage.engines.pnpm, "9.12.0");

  const dockerPins = Array.from(
    read("Dockerfile").matchAll(
      /^FROM node:([^@]+)@sha256:([a-f0-9]{64}) AS (workspace|dashboard|delivery)$/gm,
    ),
    (match) => ({ image: match[1], digest: match[2], stage: match[3] }),
  );
  assert.equal(dockerPins.length, 3);
  assert.deepEqual(
    new Set(dockerPins.map(({ image }) => image)),
    new Set([`${nodeVersion}-bookworm-slim`]),
  );
  assert.deepEqual(
    new Set(dockerPins.map(({ digest }) => digest)),
    new Set(["83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5"]),
  );
  assert.deepEqual(
    new Set(dockerPins.map(({ stage }) => stage)),
    new Set(["workspace", "dashboard", "delivery"]),
  );

  const renderPins = Array.from(
    read("render.yaml").matchAll(/^\s+- key: NODE_VERSION\n\s+value: "([^"]+)"$/gm),
    (match) => match[1],
  );
  assert.ok(renderPins.length > 0);
  assert.deepEqual(new Set(renderPins), new Set([nodeVersion]));
  assert.match(
    read("scripts/sync-render-node-version.mjs"),
    new RegExp(`export const EXPECTED_NODE_VERSION = "${nodeVersion.replaceAll(".", "\\.")}";`),
  );
});

test("the source-only CLI version matches the release version", () => {
  const version = read("VERSION").trim();
  const escapedVersion = version.replaceAll(".", "\\.");
  const cliPackage = JSON.parse(read("packages/cli/package.json"));

  assert.equal(cliPackage.private, true);
  assert.equal(cliPackage.version, version);
  assert.match(read("packages/cli/src/cli.ts"), new RegExp(`@axel/cli ${escapedVersion}`));
  assert.match(
    read("packages/cli/src/api-client.ts"),
    new RegExp(`user-agent": "axel-cli/${escapedVersion}`),
  );
});

test("CI security is read-only and enforces the reviewed audit baseline", () => {
  const workflow = read(".github/workflows/ci.yml");
  const securityStart = workflow.indexOf("  security:");
  const dependencyReviewStart = workflow.indexOf("  dependency-review:");
  const security = workflow.slice(securityStart, dependencyReviewStart);
  assert.ok(securityStart >= 0 && dependencyReviewStart > securityStart);
  assert.match(security, /^    permissions:\n      contents: read$/m);
  assert.doesNotMatch(security, /security-events:\s*write/);
  assert.match(security, /pnpm audit --audit-level low --ignore-registry-errors/);
  assert.match(read("scripts/release-verify.mjs"), /pnpm audit --audit-level low --json/);
});

test("CI builds every published self-host image target", () => {
  const workflow = read(".github/workflows/ci.yml");
  const imageStart = workflow.indexOf("  self-host-images:");
  const visualStart = workflow.indexOf("  visual-smoke:");
  const imageJob = workflow.slice(imageStart, visualStart);

  assert.ok(imageStart >= 0 && visualStart > imageStart);
  assert.match(imageJob, /^    timeout-minutes: 45$/m);
  assert.match(imageJob, /docker build --check \./);
  for (const target of ["migration", "dashboard", "delivery"]) {
    assert.match(imageJob, new RegExp(`docker build --target ${target}`));
  }
  assert.match(
    imageJob,
    /--build-arg NEXT_PUBLIC_AXEL_INGEST_URL=https:\/\/ingest\.example\.test/,
  );
});

test("CI Postgres migrations provision the required capability roles", () => {
  const workflow = read(".github/workflows/ci.yml");
  const postgresStart = workflow.indexOf("  postgres-schema:");
  const securityStart = workflow.indexOf("  security:");
  const postgres = workflow.slice(postgresStart, securityStart);
  assert.ok(postgresStart >= 0 && securityStart > postgresStart);
  assert.match(postgres, /DATABASE_VERIFY_CAPABILITY_ROLE: axel_verify/);
  assert.match(postgres, /DATABASE_RUNTIME_CAPABILITY_ROLES: axel_runtime/);
});

test("production deploys are reviewed, migration-first manual promotions", () => {
  const workflows = [
    [".github/workflows/deploy-cloudflare.yml", "wrangler deploy"],
    [".github/workflows/deploy-render.yml", "deploy-render-service.sh"],
    [".github/workflows/deploy-vercel.yml", "vercel-preview-deploy.sh"],
  ];
  for (const [file, deployCommand] of workflows) {
    const source = read(file);
    assert.match(source, /^  workflow_dispatch:$/m, `${file} is manually promoted`);
    assert.doesNotMatch(source, /^  push:$/m, `${file} does not deploy a main merge`);
    assert.match(source, /^  group: production-deploy$/m, `${file} is serialized with other deploys`);
    assert.match(source, /^    environment: Production$/m, `${file} uses the protected environment`);
    assert.ok(
      source.indexOf("./scripts/run-migrations.sh") < source.indexOf(deployCommand),
      `${file} applies pending migrations before deployment`,
    );
    assert.match(source, /bash scripts\/smoke\.sh/, `${file} runs a post-deploy smoke`);
    assert.match(source, /AXEL_REQUIRE_DELIVERY_CANARY: "1"/, `${file} requires end-to-end delivery proof`);
  }
});

test("marketing can deploy independently while dashboard deploys remain migration-first", () => {
  const workflow = read(".github/workflows/deploy-vercel.yml");
  for (const step of ["Install Postgres client", "Apply pending Postgres migrations", "Stage dashboard at the reviewed commit", "Promote staged dashboard"]) {
    assert.ok(workflow.includes(`- name: ${step}\n        if: \u0024{{ inputs.application != 'marketing' }}`), step);
  }
  for (const step of ["Stage marketing at the reviewed commit", "Promote staged marketing"]) {
    assert.ok(workflow.includes(`- name: ${step}\n        if: \u0024{{ inputs.application != 'dashboard' }}`), step);
  }
  assert.match(workflow, /steps\.dashboard\.outputs\.url \|\| vars\.AXEL_APP_URL/);
  assert.match(workflow, /steps\.marketing\.outputs\.url \|\| vars\.AXEL_MARKETING_URL/);
  assert.match(workflow, /\|\| secrets\.AXEL_CANARY_RECEIPT_URL/);
});

test("migration jobs install the locked Postgres verifier dependency in their own job", () => {
  for (const file of ["deploy-render.yml", "deploy-vercel.yml", "deploy-cloudflare.yml", "migrate-postgres.yml", "migrate-postgres-run.yml"]) {
    const workflow = read(`.github/workflows/${file}`);
    const job = workflow.slice(workflow.indexOf("  deploy:") >= 0 ? workflow.indexOf("  deploy:") : workflow.indexOf("jobs:"));
    const install = job.indexOf("pnpm install --frozen-lockfile");
    assert.ok(install >= 0 && install < job.indexOf("./scripts/run-migrations.sh"), file);
  }
});

test("production mutations are single-target and smoke even after a failed mutation", () => {
  for (const file of [
    ".github/workflows/deploy-cloudflare.yml",
    ".github/workflows/deploy-render.yml",
    ".github/workflows/sync-cloudflare-secrets.yml",
  ]) {
    const workflow = read(file);
    assert.doesNotMatch(workflow, /^\s+- all$/m, file);
    assert.doesNotMatch(workflow, /inputs\.service == 'all'/, file);
  }

  for (const file of [
    ".github/workflows/deploy-cloudflare.yml",
    ".github/workflows/deploy-render.yml",
    ".github/workflows/deploy-vercel.yml",
    ".github/workflows/sync-cloudflare-secrets.yml",
  ]) {
    const workflow = read(file);
    const marker = workflow.indexOf('id: mutation_attempt');
    const smoke = workflow.lastIndexOf("bash scripts/smoke.sh");
    assert.ok(marker >= 0 && marker < smoke, file);
    const smokeStep = workflow.slice(workflow.lastIndexOf("- name:", smoke), smoke);
    assert.match(smokeStep, /if: \$\{\{ always\(\)/, file);
    assert.match(smokeStep, /steps\.mutation_attempt\.outputs\.attempted == 'true'/, file);
  }

  const render = read(".github/workflows/deploy-render.yml");
  assert.ok(
    render.indexOf("id: mutation_attempt") < render.indexOf("harden-render-auto-deploy.sh"),
    "Render records an attempted mutation before changing provider state",
  );
});

test("standalone production smoke is an explicit protected operation", () => {
  const smoke = read(".github/workflows/smoke.yml");
  assert.match(smoke, /^name: Production Smoke$/m);
  assert.match(smoke, /^  workflow_dispatch:$/m);
  assert.doesNotMatch(smoke, /^  push:$/m);
  assert.match(smoke, /^  group: production-deploy$/m);
  assert.match(smoke, /^    environment: Production$/m);
  assert.match(smoke, /github\.ref == 'refs\/heads\/main'/);
  assert.match(
    smoke,
    /AXEL_SOAK_CANDIDATE_SHA: \$\{\{ vars\.AXEL_SOAK_CANDIDATE_SHA \}\}/,
  );
  assert.match(smoke, /test "\$\{AXEL_SOAK_CANDIDATE_SHA\}" = "\$\{GITHUB_SHA\}"/);
  assert.ok(
    smoke.indexOf("Require the pinned soak candidate") < smoke.indexOf("bash scripts/smoke.sh"),
  );
  assert.match(smoke, /bash scripts\/smoke\.sh/);

  assert.match(smoke, /^      test_queue_lag_alert:$/m);
  assert.match(smoke, /^        default: false$/m);
  assert.match(smoke, /^        type: boolean$/m);
  const alertProof = smoke.slice(smoke.indexOf("Prove critical Queue-lag alert transport"));
  assert.match(
    alertProof,
    /github\.event_name == 'workflow_dispatch' && inputs\.test_queue_lag_alert/,
  );
  assert.match(alertProof, /OPS_TEST_TOKEN: \$\{\{ secrets\.OPS_TEST_TOKEN \}\}/);
  assert.match(
    alertProof,
    /VERCEL_AUTOMATION_BYPASS_SECRET_DASHBOARD: \$\{\{ secrets\.VERCEL_AUTOMATION_BYPASS_SECRET_DASHBOARD \}\}/,
  );
  assert.match(alertProof, /sentry-test\?mode=queue-lag-critical/);
  assert.match(alertProof, /--fail-with-body --silent --show-error/);
  assert.match(alertProof, /'\{"ok":true,"probe":"queue_lag","severity":"critical"\}'/);
  assert.doesNotMatch(alertProof, /echo[^\n]*probe_response/);
});

test("Postgres workflows share the production deployment lock", () => {
  for (const file of [
    ".github/workflows/migrate-postgres-run.yml",
    ".github/workflows/migrate-postgres.yml",
  ]) {
    const workflow = read(file);
    assert.match(workflow, /^  group: production-deploy$/m, file);
    assert.match(workflow, /^  cancel-in-progress: false$/m, file);
    assert.match(workflow, /^    environment: Production$/m, file);
    assert.match(workflow, /github\.ref == 'refs\/heads\/main'/, file);
  }
});

test("ClickHouse schema changes cannot race a stateful deploy", () => {
  const workflow = read(".github/workflows/migrate-clickhouse.yml");
  assert.match(workflow, /^  group: production-deploy$/m);
  assert.match(workflow, /^  cancel-in-progress: false$/m);
  assert.match(workflow, /^    environment: Production$/m);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
});

test("Vercel and Render provider-side git auto-deploys are disabled", () => {
  for (const file of ["apps/dashboard/vercel.json", "apps/marketing/vercel.json"]) {
    const config = JSON.parse(read(file));
    assert.equal(config.git?.deploymentEnabled, false, file);
    assert.match(config.installCommand, /corepack@0\.35\.0/);
    assert.match(config.installCommand, /corepack pnpm install --frozen-lockfile/);
    assert.match(config.buildCommand, /corepack pnpm build/);
    assert.deepEqual(JSON.parse(read(file.replace("vercel.json", "package.json"))).engines,
      { node: "22.x", pnpm: "9.12.0" });
    assert.doesNotMatch(config.installCommand, /@latest/);
  }
  const render = read("render.yaml");
  assert.doesNotMatch(render, /^\s*- key: PARQUET_DELIVERY_QUEUE_ID$/m);
  assert.doesNotMatch(render, /^\s*autoDeploy:\s*true\s*$/m);
  assert.doesNotMatch(render, /^\s*autoDeployTrigger:\s*(commit|checksPass)\s*$/m);
  assert.match(render, /^\s*autoDeployTrigger:\s*off\s*$/m);
  const renderWorkflow = read(".github/workflows/deploy-render.yml");
  assert.match(
    renderWorkflow,
    /^        run: bash scripts\/harden-render-auto-deploy\.sh "\$RENDER_SERVICE_NAME"$/m,
  );
  const hardenStepStart = renderWorkflow.indexOf(
    "- name: Disable and verify Render git auto-deploys",
  );
  const hardenStepEnd = renderWorkflow.indexOf("\n      - name:", hardenStepStart + 1);
  const hardenStep = renderWorkflow.slice(hardenStepStart, hardenStepEnd);
  assert.match(hardenStep, /RENDER_SERVICE_NAME: \$\{\{ inputs\.service \}\}/);
  assert.doesNotMatch(
    renderWorkflow,
    /^        run: bash scripts\/harden-render-auto-deploy\.sh$/m,
    "an exact deploy must never invoke the legacy all-service hardener",
  );
  assert.ok(
    renderWorkflow.indexOf("harden-render-auto-deploy.sh")
      < renderWorkflow.indexOf("deploy-render-service.sh"),
    "Render provider state is hardened before deployment",
  );
  assert.doesNotMatch(renderWorkflow, /axel-clickhouse/);
  assert.doesNotMatch(renderWorkflow, /confirm_clickhouse|deploy-stateful-clickhouse/);
  assert.match(
    renderWorkflow,
    /test "\$PRODUCTION_CONFIRMATION" = "deploy-reviewed-production"/,
  );
  assert.doesNotMatch(read("scripts/deploy-render-service.sh"), /axel-clickhouse/);

  const nodeSyncStepStart = renderWorkflow.indexOf(
    "- name: Save and verify the selected Render Node version",
  );
  const nodeSyncStepEnd = renderWorkflow.indexOf(
    "\n      - name: Deploy axel-delivery-native",
    nodeSyncStepStart,
  );
  const nodeSyncStep = renderWorkflow.slice(nodeSyncStepStart, nodeSyncStepEnd);
  assert.ok(nodeSyncStepStart >= 0 && nodeSyncStepEnd > nodeSyncStepStart);
  assert.match(nodeSyncStep, /node scripts\/sync-render-node-version\.mjs/);
  assert.match(nodeSyncStep, /RENDER_SERVICE_NAME: \$\{\{ inputs\.service \}\}/);
  for (const service of [
    "axel-delivery-native",
    "axel-delivery-workers",
    "axel-pull-worker",
  ]) {
    assert.match(nodeSyncStep, new RegExp(`inputs\\.service == '${service}'`));
  }
  assert.doesNotMatch(nodeSyncStep, /axel-clickhouse/);
  assert.ok(nodeSyncStepStart < renderWorkflow.indexOf("deploy-render-service.sh"));

  const hardener = read("scripts/harden-render-auto-deploy.sh");
  assert.doesNotMatch(hardener, /axel-clickhouse/);
  for (const service of [
    "axel-delivery-native",
    "axel-delivery-workers",
    "axel-pull-worker",
  ]) {
    const caseStart = hardener.indexOf(`  ${service})`);
    const caseEnd = hardener.indexOf("\n      ;;", caseStart);
    const caseBlock = hardener.slice(caseStart, caseEnd);
    assert.ok(caseStart >= 0 && caseEnd > caseStart);
    assert.match(caseBlock, new RegExp(service));
    assert.doesNotMatch(caseBlock, /axel-clickhouse/);
  }

  const nodeSyncHelper = read("scripts/sync-render-node-version.mjs");
  assert.doesNotMatch(nodeSyncHelper, /axel-clickhouse/);
  assert.match(
    nodeSyncHelper,
    /env-vars\/NODE_VERSION`;/,
    "Node sync reads and writes only the exact NODE_VERSION key",
  );
  assert.match(
    JSON.parse(read("package.json")).scripts["test:deploy-scripts"],
    /scripts\/test\/sync-render-node-version\.test\.mjs/,
  );
  assert.match(
    read("docs/runbook-clickhouse-migration.md"),
    /application release workflow cannot deploy `axel-clickhouse`/,
  );
});

test("Render automation is workspace-bound and keeps the canary worker singleton", () => {
  for (const file of [
    ".github/workflows/deploy-render.yml",
    ".github/workflows/sync-database-url.yml",
    ".github/workflows/sync-render-secrets.yml",
  ]) {
    assert.match(
      read(file),
      /RENDER_OWNER_ID: \$\{\{ vars\.RENDER_OWNER_ID \}\}/,
      file,
    );
  }

  const blueprint = read("render.yaml");
  const worker = blueprint.slice(
    blueprint.indexOf("name: axel-delivery-workers"),
    blueprint.indexOf("name: axel-pull-worker"),
  );
  assert.match(worker, /^    numInstances: 1$/m);
  assert.doesNotMatch(worker, /^    scaling:$/m);

  const runbook = read("docs/runbook-delivery-canary.md");
  assert.match(runbook, /gh variable set RENDER_OWNER_ID --env Production/);
  assert.doesNotMatch(runbook, /service=all/);
  assert.doesNotMatch(runbook, /for render_service/);
  assert.doesNotMatch(runbook, /for cloudflare_service/);
  assert.match(runbook, /The first check starts 15 minutes after startup/);
  assert.match(runbook, /both check-ins must carry the pinned candidate SHA/);
  assert.doesNotMatch(runbook, /immediate boot check|first check at startup/);
});

test("Cloudflare native delivery queue is hardened before worker deployment", () => {
  const workflow = read(".github/workflows/deploy-cloudflare.yml");
  const hardenStepStart = workflow.indexOf("- name: Harden and verify the native delivery queue");
  const harden = workflow.indexOf("harden-cloudflare-native-queue.mjs", hardenStepStart);
  const hardenStepEnd = workflow.indexOf("\n      - ", harden + 1);
  const hardenStep = workflow.slice(hardenStepStart, hardenStepEnd);
  const deploy = workflow.indexOf("wrangler deploy");
  assert.ok(harden >= 0 && harden < deploy);
  assert.match(
    hardenStep,
    /CLOUDFLARE_QUEUE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_QUEUE_API_TOKEN \}\}/,
  );
  assert.doesNotMatch(hardenStep, /secrets\.CLOUDFLARE_API_TOKEN/);
});

test("hosted source authorization uses a SQLite Durable Object fence", () => {
  const config = read("apps/ingest-worker/wrangler.toml");
  assert.match(config, /name = "SOURCE_AUTHORITY"/);
  assert.match(config, /class_name = "SourceAuthorityDurableObject"/);
  assert.match(config, /new_sqlite_classes = \["SourceAuthorityDurableObject"\]/);
  assert.match(config, /SOURCE_AUTHORITY_REQUIRED = "true"/);

  const secretSync = read(".github/workflows/sync-cloudflare-secrets.yml");
  assert.match(secretSync, /ORDERING_KEY_HMAC_SECRET is required/);
  assert.match(secretSync, /\$\{#ORDERING_KEY_HMAC_SECRET\}[^\n]*-lt 32/);
  assert.match(secretSync, /ORDERING_KEY_HMAC_SECRET must be at least 32 characters/);
  assert.match(secretSync, /secrets\.ORDERING_KEY_HMAC_SECRET/);
  const secretSyncScript = read("scripts/sync-cloudflare-secret-version.sh");
  assert.match(
    secretSyncScript,
    /apps\/ingest-worker\)[\s\S]*allowed_keys=.*ORDERING_KEY_HMAC_SECRET/,
  );
  assert.match(secretSyncScript, /\$\{#secret_value\}[^\n]*-lt 32/);

  const ingest = read("apps/ingest-worker/src/index.ts");
  assert.match(ingest, /beginSourceAuthorizationWithAuthority\(/);
  assert.doesNotMatch(ingest, /resolveSource\(cache,/);
  const confirm = ingest.indexOf("confirmSourceAuthorizationWithAuthority(");
  const persist = ingest.indexOf("env.EVENTS_RAW.put(");
  assert.ok(confirm >= 0 && persist > confirm, "authority is confirmed before the first durable write");
  assert.match(ingest, /url\.searchParams\.has\("token"\)/);
  assert.doesNotMatch(ingest, /url\.searchParams\.get\("token"\)/);

  const authority = read("apps/ingest-worker/src/source-authority.ts");
  assert.doesNotMatch(authority, /status: "ready";\s+source: Source \| null;/);
  assert.match(authority, /sourceFingerprint: string/);

  const admin = read("apps/ingest-worker/src/admin.ts");
  const triggerStart = admin.indexOf("export async function handleTriggerEvent");
  const triggerConfirm = admin.indexOf("await deps.confirmSourceAuthorization(", triggerStart);
  const triggerPersist = admin.indexOf("await deps.rawPayloads.put(", triggerStart);
  assert.ok(triggerConfirm > triggerStart && triggerPersist > triggerConfirm);

  const workflow = read(".github/workflows/deploy-cloudflare.yml");
  const secretPreflight = workflow.indexOf("Preflight required ingest Worker secrets");
  const deploy = workflow.indexOf("wrangler deploy");
  const secretReadback = workflow.indexOf("Read back required ingest Worker secrets");
  const verify = workflow.indexOf("Verify ingest source authority fence");
  assert.ok(secretPreflight >= 0 && deploy > secretPreflight);
  assert.ok(secretReadback > deploy && verify > secretReadback);
  const preflightStep = workflow.slice(
    secretPreflight,
    workflow.indexOf("\n      - name:", secretPreflight + 1),
  );
  const readbackStep = workflow.slice(
    secretReadback,
    workflow.indexOf("\n      - name:", secretReadback + 1),
  );
  assert.match(preflightStep, /wrangler secret list --format json/);
  assert.match(preflightStep, /ORDERING_KEY_HMAC_SECRET is required/);
  assert.match(preflightStep, /\$\{#ORDERING_KEY_HMAC_SECRET\}[^\n]*-lt 32/);
  assert.match(readbackStep, /wrangler secret list --format json/);
  assert.match(readbackStep, /names\.has\("ORDERING_KEY_HMAC_SECRET"\)/);
  const verificationStep = workflow.slice(verify, workflow.indexOf("\n      - name:", verify + 1));
  assert.match(verificationStep, /\/admin\/source-authority\/fence/);
  assert.match(verificationStep, /\/admin\/source-authority\/sync/);
  assert.match(verificationStep, /\\"source\\":null/);

  const rolloutRunbook = read("docs/runbook-delivery-canary.md");
  assert.match(
    rolloutRunbook,
    /dashboard promotion must reach terminal[\s\S]*before the ingest-worker deployment/i,
  );
  assert.match(
    rolloutRunbook,
    /legacy endpoint[\s\S]*fail-closed state[\s\S]*authenticated\s+origin/i,
  );
  assert.match(rolloutRunbook, /dashboard-first sequence/);

  const selfHost = read("scripts/self-host/generate-wrangler.mjs");
  assert.match(selfHost, /SOURCE_AUTHORITY is intentionally absent/);
  assert.match(selfHost, /SOURCE_AUTHORITY_REQUIRED = "false"/);
  assert.doesNotMatch(selfHost, /name = "SOURCE_AUTHORITY"/);

  const selfHostEnv = read("scripts/self-host/env-file.mjs");
  assert.match(selfHostEnv, /ORDERING_KEY_HMAC_SECRET: randomHex\(32\)/);
});

test("delivery canary reconciles source authority around the database commit", () => {
  const canary = read("scripts/provision-delivery-canary.mjs");
  const fence = canary.indexOf("await fenceCanarySource(config", canary.indexOf("runProvision"));
  const reconcile = canary.indexOf("await reconcileCanaryAdminState(", fence);
  const reload = canary.indexOf("await loadCommittedCanarySource(adminClient)", reconcile);
  const sync = canary.indexOf("await syncCanarySource(", reload);
  assert.ok(fence >= 0 && reconcile > fence && reload > reconcile && sync > reload);

  const runbook = read("docs/runbook-delivery-canary.md");
  assert.match(runbook, /fences the canary source before/i);
  assert.match(runbook, /fetches the source row again/i);
  assert.match(runbook, /leaves the canary source blocked/i);
});

test("fork PR checks have no deployment secrets", () => {
  const forkCheck = read(".github/workflows/preview-deploy-smoke.yml");
  assert.match(forkCheck, /^  pull_request:$/m);
  assert.doesNotMatch(forkCheck, /secrets\./);
  assert.match(forkCheck, /persist-credentials: false/);
  assert.match(
    forkCheck,
    /pnpm --filter @axel\/dashboard\.\.\. --filter @axel\/marketing\.\.\. build/,
  );

  assert.throws(
    () => read(".github/workflows/trusted-preview-deploy.yml"),
    /ENOENT/,
    "secret-bearing hosted PR previews stay disabled",
  );
});

test("Vercel production is staged, smoked, then promoted", () => {
  const workflow = read(".github/workflows/deploy-vercel.yml");
  const stage = workflow.indexOf("vercel-preview-deploy.sh");
  const smoke = workflow.indexOf("Smoke exact deployment URLs");
  const promote = workflow.indexOf("pnpm exec vercel promote");
  assert.ok(stage >= 0 && stage < smoke && smoke < promote);
  const deployHelper = read("scripts/vercel-preview-deploy.sh");
  assert.match(deployHelper, /--prod --skip-domain/);
  assert.match(deployHelper, /export VERCEL=1/);
  assert.match(deployHelper, /export VERCEL_ENV="\$environment"/);
  assert.match(deployHelper, /export CI=1/);
  assert.match(deployHelper, /export VERCEL_GIT_COMMIT_SHA="\$SENTRY_RELEASE"/);
  assert.match(deployHelper, /verify-dashboard-r2-token\.mjs"[\s\\]+--configuration-only/);
  assert.match(deployHelper, /deploy --prod --skip-domain/);
  assert.doesNotMatch(deployHelper, /--logs/);
  assert.match(deployHelper, /--build-env "SENTRY_RELEASE=\$SENTRY_RELEASE"/);
  assert.match(deployHelper, /--env "SENTRY_RELEASE=\$SENTRY_RELEASE"/);
  const dashboardVercel = read("apps/dashboard/vercel.json");
  assert.match(dashboardVercel, /verify-dashboard-r2-token\.mjs --runtime-if-production/);
  assert.match(deployHelper, /generatedHost/);
  assert.match(deployHelper, /pnpm exec vercel/);
  assert.doesNotMatch(deployHelper, /\bnpx\b|--token/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.doesNotMatch(workflow, /\bnpx\b|--token/);
  const dashboardStage = workflow.slice(
    workflow.indexOf("Stage dashboard at the reviewed commit"),
    workflow.indexOf("Stage marketing at the reviewed commit"),
  );
  assert.doesNotMatch(dashboardStage, /SENTRY_AUTH_TOKEN|SENTRY_ORG|SENTRY_PROJECT/);
  assert.match(dashboardStage, /SENTRY_RELEASE: \$\{\{ github\.sha \}\}/);
  assert.match(
    workflow,
    /AXEL_CANARY_RECEIPT_URL: \$\{\{ steps\.dashboard\.outputs\.url && format\('\{0\}\/api\/ops\/delivery-canary\/receipt\?probe=\{\{probe_id\}\}', steps\.dashboard\.outputs\.url\) \|\| secrets\.AXEL_CANARY_RECEIPT_URL \}\}/,
  );
  const stagedSmoke = workflow.slice(smoke, promote);
  assert.match(stagedSmoke, /AXEL_REQUIRE_OPERATIONAL_STATUS: "1"/);
  assert.match(
    stagedSmoke,
    /AXEL_CANARY_RECEIPT_AUTH_HEADER: \$\{\{ secrets\.AXEL_CANARY_RECEIPT_AUTH_HEADER \}\}/,
  );
  assert.match(
    stagedSmoke,
    /AXEL_CANARY_RECEIPT_AUTH_VALUE: \$\{\{ secrets\.AXEL_CANARY_RECEIPT_AUTH_VALUE \}\}/,
  );
  assert.match(
    stagedSmoke,
    /AXEL_CANARY_RECEIPT_PROTECTION_BYPASS_HEADER: x-vercel-protection-bypass/,
  );
  assert.match(
    stagedSmoke,
    /AXEL_CANARY_RECEIPT_PROTECTION_BYPASS_VALUE: \$\{\{ secrets\.VERCEL_AUTOMATION_BYPASS_SECRET_DASHBOARD \}\}/,
  );

  const productionSmoke = workflow.slice(workflow.indexOf("Smoke production domains"));
  assert.doesNotMatch(productionSmoke, /AXEL_CANARY_RECEIPT_PROTECTION_BYPASS_/);
  assert.match(workflow, /STAGED_URL: \$\{\{ steps\.dashboard\.outputs\.url \}\}/);
  assert.match(workflow, /STAGED_URL: \$\{\{ steps\.marketing\.outputs\.url \}\}/);
  assert.doesNotMatch(workflow, /promote "\$\{\{ steps\.[^.]+\.outputs\.url \}\}"/);
});

test("scheduled operations do not share the reviewer-gated deploy environment", () => {
  assert.match(read(".github/workflows/delivery-canary.yml"), /environment: Monitoring/);
  assert.match(read(".github/workflows/clickhouse-backup.yml"), /environment: Backup/);
});

test("delivery monitoring runs independently of an optional release observation", () => {
  const workflow = read(".github/workflows/delivery-canary.yml");
  assert.match(workflow, /cron: "7,22,37,52 \* \* \* \*"/);
  assert.match(workflow, /^  queue: max$/m);
  assert.match(workflow, /^  cancel-in-progress: false$/m);
  assert.match(workflow, /AXEL_SOAK_CANDIDATE_SHA/);
  assert.match(workflow, /test "\$\{AXEL_SOAK_CANDIDATE_SHA\}" = "\$\{GITHUB_SHA\}"/);
  const [monitoring, observation] = workflow.split("  soak-candidate:");
  assert.match(monitoring, /node scripts\/delivery-canary\.mjs/);
  assert.doesNotMatch(monitoring, /AXEL_SOAK_CANDIDATE_SHA|needs:/);
  assert.match(observation, /vars\.AXEL_SOAK_CANDIDATE_SHA != ''/);
  assert.doesNotMatch(observation, /continue-on-error|needs:/);
  assert.doesNotMatch(workflow, /sentry-cron-checkin\.sh/);
  assert.match(workflow, /authoritative 15-minute cadence runs/);
});

test("protected production smokes require the Sentry transport probe", () => {
  for (const file of [
    ".github/workflows/deploy-cloudflare.yml",
    ".github/workflows/deploy-render.yml",
    ".github/workflows/deploy-vercel.yml",
    ".github/workflows/smoke.yml",
    ".github/workflows/sync-cloudflare-secrets.yml",
  ]) {
    assert.match(read(file), /AXEL_REQUIRE_SENTRY_TEST: "1"/, file);
  }
  assert.match(read("scripts/smoke.sh"), /Sentry transport test is required/);
});

test("Sentry cron check-ins surface rejected HTTP responses without response bodies", () => {
  const script = read("scripts/sentry-cron-checkin.sh");
  assert.match(script, /--fail-with-body/);
  assert.match(script, /--output \/dev\/null/);
  assert.match(script, /::warning::\[sentry-checkin\]/);
});

test("secret mutations cannot race production deploys", () => {
  const cloudflare = read(".github/workflows/sync-cloudflare-secrets.yml");
  assert.match(cloudflare, /^  group: production-deploy$/m);
  assert.match(cloudflare, /^    environment: Production$/m);
  assert.doesNotMatch(cloudflare, /DATABASE_URL|DATABASE_RUNTIME_URL/);
  assert.match(cloudflare, /bash scripts\/smoke\.sh/);
  assert.match(cloudflare, /AXEL_REQUIRE_DELIVERY_CANARY: "1"/);

  const render = read(".github/workflows/sync-render-secrets.yml");
  assert.match(render, /^  group: production-deploy$/m);
  assert.match(
    render,
    /test "\$PRODUCTION_CONFIRMATION" = "save-reviewed-production"/,
  );
  assert.doesNotMatch(render, /DATABASE_URL|DATABASE_RUNTIME_URL/);
  assert.doesNotMatch(render, /\/deploys/);
  assert.doesNotMatch(render, /\/messages\/(pull|ack)/);
  assert.doesNotMatch(render, /^      deploy:$/m);
  assert.match(render, /node scripts\/self-host\/verify-runtime-token\.mjs/);
  assert.match(render, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.match(
    render,
    /CLOUDFLARE_RUNTIME_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_QUEUE_API_TOKEN \}\}/,
  );
  assert.match(render, /RAW_PAYLOAD_BUCKET: axel-events-raw/);
  assert.doesNotMatch(render, /^\s+- all$/m);
  assert.doesNotMatch(render, /axel-clickhouse/);
  assert.doesNotMatch(render, /copy_native_secrets_to_workers|WORKER_SECRET_KEYS|find_service_id/);
  assert.doesNotMatch(render, /bash scripts\/smoke\.sh/);
  assert.equal(
    [...render.matchAll(/run: node scripts\/sync-render-runtime-secrets\.mjs/g)].length,
    3,
  );
  for (const service of [
    "axel-delivery-native",
    "axel-delivery-workers",
    "axel-pull-worker",
  ]) {
    assert.match(render, new RegExp(`^          - ${service}$`, "m"));
    assert.match(render, new RegExp(`RENDER_SERVICE_NAME: ${service}`));
  }
  assert.match(render, /id: mutation_attempt/);
  assert.ok(
    render.indexOf("id: mutation_attempt")
      < render.indexOf("run: node scripts/sync-render-runtime-secrets.mjs"),
  );
  assert.ok(
    render.indexOf("id: mutation_attempt")
      < render.indexOf("run: node scripts/self-host/verify-runtime-token.mjs"),
  );
  assert.match(render, /DELIVERY_QUEUE_ID: \$\{\{ secrets\.DELIVERY_QUEUE_ID \}\}/);
  assert.match(render, /EDGE_DELIVERY_QUEUE_ID: \$\{\{ secrets\.EDGE_DELIVERY_QUEUE_ID \}\}/);
  assert.match(
    render,
    /DELIVERY_SHARED_SECRET_PREVIOUS: \$\{\{ secrets\.DELIVERY_SHARED_SECRET_PREVIOUS \}\}/,
  );
  assert.match(
    render,
    /SOURCE_LOOKUP_SHARED_SECRET_PREVIOUS: \$\{\{ secrets\.SOURCE_LOOKUP_SHARED_SECRET_PREVIOUS \}\}/,
  );
  assert.match(render, /Dispatch Deploy Render Services for the reviewed main commit/);
});

test("only the bounded database workflow can distribute the runtime credential", () => {
  const consumers = listWorkflowFiles().filter((file) =>
    /secrets\.DATABASE_(?:DASHBOARD|DELIVERY_NATIVE|DELIVERY_WORKERS|PULL_WORKER|DELIVERY_EDGE)_URL/.test(
      read(file),
    ),
  );
  assert.deepEqual(consumers, [".github/workflows/sync-database-url.yml"]);

  const workflow = read(consumers[0]);
  assert.equal([...workflow.matchAll(/wrangler secret put DATABASE_URL/g)].length, 1);
  assert.match(workflow, /^  group: production-deploy$/m);
  assert.doesNotMatch(workflow, /^\s+- all$/m);
});

test("delivery canary settings target only the immutable singleton worker", () => {
  const render = read(".github/workflows/sync-render-canary-settings.yml");
  const genericRenderSync = read(".github/workflows/sync-render-secrets.yml");
  assert.doesNotMatch(genericRenderSync, /AXEL_CANARY_/);
  assert.match(render, /^  group: production-deploy$/m);
  assert.match(render, /^    environment: Production$/m);
  assert.match(render, /RENDER_OWNER_ID: \$\{\{ vars\.RENDER_OWNER_ID \}\}/);
  assert.match(
    render,
    /RENDER_DELIVERY_WORKERS_SERVICE_ID: \$\{\{ vars\.RENDER_DELIVERY_WORKERS_SERVICE_ID \}\}/,
  );
  assert.match(
    render,
    /RENDER_DELIVERY_WORKERS_BLUEPRINT_ID: \$\{\{ vars\.RENDER_DELIVERY_WORKERS_BLUEPRINT_ID \}\}/,
  );
  assert.match(
    render,
    /RENDER_DELIVERY_WORKERS_BLUEPRINT_REPOSITORY: \$\{\{ secrets\.RENDER_DELIVERY_WORKERS_BLUEPRINT_REPOSITORY \}\}/,
  );
  assert.doesNotMatch(render, /^      RENDER_DELIVERY_WORKERS_BLUEPRINT_REPOSITORY:/m);
  assert.match(render, /save-worker-canary-settings/);
  assert.match(render, /node scripts\/sync-render-canary-settings\.mjs/);
  assert.doesNotMatch(render, /\/deploys/);
  assert.doesNotMatch(render, /\/messages\/(pull|ack)/);
  assert.doesNotMatch(render, /^      deploy:$/m);
  assert.doesNotMatch(render, /inputs\.service/);
  assert.match(render, /AXEL_CANARY_ENABLED: "1"/);
  assert.match(render, /AXEL_CANARY_INTERVAL_MS: "900000"/);
  for (const key of [
    "AXEL_CANARY_INGEST_URL",
    "AXEL_CANARY_INGEST_AUTH_HEADER",
    "AXEL_CANARY_INGEST_AUTH_VALUE",
    "AXEL_CANARY_RECEIPT_URL",
    "AXEL_CANARY_RECEIPT_AUTH_HEADER",
    "AXEL_CANARY_RECEIPT_AUTH_VALUE",
  ]) {
    assert.match(render, new RegExp(`${key}: \\$\\{\\{ secrets\\.${key} \\}\\}`));
  }
  const referencedSecrets = [...render.matchAll(/secrets\.([A-Z0-9_]+)/g)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(referencedSecrets, [
    "AXEL_CANARY_INGEST_AUTH_HEADER",
    "AXEL_CANARY_INGEST_AUTH_VALUE",
    "AXEL_CANARY_INGEST_URL",
    "AXEL_CANARY_RECEIPT_AUTH_HEADER",
    "AXEL_CANARY_RECEIPT_AUTH_VALUE",
    "AXEL_CANARY_RECEIPT_URL",
    "RENDER_API_KEY",
    "RENDER_DELIVERY_WORKERS_BLUEPRINT_REPOSITORY",
  ]);
  assert.doesNotMatch(
    render,
    /DATABASE_URL|CLICKHOUSE_|CLOUDFLARE_|DELIVERY_QUEUE_ID|EDGE_DELIVERY_QUEUE_ID|DELIVERY_SHARED_SECRET|SOURCE_LOOKUP_SHARED_SECRET|SENTRY_|CREDENTIALS_MASTER_KEY/,
  );
  assert.match(render, /Render UI for an exact-SHA, worker-only manual deploy/);
});

test("delivery-canary hotfix runbook permits only an exact-SHA worker UI deploy", () => {
  const runbook = read("docs/runbook-delivery-canary.md");
  assert.match(runbook, /gh workflow run sync-render-canary-settings\.yml --ref main/);
  assert.match(runbook, /RENDER_DELIVERY_WORKERS_SERVICE_ID/);
  assert.match(runbook, /All four bindings are mandatory/);
  assert.match(runbook, /lowercase bare `owner\/repo`/);
  assert.match(runbook, /Deploy a specific commit/);
  assert.match(runbook, /full hotfix SHA from `main`/);
  assert.match(runbook, /Deploy that worker\s+only/);
  assert.match(runbook, /Never dispatch `\.github\/workflows\/deploy-render\.yml`/);
  assert.match(runbook, /Do not dispatch\s+`\.github\/workflows\/sync-render-secrets\.yml`/);
  assert.doesNotMatch(runbook, /gh workflow run deploy-render\.yml/);
  assert.doesNotMatch(runbook, /gh workflow run sync-render-secrets\.yml/);
  assert.doesNotMatch(runbook, /-f service=all/);
  assert.doesNotMatch(runbook, /for render_service/);
});

test("production mutations and provider requests have finite deadlines", () => {
  for (const file of [
    ".github/workflows/deploy-cloudflare.yml",
    ".github/workflows/deploy-render.yml",
    ".github/workflows/deploy-vercel.yml",
    ".github/workflows/smoke.yml",
    ".github/workflows/sync-cloudflare-secrets.yml",
    ".github/workflows/sync-database-url.yml",
    ".github/workflows/sync-render-secrets.yml",
    ".github/workflows/sync-render-canary-settings.yml",
    ".github/workflows/migrate-postgres-run.yml",
    ".github/workflows/migrate-postgres.yml",
    ".github/workflows/migrate-clickhouse.yml",
  ]) {
    assert.match(read(file), /^    timeout-minutes: [1-9][0-9]*$/m, file);
  }
  const smokeScript = read("scripts/smoke.sh");
  assert.match(smokeScript, /--connect-timeout 10 --max-time 30/);
  assert.match(smokeScript, /mktemp -d \/tmp\/axel-smoke\.XXXXXX/);
  assert.match(smokeScript, /set \+x/);
  assert.doesNotMatch(smokeScript, /head -c|\/tmp\/axel-smoke-(?:body|sentry|ingest)/);
  for (const file of [
    "scripts/harden-render-auto-deploy.sh",
    "scripts/deploy-render-service.sh",
  ]) {
    const script = read(file);
    assert.match(script, /--connect-timeout 10/);
    assert.match(script, /--max-time 45/);
  }
  assert.match(read("scripts/harden-cloudflare-native-queue.mjs"), /AbortController/);
});

test("write-capable pull_request_target automations reject forks", () => {
  for (const file of [
    ".github/workflows/auto-merge-linear.yml",
    ".github/workflows/linear-pr-sync.yml",
  ]) {
    const workflow = read(file);
    assert.match(workflow, /if: \$\{\{ github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
    assert.match(workflow, /^    environment: Automation$/m);
  }
});

test("auto-merge only grants its write token to the current maintainer", () => {
  const workflow = read(".github/workflows/auto-merge-linear.yml");
  assert.match(workflow, /github\.event\.pull_request\.user\.login == '10-01'/);
  assert.match(workflow, /PR_AUTHOR: \$\{\{ github\.event\.pull_request\.user\.login \}\}/);
  assert.match(workflow, /if \[ "\$PR_AUTHOR" != "10-01" \]; then/);
});

test("Linear sync only grants its private workspace key to the current maintainer", () => {
  const workflow = read(".github/workflows/linear-pr-sync.yml");
  assert.match(workflow, /github\.event\.pull_request\.user\.login == '10-01'/);
});

test("release verification is bounded, auditable, and matches the CI audit floor", () => {
  const workflow = read(".github/workflows/release.yml");
  const verifier = read("scripts/release-verify.mjs");

  assert.match(workflow, /^    timeout-minutes: 90$/m);
  assert.match(workflow, /name: Upload release verification ledger/);
  assert.match(workflow, /path: \$\{\{ runner\.temp \}\}\/release-ledger/);
  assert.match(workflow, /retention-days: 30/);
  assert.match(verifier, /pnpm audit --audit-level low --json/);
  assert.match(verifier, /resolveVersion\(\{ allowWrite: !values\["dry-run"\] \}\)/);
  assert.match(verifier, /resolve\(REPO_ROOT, values\.out \|\| "artifacts\/release-ledger"\)/);
});

test("database credential distribution is explicit, serialized, and value-safe", () => {
  const workflow = read(".github/workflows/sync-database-url.yml");
  assert.match(workflow, /^name: Sync Production Database Credential$/m);
  assert.match(workflow, /^  workflow_dispatch:$/m);
  assert.doesNotMatch(workflow, /^  push:$/m);
  assert.match(workflow, /^  group: production-deploy$/m);
  assert.match(workflow, /^  cancel-in-progress: false$/m);
  assert.match(workflow, /^  contents: read$/m);
  assert.match(workflow, /^    if: \$\{\{ github\.ref == 'refs\/heads\/main' \}\}$/m);
  assert.match(workflow, /^    environment: Production$/m);
  assert.match(workflow, /^    timeout-minutes: [1-9][0-9]*$/m);

  const inputs = workflow.slice(
    workflow.indexOf("    inputs:"),
    workflow.indexOf("\nconcurrency:"),
  );
  assert.deepEqual(
    [...inputs.matchAll(/^      ([a-z][a-z0-9_-]+):$/gm)].map((match) => match[1]),
    ["reason", "target"],
  );
  const reason = inputs.slice(
    inputs.indexOf("      reason:"),
    inputs.indexOf("      target:"),
  );
  assert.match(reason, /^        required: true$/m);
  assert.match(reason, /^        type: string$/m);
  assert.match(reason, /Non-secret change record; do not include credentials/);
  const target = inputs.slice(inputs.indexOf("      target:"));
  assert.match(target, /^        required: true$/m);
  assert.match(target, /^        type: choice$/m);
  assert.deepEqual(
    [...target.matchAll(/^          - ([a-z][a-z0-9-]+)$/gm)].map((match) => match[1]),
    [
      "vercel-dashboard",
      "render-delivery-native",
      "render-delivery-workers",
      "render-pull-worker",
      "cloudflare-delivery-edge",
    ],
  );
  assert.doesNotMatch(target, /^\s+- all$/m);
  assert.doesNotMatch(workflow, /cloudflare-ingest-worker|apps\/ingest-worker/);
  assert.match(workflow, /run: node scripts\/verify-database-service-role\.mjs/);
  assert.equal(
    [...workflow.matchAll(/run: node scripts\/verify-database-service-role\.mjs/g)].length,
    5,
  );
  assert.ok(
    workflow.indexOf("verify-database-service-role.mjs")
      < workflow.indexOf("Save on the Vercel dashboard project"),
  );
  for (const [preflightSecret, runtimeSecret, profile] of [
    ["DATABASE_DASHBOARD_URL", "DATABASE_DASHBOARD_URL", "dashboard"],
    ["DATABASE_DELIVERY_NATIVE_PREFLIGHT_URL", "DATABASE_DELIVERY_NATIVE_URL", "delivery-native"],
    ["DATABASE_DELIVERY_WORKERS_PREFLIGHT_URL", "DATABASE_DELIVERY_WORKERS_URL", "delivery-workers"],
    ["DATABASE_PULL_WORKER_PREFLIGHT_URL", "DATABASE_PULL_WORKER_URL", "pull-worker"],
    ["DATABASE_DELIVERY_EDGE_URL", "DATABASE_DELIVERY_EDGE_URL", "delivery-edge"],
  ]) {
    if (preflightSecret === runtimeSecret) {
      assert.equal(
        [...workflow.matchAll(new RegExp(`secrets\\.${preflightSecret}`, "g"))].length,
        2,
        `${preflightSecret} is exposed only to its verification and provider-save steps`,
      );
    } else {
      assert.equal(
        [...workflow.matchAll(new RegExp(`secrets\\.${preflightSecret}`, "g"))].length,
        1,
        `${preflightSecret} is exposed only to its external verification step`,
      );
      assert.equal(
        [...workflow.matchAll(new RegExp(`secrets\\.${runtimeSecret}`, "g"))].length,
        1,
        `${runtimeSecret} is exposed only to its internal provider-save step`,
      );
    }
    assert.match(workflow, new RegExp(`DATABASE_SERVICE_PROFILE: ${profile}`));
  }
  assert.match(
    workflow,
    /DATABASE_SERVICE_REQUIRE_FINAL_STATE: \$\{\{ vars\.DATABASE_SERVICE_REQUIRE_FINAL_STATE \}\}/,
  );
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.doesNotMatch(workflow, /npx --yes/);

  assert.doesNotMatch(workflow, /--token(?:=|\s)/);
  assert.doesNotMatch(workflow, /jq[^\n]*--arg[^\n]*\$DATABASE_URL/);
  assert.doesNotMatch(workflow, /(?:echo|npx|curl|wrangler)[^\n]*"\$DATABASE_URL"/);
  assert.doesNotMatch(workflow, /set -[^\n]*x/);

  const vercel = workflow.slice(
    workflow.indexOf("- name: Save on the Vercel dashboard project"),
    workflow.indexOf("- name: Save on the native delivery Render service"),
  );
  assert.match(vercel, /VERCEL_TOKEN: \$\{\{ secrets\.VERCEL_TOKEN \}\}/);
  assert.match(vercel, /export VERCEL_PROJECT_ID="\$VERCEL_PROJECT_ID_DASHBOARD"/);
  assert.match(vercel, /VERCEL_PROJECT_ID_DASHBOARD/);
  assert.doesNotMatch(vercel, /VERCEL_PROJECT_ID_MARKETING|marketing/);
  assert.match(vercel, /> \.vercel\/project\.json/);
  assert.match(
    vercel,
    /printf '%s' "\$DATABASE_RUNTIME_URL"[\s\\]+\| pnpm exec vercel env add DATABASE_URL production --sensitive --force --yes/,
  );

  const render = workflow.slice(
    workflow.indexOf("- name: Save on the native delivery Render service"),
    workflow.indexOf("- name: Save on the delivery edge Cloudflare Worker"),
  );
  assert.match(render, /DATABASE_RUNTIME_URL: \$\{\{ secrets\.DATABASE_DELIVERY_NATIVE_URL \}\}/);
  assert.match(render, /DATABASE_RUNTIME_URL: \$\{\{ secrets\.DATABASE_DELIVERY_WORKERS_URL \}\}/);
  assert.match(render, /DATABASE_RUNTIME_URL: \$\{\{ secrets\.DATABASE_PULL_WORKER_URL \}\}/);
  assert.match(render, /RENDER_API_KEY: \$\{\{ secrets\.RENDER_API_KEY \}\}/);
  assert.match(render, /RENDER_SERVICE_NAME: axel-delivery-native/);
  assert.match(render, /RENDER_SERVICE_NAME: axel-delivery-workers/);
  assert.match(render, /RENDER_SERVICE_NAME: axel-pull-worker/);
  assert.match(render, /node scripts\/sync-render-database-url\.mjs/);
  assert.equal([...render.matchAll(/echo "saved=true" >> "\$GITHUB_OUTPUT"/g)].length, 3);
  for (const service of ["native", "workers", "pull"]) {
    const stepStart = render.indexOf(`id: render_${service}_secret`);
    const nextStep = render.indexOf("- name:", stepStart);
    const step = render.slice(stepStart, nextStep);
    assert.ok(
      step.indexOf("node scripts/sync-render-database-url.mjs") <
        step.indexOf('echo "saved=true" >> "$GITHUB_OUTPUT"'),
      `${service} reports success only after the provider save completes`,
    );
  }
  assert.match(render, /deploy-render-service\.sh "\$render_service" "\$GITHUB_SHA" --force-redeploy/);
  assert.match(render, /steps\.render_native_secret\.outputs\.saved == 'true'/);
  assert.match(render, /steps\.render_workers_secret\.outputs\.saved == 'true'/);
  assert.match(render, /steps\.render_pull_secret\.outputs\.saved == 'true'/);
  assert.doesNotMatch(render, /always\(\)|outputs\.attempted/);
  assert.match(render, /Verify the activated Render runtime end to end/);
  assert.doesNotMatch(render, /curl|Authorization:|\/deploys|\bPOST\b|\bPATCH\b/);

  const cloudflare = workflow.slice(
    workflow.indexOf("- name: Save on the delivery edge Cloudflare Worker"),
  );
  assert.match(cloudflare, /pnpm --dir apps\/delivery-edge exec wrangler secret put DATABASE_URL/);
  assert.doesNotMatch(cloudflare, /ingest-worker/);
  assert.doesNotMatch(cloudflare, /router-edge/);
  assert.equal(
    [...cloudflare.matchAll(/wrangler secret put DATABASE_URL/g)].length,
    1,
    "the single Worker write updates delivery-edge only",
  );
  assert.equal([...cloudflare.matchAll(/wrangler secret list --format json/g)].length, 1);
  assert.match(cloudflare, /\.map\(\(entry\) => entry\.name\)/);
  assert.doesNotMatch(cloudflare, /entry\.value/);
  assert.match(cloudflare, /^        id: cloudflare_secret$/m);
  assert.ok(
    cloudflare.indexOf("wrangler secret list --format json") <
      cloudflare.indexOf('echo "saved=true" >> "$GITHUB_OUTPUT"'),
    "Cloudflare reports success only after the saved binding is verified",
  );
  assert.match(cloudflare, /Verify the activated Cloudflare runtime end to end/);
  assert.match(
    cloudflare,
    /if: \$\{\{ inputs\.target == 'cloudflare-delivery-edge' && steps\.cloudflare_secret\.outputs\.saved == 'true' \}\}/,
  );
  assert.doesNotMatch(cloudflare, /always\(\)|outputs\.attempted/);
  assert.match(cloudflare, /bash scripts\/smoke\.sh/);
  assert.match(cloudflare, /AXEL_REQUIRE_DELIVERY_CANARY: "1"/);
  assert.match(cloudflare, /AXEL_REQUIRE_SENTRY_TEST: "1"/);
  assert.match(workflow, /pnpm\/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86/);
  assert.match(workflow, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/);
  assert.match(workflow, /^          version: 9\.12\.0$/m);
});

test("production database owner and runtime credentials stay separated", () => {
  const migrationWorkflows = [
    ".github/workflows/deploy-cloudflare.yml",
    ".github/workflows/deploy-render.yml",
    ".github/workflows/deploy-vercel.yml",
    ".github/workflows/migrate-postgres-run.yml",
    ".github/workflows/migrate-postgres.yml",
  ];
  for (const file of migrationWorkflows) {
    const workflow = read(file);
    assert.match(workflow, /DATABASE_URL: \$\{\{ secrets\.DATABASE_MIGRATION_URL \}\}/, file);
    assert.match(
      workflow,
      /DATABASE_MIGRATION_ROLE: \$\{\{ vars\.DATABASE_MIGRATION_ROLE \}\}/,
      file,
    );
    assert.match(
      workflow,
      /DATABASE_MIGRATION_LOGIN_ROLE: \$\{\{ vars\.DATABASE_MIGRATION_LOGIN_ROLE \}\}/,
      file,
    );
    assert.match(
      workflow,
      /DATABASE_MIGRATION_OWNER_CAN_CREATE_ROLES: \$\{\{ vars\.DATABASE_MIGRATION_OWNER_CAN_CREATE_ROLES \}\}/,
      file,
    );
    assert.match(
      workflow,
      /DATABASE_MIGRATION_EXISTING_LOGIN_ROLES: \$\{\{ vars\.DATABASE_MIGRATION_EXISTING_LOGIN_ROLES \}\}/,
      file,
    );
    assert.match(
      workflow,
      /DATABASE_MIGRATION_OWNER_PARENT_ROLES: \$\{\{ vars\.DATABASE_MIGRATION_OWNER_PARENT_ROLES \}\}/,
      file,
    );
    assert.match(
      workflow,
      /DATABASE_RUNTIME_CAPABILITY_ROLES: \$\{\{ vars\.DATABASE_RUNTIME_CAPABILITY_ROLES \}\}/,
      file,
    );
    assert.match(
      workflow,
      /DATABASE_VERIFY_CAPABILITY_ROLE: \$\{\{ vars\.DATABASE_VERIFY_CAPABILITY_ROLE \}\}/,
      file,
    );
    assert.match(workflow, /DATABASE_MIGRATION_ROLE_REQUIRED: "1"/, file);
    assert.doesNotMatch(workflow, /secrets\.DATABASE_RUNTIME_URL/, file);
  }
  const migrationRunner = read("scripts/run-migrations.sh");
  assert.match(
    migrationRunner,
    /-v expected_runtime_capability_roles_csv="\$expected_runtime_capabilities"/,
  );
  assert.match(
    migrationRunner,
    /-v expected_verify_capability_role="\$DATABASE_VERIFY_CAPABILITY_ROLE"/,
  );
  const migrationVerifier = read("scripts/verify-database-migration-role.sql");
  assert.match(migrationVerifier, /:'expected_runtime_capability_roles_csv'/);
  assert.match(migrationVerifier, /:'expected_verify_capability_role'/);
  assert.doesNotMatch(migrationVerifier, /'axel_runtime'|'axel_verify'/);

  const runtimeWorkflows = [".github/workflows/sync-database-url.yml"];
  for (const file of runtimeWorkflows) {
    const workflow = read(file);
    assert.doesNotMatch(workflow, /secrets\.DATABASE_RUNTIME_URL/, file);
    for (const stem of [
      "DASHBOARD",
      "DELIVERY_NATIVE",
      "DELIVERY_WORKERS",
      "PULL_WORKER",
      "DELIVERY_EDGE",
    ]) {
      assert.match(workflow, new RegExp(`secrets\\.DATABASE_${stem}_URL`), file);
      assert.match(
        workflow,
        new RegExp(`DATABASE_${stem}_CAPABILITY_ROLE: \\$\\{\\{ vars\\.DATABASE_${stem}_CAPABILITY_ROLE \\}\\}`),
        file,
      );
      assert.match(
        workflow,
        new RegExp(`DATABASE_${stem}_LOGIN_ROLE: \\$\\{\\{ vars\\.DATABASE_${stem}_LOGIN_ROLE \\}\\}`),
        file,
      );
    }
    assert.match(
      workflow,
      /DATABASE_MIGRATION_ROLE: \$\{\{ vars\.DATABASE_MIGRATION_ROLE \}\}/,
      file,
    );
    assert.match(
      workflow,
      /DATABASE_VERIFY_CAPABILITY_ROLE: \$\{\{ vars\.DATABASE_VERIFY_CAPABILITY_ROLE \}\}/,
      file,
    );
    assert.match(
      workflow,
      /DATABASE_MIGRATION_LOGIN_ROLE: \$\{\{ vars\.DATABASE_MIGRATION_LOGIN_ROLE \}\}/,
      file,
    );
    assert.match(
      workflow,
      /DATABASE_MIGRATION_EXISTING_LOGIN_ROLES: \$\{\{ vars\.DATABASE_MIGRATION_EXISTING_LOGIN_ROLES \}\}/,
      file,
    );
    assert.doesNotMatch(workflow, /secrets\.DATABASE_MIGRATION_URL/, file);
  }

  const verifier = read(".github/workflows/verify-postgres-tables.yml");
  assert.match(verifier, /DATABASE_URL: \$\{\{ secrets\.DATABASE_VERIFY_URL \}\}/);
  assert.match(verifier, /DATABASE_SERVICE_URL: \$\{\{ secrets\.DATABASE_VERIFY_URL \}\}/);
  assert.match(
    verifier,
    /DATABASE_SERVICE_EXPECTED_CONNECTION_ROLE: \$\{\{ vars\.DATABASE_VERIFY_LOGIN_ROLE \}\}/,
  );
  assert.match(
    verifier,
    /DATABASE_VERIFY_CAPABILITY_ROLE: \$\{\{ vars\.DATABASE_VERIFY_CAPABILITY_ROLE \}\}/,
  );
  assert.match(
    verifier,
    /DATABASE_MIGRATION_ROLE: \$\{\{ vars\.DATABASE_MIGRATION_ROLE \}\}/,
  );
  assert.match(
    verifier,
    /DATABASE_VERIFY_EXISTING_LOGIN_ROLES: \$\{\{ vars\.DATABASE_VERIFY_EXISTING_LOGIN_ROLES \}\}/,
  );
  assert.doesNotMatch(verifier, /vars\.DATABASE_VERIFY_ROLE/);
  assert.match(
    verifier,
    /DATABASE_DASHBOARD_CAPABILITY_ROLE: \$\{\{ vars\.DATABASE_DASHBOARD_CAPABILITY_ROLE \}\}/,
  );
  assert.match(
    verifier,
    /DATABASE_MIGRATION_LOGIN_ROLE: \$\{\{ vars\.DATABASE_MIGRATION_LOGIN_ROLE \}\}/,
  );
  assert.match(
    verifier,
    /DATABASE_MIGRATION_EXISTING_LOGIN_ROLES: \$\{\{ vars\.DATABASE_MIGRATION_EXISTING_LOGIN_ROLES \}\}/,
  );
  assert.match(verifier, /node scripts\/verify-database-service-role\.mjs/);
  assert.doesNotMatch(verifier, /verify-database-metadata-role\.sql/);
  assert.doesNotMatch(verifier, /COUNT\(\*\)|secrets\.DATABASE_RUNTIME_URL/);

  for (const file of listWorkflowFiles()) {
    assert.doesNotMatch(read(file), /secrets\.DATABASE_URL\b/, file);
  }
});

test("public issue intake rejects sensitive diagnostics and blank reports", () => {
  const bugTemplate = read(".github/ISSUE_TEMPLATE/bug_report.yml");
  const issueConfig = read(".github/ISSUE_TEMPLATE/config.yml");
  const pullRequestTemplate = read(".github/pull_request_template.md");

  assert.match(bugTemplate, /GitHub issues are public/);
  assert.match(bugTemplate, /Use synthetic data only/);
  assert.match(bugTemplate, /This is not a suspected security vulnerability/);
  assert.doesNotMatch(bugTemplate, /include the destination type and the delivery\/event ID/);
  assert.match(issueConfig, /^blank_issues_enabled: false$/m);
  assert.match(pullRequestTemplate, /Closes #___/);
  assert.doesNotMatch(pullRequestTemplate, /ROL-|Linear/i);
});

test("public Postman files expose source ingest only", () => {
  const collection = JSON.parse(read("docs/postman/axel-webhooks.postman_collection.json"));
  const environment = JSON.parse(read("docs/postman/axel-webhooks.postman_environment.json"));
  const serialized = JSON.stringify({ collection, environment });

  assert.deepEqual(
    environment.values.map((entry) => entry.key),
    ["baseUrl", "sourceId", "sourceToken"],
  );
  assert.doesNotMatch(serialized, /adminToken|ADMIN_TOKEN|x-axel-admin-token|secret_token/);
  assert.doesNotMatch(serialized, /\/admin\//);
  assert.doesNotMatch(serialized, /https:\/\/(?:webhook\.site|requestbin\.com|httpbin\.org)/i);
  assert.doesNotMatch(serialized, /ngrok/i);
  assert.match(serialized, /disposable source/);
  assert.match(serialized, /synthetic/);
});

test("public security and self-hosting claims stay within implemented guarantees", () => {
  const securityPage = read("apps/marketing/app/security/page.tsx");
  const selfHosting = read("docs/self-hosting.md");
  const contributing = read("CONTRIBUTING.md");
  const securityReview = read("docs/security-review-2026-08.md");
  const ci = read(".github/workflows/ci.yml");

  assert.doesNotMatch(securityPage, /customer-managed encryption keys/i);
  assert.doesNotMatch(securityPage, /every privileged action/i);
  assert.doesNotMatch(securityPage, /append-only/i);
  assert.doesNotMatch(securityPage, /every version.*adversarial audit/i);
  assert.doesNotMatch(securityPage, /Tokens are never written to logs/i);
  assert.match(securityPage, /Self-host operators remain responsible for encryption/);
  assert.match(securityPage, /Audit records for administrative changes/);

  assert.match(selfHosting, /limits each HTTP Worker request to 10 ms of CPU time/);
  assert.match(selfHosting, /first-use subdomain prompt/);
  assert.match(selfHosting, /can return 523 for about a minute/);
  assert.doesNotMatch(contributing, /docker compose up -d`, then run/);
  assert.match(contributing, /does not create Axel's protected database/);

  assert.doesNotMatch(securityReview, /base images\s+are still selected by mutable release tags/i);
  assert.match(securityReview, /third-party container reference now uses an immutable digest/);
  assert.match(
    ci,
    /image: postgres:16@sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94/,
  );
});
