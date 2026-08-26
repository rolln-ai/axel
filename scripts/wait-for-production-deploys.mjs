#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FULL_SHA = /^[0-9a-f]{40}$/i;
const ZERO_SHA = /^0{40}$/;
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 15 * 1000;
const DEFAULT_REGISTRATION_GRACE_MS = 2 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 1000;

/**
 * These lists intentionally mirror the push.paths filters in the named
 * workflows. The test suite compares them with the workflow YAML so a path
 * filter change cannot silently make this gate wait forever or skip a deploy.
 */
export const ACTION_WORKFLOWS = Object.freeze([
  Object.freeze({
    key: "cloudflare",
    label: "Cloudflare Workers",
    workflow: "deploy-cloudflare.yml",
    paths: Object.freeze([
      "apps/ingest-worker/**",
      "apps/router-edge/**",
      "apps/delivery-edge/**",
      "packages/connectors/**",
      "packages/observability/**",
      "packages/shared/**",
      "pnpm-lock.yaml",
      ".github/workflows/deploy-cloudflare.yml",
    ]),
  }),
  Object.freeze({
    key: "render",
    label: "Render services",
    workflow: "deploy-render.yml",
    paths: Object.freeze([
      "apps/dashboard/**",
      "apps/delivery-service/**",
      "apps/delivery-worker/**",
      "apps/pull-worker/**",
      "apps/router/**",
      "packages/connectors/**",
      "packages/observability/**",
      "packages/pull-connectors/**",
      "packages/shared/**",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "render.yaml",
      "scripts/deploy-render-service.sh",
      "scripts/sentry-release-deploy.sh",
      ".github/workflows/deploy-render.yml",
    ]),
  }),
]);

export const VERCEL_ENVIRONMENTS = Object.freeze([
  "Production – axel-dashboard",
  "Production – axel-marketing",
]);

const WORKFLOW_PENDING_STATUSES = new Set([
  "queued",
  "in_progress",
  "pending",
  "requested",
  "waiting",
]);
const DEPLOYMENT_PENDING_STATES = new Set(["queued", "pending", "in_progress"]);

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function assertReleaseSha(releaseSha) {
  if (!FULL_SHA.test(releaseSha)) {
    throw new Error("RELEASE_SHA must be a full 40-character Git SHA");
  }
}

function assertRepository(repository) {
  if (!/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must have the form owner/repository");
  }
}

function matchesPathPattern(file, pattern) {
  if (pattern.endsWith("/**") && !pattern.slice(0, -3).includes("*")) {
    return file.startsWith(pattern.slice(0, -2));
  }
  if (pattern.includes("*")) {
    throw new Error(`Unsupported deployment path pattern: ${pattern}`);
  }
  return file === pattern;
}

export function requiredActionWorkflows(changedFiles) {
  if (changedFiles === null) return [...ACTION_WORKFLOWS];
  return ACTION_WORKFLOWS.filter(({ paths: patterns }) =>
    changedFiles.some((file) => patterns.some((pattern) => matchesPathPattern(file, pattern))),
  );
}

/**
 * Return null when the push range cannot be trusted. Null deliberately means
 * "require every Actions deployment" rather than guessing that none ran.
 */
