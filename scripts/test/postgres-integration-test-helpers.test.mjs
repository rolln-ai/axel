import assert from "node:assert/strict";
import test from "node:test";
import {
  connectDisposablePostgres,
  isRetryablePostgresStartupError,
} from "./postgres-integration-test-helpers.mjs";

test("classifies only bounded disposable Postgres startup failures as retryable", () => {
  for (const code of ["57P03", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"]) {
    assert.equal(isRetryablePostgresStartupError({ code }), true);
  }
  assert.equal(
    isRetryablePostgresStartupError({ message: "Connection terminated unexpectedly" }),
    true,
  );
  assert.equal(isRetryablePostgresStartupError({ message: "timeout expired" }), true);
  assert.equal(isRetryablePostgresStartupError({ code: "28P01" }), false);
  assert.equal(isRetryablePostgresStartupError(new Error("unexpected failure")), false);
});

test("retries a transient host-port race and closes the failed client", async () => {
  const clients = [];
  const client = await connectDisposablePostgres("postgresql://disposable.invalid/test", {
    createClient: () => {
      const attempt = clients.length;
      const created = {
        connect: async () => {
          if (attempt === 0) throw Object.assign(new Error("transient"), { code: "ECONNRESET" });
        },
        endCalls: 0,
        end: async () => {
          created.endCalls += 1;
        },
      };
      clients.push(created);
      return created;
    },
    sleep: async () => {},
  });

  assert.equal(client, clients[1]);
  assert.equal(clients.length, 2);
  assert.equal(clients[0].endCalls, 1);
  assert.equal(clients[1].endCalls, 0);
});

test("does not retry or expose authentication failures", async () => {
  const authenticationError = Object.assign(new Error("authentication failed"), {
    code: "28P01",
  });
  let attempts = 0;
  let endCalls = 0;

  await assert.rejects(
    connectDisposablePostgres("postgresql://disposable.invalid/test", {
      createClient: () => ({
        connect: async () => {
          attempts += 1;
          throw authenticationError;
        },
        end: async () => {
          endCalls += 1;
        },
      }),
      sleep: async () => {},
    }),
    /disposable_postgres_host_connection_failed/,
  );
  assert.equal(attempts, 1);
  assert.equal(endCalls, 1);
});

test("fails with a fixed error after the startup deadline", async () => {
  let currentTime = 0;
  const connectionTimeouts = [];
  let endCalls = 0;
  await assert.rejects(
    connectDisposablePostgres("postgresql://disposable.invalid/test", {
      timeoutMs: 1,
      createClient: (_connectionString, connectionTimeoutMillis) => ({
        connect: async () => {
          connectionTimeouts.push(connectionTimeoutMillis);
          throw new Error("Connection terminated unexpectedly");
        },
        end: async () => {
          endCalls += 1;
        },
      }),
      now: () => currentTime,
      sleep: async (milliseconds) => {
        currentTime += milliseconds;
      },
    }),
    /disposable_postgres_host_connection_not_ready/,
  );
  assert.deepEqual(connectionTimeouts, [1]);
  assert.equal(endCalls, 1);
});

test("rejects unbounded startup retry options", async () => {
  await assert.rejects(
    connectDisposablePostgres("postgresql://disposable.invalid/test", {
      timeoutMs: Number.NaN,
    }),
    /disposable_postgres_startup_retry_options_invalid/,
  );
  await assert.rejects(
    connectDisposablePostgres("postgresql://disposable.invalid/test", {
      timeoutMs: Number.MAX_VALUE,
      now: () => Number.MAX_VALUE,
    }),
    /disposable_postgres_startup_retry_options_invalid/,
  );
});
