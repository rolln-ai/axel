import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ACTION_WORKFLOWS,
  VERCEL_ENVIRONMENTS,
  changedFilesBetween,
  classifyDeploymentStatus,
  classifyWorkflowRun,
  requiredActionWorkflows,
  waitForProductionDeploys,
} from "../wait-for-production-deploys.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RELEASE_SHA = "a".repeat(40);

function pushPathsFromWorkflow(filename) {
  const source = readFileSync(path.join(REPO_ROOT, ".github/workflows", filename), "utf8");
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === "    paths:");
  assert.notEqual(start, -1, `${filename} has a push.paths block`);

  const paths = [];
  for (const line of lines.slice(start + 1)) {
    const item = line.match(/^      - (.+)$/)?.[1];
    if (item) {
      paths.push(item.replace(/^(['"])(.*)\1$/, "$2"));
      continue;
    }
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!line.startsWith("      ")) break;
  }
  return paths;
}

function vercelDeployment(environment, id) {
  return {
    id,
    sha: RELEASE_SHA,
    environment,
    created_at: "2026-08-26T18:40:00.000Z",
    creator: { login: "vercel[bot]" },
  };
}

function vercelSuccessApi(overrides = {}) {
  return async (pathname, query) => {
    if (pathname.endsWith("/deployments")) {
      const index = VERCEL_ENVIRONMENTS.indexOf(query.environment);
      return [vercelDeployment(query.environment, index + 10)];
    }
    if (pathname.includes("/deployments/") && pathname.endsWith("/statuses")) {
      return [
        {
          id: 20,
          state: "success",
          created_at: "2026-08-26T18:41:00.000Z",
          environment_url: "https://example.vercel.app",
        },
      ];
    }
    return overrides.workflow?.(pathname, query) ?? { workflow_runs: [] };
  };
}

test("Actions path contracts match the deployment workflows", () => {
  for (const workflow of ACTION_WORKFLOWS) {
    assert.deepEqual([...workflow.paths], pushPathsFromWorkflow(workflow.workflow));
  }
});

test("post-merge smoke uses the exact deployment gate with read-only permissions", () => {
  const source = readFileSync(
    path.join(REPO_ROOT, ".github/workflows/post-merge-smoke.yml"),
    "utf8",
  );
  assert.match(source, /^  actions: read$/m);
  assert.match(source, /^  deployments: read$/m);
  assert.match(source, /^  cancel-in-progress: true$/m);
  assert.match(source, /^    if: \$\{\{ github\.repository == 'rolln-ai\/axel' \}\}$/m);
  assert.match(source, /^          fetch-depth: 0$/m);
  assert.match(source, /node scripts\/wait-for-production-deploys\.mjs/);
  assert.doesNotMatch(source, /sleep 120/);
});

test("changed paths select only deployment workflows that GitHub triggers", () => {
  assert.deepEqual(
    requiredActionWorkflows(["apps/dashboard/app/status/page.tsx"]).map(({ key }) => key),
    ["render"],
  );
  assert.deepEqual(
    requiredActionWorkflows(["apps/ingest-worker/src/index.ts"]).map(({ key }) => key),
    ["cloudflare"],
  );
  assert.deepEqual(
    requiredActionWorkflows(["packages/shared/src/index.ts"]).map(({ key }) => key),
    ["cloudflare", "render"],
  );
  assert.deepEqual(requiredActionWorkflows(["README.md"]), []);
  assert.deepEqual(
    requiredActionWorkflows(null).map(({ key }) => key),
    ["cloudflare", "render"],
  );
});

test("push diff lookup uses a null-delimited, rename-safe range", () => {
  let invocation;
  const files = changedFilesBetween("b".repeat(40), RELEASE_SHA, {
    exec(command, args, options) {
      invocation = { command, args, options };
      return "apps/dashboard/page.tsx\0README with spaces.md\0";
    },
  });
  assert.deepEqual(files, ["apps/dashboard/page.tsx", "README with spaces.md"]);
  assert.equal(invocation.command, "git");
  assert.deepEqual(invocation.args, [
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    "b".repeat(40),
    RELEASE_SHA,
    "--",
  ]);
  assert.equal(invocation.options.encoding, "utf8");

  assert.equal(
    changedFilesBetween("0".repeat(40), RELEASE_SHA, {
      exec() {
        throw new Error("initial pushes must not run git diff");
      },
    }),
    null,
  );
});

test("terminal provider states fail closed", () => {
  assert.equal(classifyWorkflowRun({ status: "queued" }).phase, "waiting");
  assert.equal(
    classifyWorkflowRun({ status: "completed", conclusion: "success" }).phase,
    "success",
  );
  for (const conclusion of [
    "failure",
    "cancelled",
    "timed_out",
    "skipped",
    "neutral",
    "stale",
    "action_required",
  ]) {
    assert.equal(classifyWorkflowRun({ status: "completed", conclusion }).phase, "failure");
  }

  assert.equal(classifyDeploymentStatus({ state: "in_progress" }).phase, "waiting");
  assert.equal(classifyDeploymentStatus({ state: "success" }).phase, "success");
  assert.equal(classifyDeploymentStatus({ state: "inactive" }).phase, "success");
  for (const state of ["failure", "error", "unexpected"]) {
    assert.equal(classifyDeploymentStatus({ state }).phase, "failure");
  }
});

test("the gate polls required and possibly unexpected workflows plus exact-SHA Vercel", async () => {
  let clock = 0;
  let renderPolls = 0;
  const calls = [];
  const apiRequest = vercelSuccessApi({
    workflow(pathname) {
      if (pathname.endsWith("deploy-cloudflare.yml/runs")) {
        return { workflow_runs: [] };
      }
      assert.match(pathname, /deploy-render\.yml\/runs$/);
      renderPolls += 1;
      return {
        workflow_runs: [
          {
            id: 30,
            head_sha: RELEASE_SHA,
            event: "push",
            status: renderPolls === 1 ? "in_progress" : "completed",
            conclusion: renderPolls === 1 ? null : "success",
            created_at: "2026-08-26T18:38:27.000Z",
            html_url: "https://github.com/rolln-ai/axel/actions/runs/30",
          },
        ],
      };
    },
  });

  const wrappedApi = async (pathname, query) => {
    calls.push({ pathname, query });
    return apiRequest(pathname, query);
  };
  const results = await waitForProductionDeploys({
    apiRequest: wrappedApi,
    changedFiles: ["apps/dashboard/app/status/page.tsx"],
    log() {},
    now: () => clock,
    pollIntervalMs: 10,
    registrationGraceMs: 20,
    releaseSha: RELEASE_SHA,
    repository: "rolln-ai/axel",
    sleep: async (ms) => {
      clock += ms;
    },
    timeoutMs: 100,
  });

  assert.ok(renderPolls >= 2);
  assert.equal(results.length, 4);
  assert.equal(
    calls.some(({ pathname }) => pathname.includes("deploy-cloudflare.yml")),
    true,
  );
  const deploymentCalls = calls.filter(({ pathname }) => pathname.endsWith("/deployments"));
  assert.ok(deploymentCalls.length >= 2);
  for (const { query } of deploymentCalls) {
    assert.equal(query.sha, RELEASE_SHA);
    assert.ok(VERCEL_ENVIRONMENTS.includes(query.environment));
  }
});

test("an unexpected workflow run is awaited even when changed paths do not require it", async () => {
  let clock = 0;
  let cloudflarePolls = 0;
  const apiRequest = vercelSuccessApi({
    workflow(pathname) {
      if (pathname.endsWith("deploy-render.yml/runs")) return { workflow_runs: [] };
      assert.match(pathname, /deploy-cloudflare\.yml\/runs$/);
      cloudflarePolls += 1;
      return {
        workflow_runs: [
          {
            id: 31,
            head_sha: RELEASE_SHA,
            event: "push",
            status: cloudflarePolls === 1 ? "in_progress" : "completed",
            conclusion: cloudflarePolls === 1 ? null : "success",
            created_at: "2026-08-26T18:38:27.000Z",
          },
        ],
      };
    },
  });

  const results = await waitForProductionDeploys({
    apiRequest,
    changedFiles: ["README.md"],
    log() {},
    now: () => clock,
    pollIntervalMs: 5,
    registrationGraceMs: 10,
    releaseSha: RELEASE_SHA,
    repository: "rolln-ai/axel",
    sleep: async (ms) => {
      clock += ms;
    },
    timeoutMs: 30,
  });

  assert.ok(cloudflarePolls >= 2);
  assert.equal(
    results.find(({ key }) => key === "cloudflare")?.phase,
    "success",
  );
  assert.equal(results.find(({ key }) => key === "render")?.phase, "success");
});

test("a required workflow that never registers fails after the grace period", async () => {
  let clock = 0;
  await assert.rejects(
    waitForProductionDeploys({
      apiRequest: vercelSuccessApi(),
      changedFiles: ["apps/ingest-worker/src/index.ts"],
      log() {},
      now: () => clock,
      pollIntervalMs: 5,
      registrationGraceMs: 5,
      releaseSha: RELEASE_SHA,
      repository: "rolln-ai/axel",
      sleep: async (ms) => {
        clock += ms;
      },
      timeoutMs: 20,
    }),
    /no exact-SHA push run registered/,
  );
});

test("an unexpected Vercel deployment creator cannot satisfy the gate", async () => {
  const apiRequest = async (pathname, query) => {
    if (pathname.includes("/actions/workflows/")) return { workflow_runs: [] };
    if (pathname.endsWith("/deployments")) {
      return [
        {
          ...vercelDeployment(query.environment, 99),
          creator: { login: "someone-else" },
        },
      ];
    }
    throw new Error(`Unexpected API request: ${pathname}`);
  };
  await assert.rejects(
    waitForProductionDeploys({
      apiRequest,
      changedFiles: ["README.md"],
      log() {},
      releaseSha: RELEASE_SHA,
      repository: "rolln-ai/axel",
      timeoutMs: 10,
    }),
    /unexpected deployment creator someone-else/,
  );
});
