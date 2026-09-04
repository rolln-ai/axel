import { open, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";

const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
const VERSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const VERSION_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROVIDER_ID_RE = /^[A-Za-z0-9_-]{3,128}$/;
const WORKER_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;

function fail(message) {
  throw new Error(message);
}

export async function writeSecretsFile(filePath, names, env = process.env) {
  if (!filePath || names.length === 0) fail("secret file path and names are required");
  const values = {};
  const seen = new Set();
  for (const name of names) {
    if (!SECRET_NAME_RE.test(name) || seen.has(name)) fail("invalid or duplicate secret name");
    seen.add(name);
    const value = env[name];
    if (typeof value !== "string" || value.length === 0) fail("required Worker secret is empty");
    values[name] = value;
  }

  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(values)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeProtectedJson(filePath, value) {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function assertSoleActiveVersion(deployment, expectedVersionId) {
  if (!VERSION_ID_RE.test(expectedVersionId)) fail("invalid Worker release state");
  const active = Array.isArray(deployment?.versions) ? deployment.versions : [];
  if (
    active.length !== 1
    || active[0]?.version_id !== expectedVersionId
    || Number(active[0]?.percentage) !== 100
  ) {
    fail("Worker release is not the sole active expected version");
  }
}

export function assertSoleActiveTaggedVersion(versions, deployment, expectedTag) {
  if (!VERSION_TAG_RE.test(expectedTag) || !Array.isArray(versions)) {
    fail("invalid Worker release state");
  }
  const tagged = versions.filter(
    (version) => version?.annotations?.["workers/tag"] === expectedTag,
  );
  const active = Array.isArray(deployment?.versions) ? deployment.versions : [];
  if (
    tagged.length !== 1
    || !VERSION_ID_RE.test(tagged[0]?.id ?? "")
    || active.length !== 1
    || active[0]?.version_id !== tagged[0].id
    || Number(active[0]?.percentage) !== 100
  ) {
    fail("Worker release is not the sole active tagged version");
  }
}

function validDnsName(value) {
  if (value.length > 253 || value.includes("..") || isIP(value) !== 0) return false;
  const labels = value.split(".");
  return labels.length >= 2 && labels.every((label) => (
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
  ));
}

export function customDomainUrl(rawDomain) {
  const domain = rawDomain.trim().toLowerCase();
  if (!validDnsName(domain)) fail("AXEL_INGEST_DOMAIN must be a public DNS hostname");
  return `https://${domain}`;
}

async function readBoundedJson(response, failureMessage) {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_PROVIDER_RESPONSE_BYTES) {
    fail(failureMessage);
  }
  if (!response.body) fail(failureMessage);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PROVIDER_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      fail(failureMessage);
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail(failureMessage);
  }
}

async function cancelBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Provider response details must never escape through cancellation errors.
  }
}

function validateProviderIdentity(accountId, apiToken, workerName) {
  if (!PROVIDER_ID_RE.test(accountId) || !WORKER_NAME_RE.test(workerName)) {
    fail("invalid Cloudflare account or Worker name");
  }
  if (typeof apiToken !== "string" || apiToken.length === 0 || apiToken.length > 8192) {
    fail("invalid Cloudflare API token");
  }
}

export async function captureWorkerActiveDeployment({
  accountId,
  apiToken,
  workerName,
  statePath,
  fetchImpl = fetch,
}) {
  validateProviderIdentity(accountId, apiToken, workerName);
  if (typeof statePath !== "string" || statePath.length === 0) {
    fail("Cloudflare Worker active-version capture failed");
  }

  let response;
  try {
    response = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/deployments`,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${apiToken}`,
        },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    fail("Cloudflare Worker active-version capture failed");
  }

  if (response.status === 404) {
    await cancelBody(response);
    await writeProtectedJson(statePath, { activeVersion: null });
    return;
  }
  if (response.status !== 200) {
    await cancelBody(response);
    fail("Cloudflare Worker active-version capture failed");
  }

  const payload = await readBoundedJson(
    response,
    "Cloudflare Worker active-version capture failed",
  );
  const deployments = payload?.success === true && Array.isArray(payload?.result?.deployments)
    ? payload.result.deployments
    : undefined;
  if (!deployments) fail("Cloudflare Worker active-version capture failed");
  if (deployments.length === 0) {
    await writeProtectedJson(statePath, { activeVersion: null });
    return;
  }

  const active = deployments[0];
  const activeVersions = Array.isArray(active?.versions) ? active.versions : [];
  if (
    activeVersions.length !== 1
    || !VERSION_ID_RE.test(activeVersions[0]?.version_id ?? "")
    || Number(activeVersions[0]?.percentage) !== 100
  ) {
    fail("Cloudflare Worker active-version capture failed");
  }
  await writeProtectedJson(statePath, { activeVersion: activeVersions[0].version_id });
}