export function changedFilesBetween(beforeSha, releaseSha, options = {}) {
  const exec = options.exec ?? execFileSync;
  const warn = options.warn ?? console.warn;
  assertReleaseSha(releaseSha);
  if (!FULL_SHA.test(beforeSha ?? "") || ZERO_SHA.test(beforeSha)) return null;

  try {
    const output = exec(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", beforeSha, releaseSha, "--"],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );
    return output.split("\0").filter(Boolean);
  } catch (error) {
    warn(
      `[deploy-gate] Could not read the push diff; requiring all Actions deploys: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

function newest(items) {
  return items.reduce((current, candidate) => {
    if (!current) return candidate;
    const currentTime = Date.parse(current.created_at ?? current.updated_at ?? "") || 0;
    const candidateTime = Date.parse(candidate.created_at ?? candidate.updated_at ?? "") || 0;
    if (candidateTime !== currentTime) return candidateTime > currentTime ? candidate : current;
    try {
      return BigInt(candidate.id ?? 0) > BigInt(current.id ?? 0) ? candidate : current;
    } catch {
      return candidate;
    }
  }, null);
}

export function classifyWorkflowRun(run) {
  if (!run) return { phase: "waiting", detail: "waiting for run registration" };
  if (run.status !== "completed") {
    const status = WORKFLOW_PENDING_STATUSES.has(run.status) ? run.status : `status ${run.status}`;
    return { phase: "waiting", detail: status };
  }
  if (!run.conclusion) return { phase: "waiting", detail: "completed without a conclusion" };
  if (run.conclusion === "success") return { phase: "success", detail: "completed successfully" };
  return { phase: "failure", detail: `completed with conclusion ${run.conclusion}` };
}

export function classifyDeploymentStatus(status) {
  if (!status) return { phase: "waiting", detail: "waiting for deployment status" };
  if (status.state === "success") return { phase: "success", detail: "deployment succeeded" };
  // Vercel reports monorepo builds that are safely skipped as `inactive`
  // ("Skipped - Not affected"). The deployment is still exact-SHA,
  // exact-environment, and creator-checked before reaching this classifier.
  if (status.state === "inactive") {
    return { phase: "success", detail: "deployment skipped or inactive" };
  }
  if (DEPLOYMENT_PENDING_STATES.has(status.state)) {
    return { phase: "waiting", detail: status.state };
  }
  return { phase: "failure", detail: `deployment state is ${status.state ?? "unknown"}` };
}

class GitHubApiError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = "GitHubApiError";
    this.retryable = retryable;
  }
}

export function createGitHubApi(options) {
  const apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!options.token) throw new Error("GITHUB_TOKEN is required");

  return async function githubApi(pathname, query = {}) {
    const url = new URL(`${apiBase}${pathname}`);
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }

    let response;
    try {
      response = await fetchImpl(url, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${options.token}`,
          "user-agent": "axel-production-deploy-gate",
          "x-github-api-version": "2022-11-28",
        },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (error) {
      throw new GitHubApiError(
        `GitHub API request failed: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true },
      );
    }

    const body = await response.text();
    if (!response.ok) {
      throw new GitHubApiError(
        `GitHub API ${response.status} for ${url.pathname}: ${body.slice(0, 300)}`,
        { retryable: response.status === 429 || response.status >= 500 },
      );
    }
    try {
      return body ? JSON.parse(body) : null;
    } catch {
      throw new GitHubApiError(`GitHub API returned invalid JSON for ${url.pathname}`, {
        retryable: true,
      });
    }
  };
}

async function checkWorkflow(target, context, elapsedMs) {
  const response = await context.apiRequest(
    `/repos/${context.repository}/actions/workflows/${encodeURIComponent(target.workflow)}/runs`,
    { head_sha: context.releaseSha, event: "push", per_page: 20 },
  );
  const runs = Array.isArray(response?.workflow_runs) ? response.workflow_runs : [];
  const run = newest(
    runs.filter(
      (candidate) =>
        candidate.head_sha === context.releaseSha && candidate.event === "push",
    ),
  );
  if (!run) {
    if (elapsedMs < context.registrationGraceMs) {
      return {
        key: target.key,
        label: target.label,
        phase: "waiting",
        detail: "waiting for possible run registration",
      };
    }
    if (target.required) {
      return {
        key: target.key,
        label: target.label,
        phase: "failure",
        detail: `no exact-SHA push run registered within ${context.registrationGraceMs}ms`,
      };
    }
    return {
      key: target.key,
      label: target.label,
      phase: "success",
      detail: "no exact-SHA push run registered; not required by changed paths",
    };
  }
  return {
    key: target.key,
    label: target.label,
    ...classifyWorkflowRun(run),
    url: run?.html_url,
  };
}

async function checkVercel(environment, context) {
  const deploymentsResponse = await context.apiRequest(
    `/repos/${context.repository}/deployments`,
    { sha: context.releaseSha, environment, per_page: 20 },
  );
  const deployments = Array.isArray(deploymentsResponse) ? deploymentsResponse : [];
  const deployment = newest(
    deployments.filter(
      (candidate) =>
        candidate.sha === context.releaseSha && candidate.environment === environment,
    ),
  );
  const key = `vercel:${environment}`;
  const label = `Vercel ${environment}`;
  if (!deployment) {
    return { key, label, phase: "waiting", detail: "waiting for deployment registration" };
  }
  if (deployment.creator?.login !== "vercel[bot]") {
    return {
      key,
      label,
      phase: "failure",
      detail: `unexpected deployment creator ${deployment.creator?.login ?? "unknown"}`,
    };
  }

  const statusesResponse = await context.apiRequest(
    `/repos/${context.repository}/deployments/${deployment.id}/statuses`,
    { per_page: 20 },
  );
  const statuses = Array.isArray(statusesResponse) ? statusesResponse : [];
  const status = newest(statuses);
  return {
    key,
    label,
    ...classifyDeploymentStatus(status),
    url: status?.environment_url,
  };
}

async function checkTarget(target, context, elapsedMs) {
  try {
    if (target.kind === "workflow") return await checkWorkflow(target, context, elapsedMs);
    return await checkVercel(target.environment, context);
  } catch (error) {
    if (error instanceof GitHubApiError && error.retryable) {
      return {
        key: target.key,
        label: target.label,
        phase: "waiting",
        detail: error.message,
      };
    }
    throw error;
  }
}

export async function waitForProductionDeploys(options) {
  const repository = options.repository;
  const releaseSha = options.releaseSha;
  assertRepository(repository);
  assertReleaseSha(releaseSha);

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const registrationGraceMs =
    options.registrationGraceMs ?? DEFAULT_REGISTRATION_GRACE_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? console.log;
  const apiRequest = options.apiRequest;
  if (typeof apiRequest !== "function") throw new Error("apiRequest must be a function");

  const requiredWorkflows = requiredActionWorkflows(options.changedFiles);
  const requiredKeys = new Set(requiredWorkflows.map(({ key }) => key));
  for (const workflow of ACTION_WORKFLOWS) {
    if (!requiredKeys.has(workflow.key)) {
      log(
        `[deploy-gate] ${workflow.label}: not required by changed paths; checking for an unexpected run`,
      );
    }
  }
  const targets = [
    ...ACTION_WORKFLOWS.map((workflow) => ({
      ...workflow,
      kind: "workflow",
      required: requiredKeys.has(workflow.key),
    })),
    ...VERCEL_ENVIRONMENTS.map((environment) => ({
      kind: "vercel",
      key: `vercel:${environment}`,
      label: `Vercel ${environment}`,
      environment,
    })),
  ];
  const context = {
    apiRequest,
    registrationGraceMs,
    releaseSha,
    repository,
  };
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  const lastStates = new Map();

  while (true) {
    const elapsedMs = now() - startedAt;
    const results = await Promise.all(
      targets.map((target) => checkTarget(target, context, elapsedMs)),
    );
    for (const result of results) {
      const state = `${result.phase}:${result.detail}`;
      if (lastStates.get(result.key) !== state) {
        log(
          `[deploy-gate] ${result.label}: ${result.detail}${result.url ? ` (${result.url})` : ""}`,
        );
        lastStates.set(result.key, state);
      }
    }

    const failed = results.find(({ phase }) => phase === "failure");
    if (failed) throw new Error(`${failed.label}: ${failed.detail}`);
    if (results.every(({ phase }) => phase === "success")) {
      log(`[deploy-gate] All required production deploys succeeded for ${releaseSha}`);
      return results;
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      const pending = results
        .filter(({ phase }) => phase !== "success")
        .map(({ label, detail }) => `${label}: ${detail}`)
        .join("; ");
      throw new Error(`Timed out waiting for production deploys: ${pending}`);
    }
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }
}

async function main() {
  const releaseSha = process.env.RELEASE_SHA ?? process.env.GITHUB_SHA ?? "";
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const timeoutMs = positiveInteger(
    process.env.DEPLOY_WAIT_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    "DEPLOY_WAIT_TIMEOUT_MS",
  );
  const pollIntervalMs = positiveInteger(
    process.env.DEPLOY_POLL_INTERVAL_MS,
    DEFAULT_POLL_INTERVAL_MS,
    "DEPLOY_POLL_INTERVAL_MS",
  );
  const registrationGraceMs = positiveInteger(
    process.env.DEPLOY_REGISTRATION_GRACE_MS,
    DEFAULT_REGISTRATION_GRACE_MS,
    "DEPLOY_REGISTRATION_GRACE_MS",
  );
  const requestTimeoutMs = positiveInteger(
    process.env.DEPLOY_REQUEST_TIMEOUT_MS,
    DEFAULT_REQUEST_TIMEOUT_MS,
    "DEPLOY_REQUEST_TIMEOUT_MS",
  );
  const changedFiles = changedFilesBetween(process.env.BEFORE_SHA, releaseSha);
  const apiRequest = createGitHubApi({
    apiBase: process.env.GITHUB_API_URL,
    requestTimeoutMs,
    token: process.env.GITHUB_TOKEN,
  });

  await waitForProductionDeploys({
    apiRequest,
    changedFiles,
    pollIntervalMs,
    registrationGraceMs,
    releaseSha,
    repository,
    timeoutMs,
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[deploy-gate] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
