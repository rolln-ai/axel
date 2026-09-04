import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertSoleActiveVersion,
  assertSoleActiveTaggedVersion,
  captureWorkerActiveDeployment,
  customDomainUrl,
  readCapturedActiveVersion,
  resolveWorkersDevUrl,
  writeSecretsFile,
} from "../self-host/cloudflare-worker-release.mjs";

test("writes the complete secret set to a new 0600 file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "axel-worker-release-test-"));
  try {
    const secretPath = path.join(directory, "secrets.json");
    await writeSecretsFile(
      secretPath,
      ["DELIVERY_SHARED_SECRET", "ADMIN_TOKEN"],
      {
        DELIVERY_SHARED_SECRET: "delivery-secret-sentinel",
        ADMIN_TOKEN: "admin-secret-sentinel",
      },
    );
    assert.equal((await stat(secretPath)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(secretPath, "utf8")), {
      DELIVERY_SHARED_SECRET: "delivery-secret-sentinel",
      ADMIN_TOKEN: "admin-secret-sentinel",
    });
    await assert.rejects(
      writeSecretsFile(secretPath, ["DELIVERY_SHARED_SECRET"], {
        DELIVERY_SHARED_SECRET: "replacement",
      }),
      /EEXIST/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("requires one exact tagged version at 100 percent", () => {
  const versions = [{ id: "version_1", annotations: { "workers/tag": "release-tag" } }];
  const deployment = { versions: [{ version_id: "version_1", percentage: 100 }] };
  assert.doesNotThrow(() => assertSoleActiveTaggedVersion(versions, deployment, "release-tag"));
  assert.throws(
    () => assertSoleActiveTaggedVersion(versions, {
      versions: [
        { version_id: "version_1", percentage: 50 },
        { version_id: "version_0", percentage: 50 },
      ],
    }, "release-tag"),
    /sole active tagged version/,
  );
  assert.throws(
    () => assertSoleActiveTaggedVersion(
      [...versions, { id: "version_2", annotations: { "workers/tag": "release-tag" } }],
      deployment,
      "release-tag",
    ),
    /sole active tagged version/,
  );
});

test("captures one active version in a protected state file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "axel-worker-active-test-"));
  try {
    const statePath = path.join(directory, "active.json");
    let observedAuthorization = "";
    await captureWorkerActiveDeployment({
      accountId: "account_123",
      apiToken: "provider-secret-sentinel",
      workerName: "axel-ingest",
      statePath,
      fetchImpl: async (_url, options) => {
        observedAuthorization = options.headers.authorization;
        return new Response(JSON.stringify({
          success: true,
          result: {
            deployments: [{
              versions: [{ version_id: "prior-version_123", percentage: 100 }],
            }],
          },
        }), { status: 200 });
      },
    });
    assert.equal(observedAuthorization, "Bearer provider-secret-sentinel");
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);
    assert.equal(await readCapturedActiveVersion(statePath), "prior-version_123");
    assert.doesNotThrow(() => assertSoleActiveVersion(
      { versions: [{ version_id: "prior-version_123", percentage: 100 }] },
      "prior-version_123",
    ));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("captures a missing Worker without inventing a rollback version", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "axel-worker-missing-test-"));
  try {
    const statePath = path.join(directory, "active.json");
    await captureWorkerActiveDeployment({
      accountId: "account_123",
      apiToken: "provider-secret-sentinel",
      workerName: "axel-ingest",
      statePath,
      fetchImpl: async () => new Response("provider detail must stay private", { status: 404 }),
    });
    assert.equal(await readCapturedActiveVersion(statePath), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("active-version capture rejects split, malformed, and oversized provider state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "axel-worker-invalid-test-"));
  const base = {
    accountId: "account_123",
    apiToken: "provider-secret-sentinel",
    workerName: "axel-ingest",
  };
  try {
    const cases = [
      new Response(JSON.stringify({
        success: true,
        result: {
          deployments: [{
            versions: [
              { version_id: "version-one", percentage: 50 },
              { version_id: "version-two", percentage: 50 },
            ],
          }],
        },
      }), { status: 200 }),
      new Response("provider-secret-sentinel", { status: 403 }),
      new Response("x".repeat(65 * 1024), { status: 200 }),
    ];
    for (const [index, response] of cases.entries()) {
      await assert.rejects(
        captureWorkerActiveDeployment({
          ...base,
          statePath: path.join(directory, `invalid-${index}.json`),
          fetchImpl: async () => response,
        }),
        (error) => error.message === "Cloudflare Worker active-version capture failed",
      );
    }
    assert.throws(
      () => assertSoleActiveVersion(
        { versions: [{ version_id: "version-one", percentage: 99 }] },
        "version-one",
      ),
      /sole active expected version/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("accepts only a bare public custom hostname", () => {
  assert.equal(customDomainUrl("Ingest.Example.test"), "https://ingest.example.test");
  for (const invalid of [
    "https://ingest.example.test",
    "ingest.example.test/path",
    "localhost",
    "127.0.0.1",
    "*.example.test",
  ]) {
    assert.throws(() => customDomainUrl(invalid), /public DNS hostname/);
  }
});

test("discovers workers.dev through one bounded authenticated API response", async () => {
  let observedUrl = "";
  let observedAuthorization = "";
  const result = await resolveWorkersDevUrl({
    accountId: "account_123",
    apiToken: "provider-secret-sentinel",
    workerName: "axel-ingest",
    fetchImpl: async (url, options) => {
      observedUrl = url;
      observedAuthorization = options.headers.authorization;
      assert.equal(options.redirect, "error");
      return new Response(JSON.stringify({
        success: true,
        result: { subdomain: "private-account-label" },
      }), { status: 200 });
    },
  });
  assert.equal(
    observedUrl,
    "https://api.cloudflare.com/client/v4/accounts/account_123/workers/subdomain",
  );
  assert.equal(observedAuthorization, "Bearer provider-secret-sentinel");
  assert.equal(result, "https://axel-ingest.private-account-label.workers.dev");
});

test("workers.dev lookup fails closed on provider errors and oversized bodies", async () => {
  const base = {
    accountId: "account_123",
    apiToken: "provider-secret-sentinel",
    workerName: "axel-ingest",
  };
  await assert.rejects(
    resolveWorkersDevUrl({
      ...base,
      fetchImpl: async () => new Response("provider-secret-sentinel", { status: 403 }),
    }),
    (error) => error.message === "Cloudflare workers.dev lookup failed",
  );
  await assert.rejects(
    resolveWorkersDevUrl({
      ...base,
      fetchImpl: async () => new Response("x".repeat(65 * 1024), { status: 200 }),
    }),
    (error) => error.message === "Cloudflare workers.dev lookup failed",
  );
});