export async function readCapturedActiveVersion(statePath) {
  let state;
  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    fail("invalid captured Worker release state");
  }
  if (state?.activeVersion === null) return null;
  if (!VERSION_ID_RE.test(state?.activeVersion ?? "")) {
    fail("invalid captured Worker release state");
  }
  return state.activeVersion;
}

export async function resolveWorkersDevUrl({
  accountId,
  apiToken,
  workerName,
  fetchImpl = fetch,
}) {
  validateProviderIdentity(accountId, apiToken, workerName);

  let response;
  try {
    response = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${apiToken}`,
        },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    fail("Cloudflare workers.dev lookup failed");
  }
  if (response.status !== 200) fail("Cloudflare workers.dev lookup failed");
  const payload = await readBoundedJson(response, "Cloudflare workers.dev lookup failed");
  const subdomain = payload?.success === true && typeof payload?.result?.subdomain === "string"
    ? payload.result.subdomain.trim().toLowerCase()
    : "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) {
    fail("Cloudflare workers.dev lookup failed");
  }
  return `https://${workerName}.${subdomain}.workers.dev`;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "write-secrets") {
    const [filePath, ...names] = args;
    await writeSecretsFile(filePath, names);
    return;
  }
  if (command === "verify-active") {
    const [versionsPath, deploymentPath, expectedTag] = args;
    if (!versionsPath || !deploymentPath || !expectedTag) fail("release state paths are required");
    let versions;
    let deployment;
    try {
      [versions, deployment] = await Promise.all([
        readFile(versionsPath, "utf8").then(JSON.parse),
        readFile(deploymentPath, "utf8").then(JSON.parse),
      ]);
    } catch {
      fail("invalid Worker release state");
    }
    assertSoleActiveTaggedVersion(versions, deployment, expectedTag);
    return;
  }
  if (command === "verify-version") {
    const [deploymentPath, expectedVersionId] = args;
    if (!deploymentPath || !expectedVersionId) fail("release state path and version are required");
    let deployment;
    try {
      deployment = JSON.parse(await readFile(deploymentPath, "utf8"));
    } catch {
      fail("invalid Worker release state");
    }
    assertSoleActiveVersion(deployment, expectedVersionId);
    return;
  }
  if (command === "capture-active") {
    const [workerName, statePath] = args;
    if (!workerName || !statePath) fail("Worker name and release state path are required");
    await captureWorkerActiveDeployment({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
      apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
      workerName,
      statePath,
    });
    return;
  }
  if (command === "read-captured") {
    const [statePath] = args;
    if (!statePath) fail("release state path is required");
    const activeVersion = await readCapturedActiveVersion(statePath);
    process.stdout.write(activeVersion === null ? "absent\n" : `active:${activeVersion}\n`);
    return;
  }
  if (command === "custom-url") {
    const [domain] = args;
    if (!domain) fail("AXEL_INGEST_DOMAIN is required");
    process.stdout.write(`${customDomainUrl(domain)}\n`);
    return;
  }
  if (command === "workers-dev-url") {
    const [workerName] = args;
    const url = await resolveWorkersDevUrl({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
      apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
      workerName: workerName ?? "",
    });
    process.stdout.write(`${url}\n`);
    return;
  }
  fail("usage: cloudflare-worker-release.mjs <write-secrets|capture-active|read-captured|verify-active|verify-version|custom-url|workers-dev-url>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Worker release failed"}\n`);
    process.exitCode = 1;
  });
}
