import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) => readFileSync(path.join(root, file), "utf8");

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

test("standalone production smoke is an explicit protected operation", () => {
  const smoke = read(".github/workflows/smoke.yml");
  assert.match(smoke, /^name: Production Smoke$/m);
  assert.match(smoke, /^  workflow_dispatch:$/m);
  assert.doesNotMatch(smoke, /^  push:$/m);
  assert.match(smoke, /^  group: production-deploy$/m);
  assert.match(smoke, /^    environment: Production$/m);
  assert.match(smoke, /github\.ref == 'refs\/heads\/main'/);
  assert.match(smoke, /bash scripts\/smoke\.sh/);
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
    assert.doesNotMatch(config.installCommand, /@latest/);
  }
  const render = read("render.yaml");
  assert.doesNotMatch(render, /^\s*autoDeploy:\s*true\s*$/m);
  assert.doesNotMatch(render, /^\s*autoDeployTrigger:\s*(commit|checksPass)\s*$/m);
  assert.match(render, /^\s*autoDeployTrigger:\s*off\s*$/m);
  const renderWorkflow = read(".github/workflows/deploy-render.yml");
  assert.match(renderWorkflow, /bash scripts\/harden-render-auto-deploy\.sh/);
  assert.ok(
    renderWorkflow.indexOf("harden-render-auto-deploy.sh")
      < renderWorkflow.indexOf("deploy-render-service.sh"),
    "Render provider state is hardened before deployment",
  );
  assert.match(renderWorkflow, /^          - axel-clickhouse$/m);
  assert.match(
    renderWorkflow,
    /CLICKHOUSE_CONFIRMATION: \$\{\{ inputs\.confirm_clickhouse \}\}/,
  );
  assert.match(renderWorkflow, /test "\$CLICKHOUSE_CONFIRMATION" = "deploy-stateful-clickhouse"/);

  const clickhouseStepStart = renderWorkflow.indexOf("- name: Deploy axel-clickhouse");
  const clickhouseStepEnd = renderWorkflow.indexOf("\n      - name:", clickhouseStepStart + 1);
  const clickhouseStep = renderWorkflow.slice(clickhouseStepStart, clickhouseStepEnd);
  assert.match(clickhouseStep, /if: \$\{\{ inputs\.service == 'axel-clickhouse' \}\}/);
  assert.doesNotMatch(clickhouseStep, /inputs\.service == 'all'/);
  assert.match(
    clickhouseStep,
    /deploy-render-service\.sh axel-clickhouse "\$GITHUB_SHA"/,
  );
  assert.match(read("docs/runbook-clickhouse-migration.md"), /The `all` option deliberately excludes ClickHouse/);
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
  const promote = workflow.indexOf("vercel@58.4.0 promote");
  assert.ok(stage >= 0 && stage < smoke && smoke < promote);
  const deployHelper = read("scripts/vercel-preview-deploy.sh");
  assert.match(deployHelper, /--prod --skip-domain/);
  assert.match(deployHelper, /export VERCEL=1/);
  assert.match(deployHelper, /export VERCEL_ENV="\$environment"/);
  assert.match(deployHelper, /export CI=1/);
  assert.match(deployHelper, /export VERCEL_GIT_COMMIT_SHA="\$SENTRY_RELEASE"/);
  assert.match(deployHelper, /generatedHost/);
  const dashboardStage = workflow.slice(
    workflow.indexOf("Stage dashboard at the reviewed commit"),
    workflow.indexOf("Stage marketing at the reviewed commit"),
  );
  assert.match(dashboardStage, /SENTRY_AUTH_TOKEN: \$\{\{ secrets\.SENTRY_AUTH_TOKEN \}\}/);
  assert.match(dashboardStage, /SENTRY_RELEASE: \$\{\{ github\.sha \}\}/);
  assert.match(
    workflow,
    /AXEL_CANARY_RECEIPT_URL: \$\{\{ steps\.dashboard\.outputs\.url \}\}\/api\/ops\/delivery-canary\/receipt\?probe=\{probe_id\}/,
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
  assert.match(cloudflare, /bash scripts\/smoke\.sh/);
  assert.match(cloudflare, /AXEL_REQUIRE_DELIVERY_CANARY: "1"/);

  const render = read(".github/workflows/sync-render-secrets.yml");
  assert.match(render, /^  group: production-deploy$/m);
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
  assert.match(render, /expected exactly one Render service named \$\{name\}; found \$\{match_count\}/);
  assert.match(render, /\^srv-\[A-Za-z0-9_\-\]\+\$/);
  assert.doesNotMatch(render, /head -n 1/);
  assert.doesNotMatch(
    render,
    /WORKER_SECRET_KEYS="[^"]*CLOUDFLARE_(?:ACCOUNT_ID|API_TOKEN)/,
  );
  const workerCopy = render.slice(
    render.indexOf("copy_native_secrets_to_workers()"),
    render.indexOf("if [ \"$SERVICE\" = \"all\" ]"),
  );
  assert.match(workerCopy, /put_env "\$dst_id" CLOUDFLARE_ACCOUNT_ID "\$CLOUDFLARE_ACCOUNT_ID"/);
  assert.match(workerCopy, /put_env "\$dst_id" CLOUDFLARE_API_TOKEN "\$CLOUDFLARE_QUEUE_API_TOKEN"/);
  assert.doesNotMatch(workerCopy, /env-vars\?limit=/);
  assert.match(workerCopy, /env-vars\/\$\{key\}/);
  assert.match(render, /Dispatch Deploy Render Services for the reviewed main commit/);
});

test("production mutations and provider requests have finite deadlines", () => {
  for (const file of [
    ".github/workflows/deploy-cloudflare.yml",
    ".github/workflows/deploy-render.yml",
    ".github/workflows/deploy-vercel.yml",
    ".github/workflows/smoke.yml",
    ".github/workflows/sync-cloudflare-secrets.yml",
    ".github/workflows/sync-render-secrets.yml",
    ".github/workflows/migrate-postgres-run.yml",
    ".github/workflows/migrate-postgres.yml",
    ".github/workflows/migrate-clickhouse.yml",
  ]) {
    assert.match(read(file), /^    timeout-minutes: [1-9][0-9]*$/m, file);
  }
  assert.match(read("scripts/smoke.sh"), /--connect-timeout 10 --max-time 30/);
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
    assert.match(read(file), /if: \$\{\{ github\.event\.pull_request\.head\.repo\.full_name == github\.repository \}\}/);
  }
});
