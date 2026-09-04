import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";

const { Client } = pg;
const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_RETRY_DELAY_MS = 250;
const RETRYABLE_STARTUP_CODES = new Set([
  "57P03",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
]);
const RETRYABLE_STARTUP_MESSAGES = new Set([
  "Connection terminated unexpectedly",
  "timeout expired",
]);

function defaultClientFactory(connectionString, connectionTimeoutMillis = 5_000) {
  return new Client({ connectionString, connectionTimeoutMillis });
}

function readRemainingTime(deadline, now) {
  const currentTime = now();
  if (!Number.isFinite(currentTime)) {
    throw new Error("disposable_postgres_startup_retry_options_invalid");
  }
  return deadline - currentTime;
}

export function isRetryablePostgresStartupError(error) {
  return RETRYABLE_STARTUP_CODES.has(error?.code)
    || RETRYABLE_STARTUP_MESSAGES.has(error?.message);
}

export async function connectPostgres(connectionString) {
  const client = defaultClientFactory(connectionString);
  await client.connect();
  return client;
}

export async function connectDisposablePostgres(
  connectionString,
  {
    timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    createClient = defaultClientFactory,
    sleep = delay,
    now = Date.now,
  } = {},
) {
  if (
    !Number.isFinite(timeoutMs)
    || timeoutMs <= 0
    || !Number.isFinite(retryDelayMs)
    || retryDelayMs <= 0
  ) {
    throw new Error("disposable_postgres_startup_retry_options_invalid");
  }
  const startedAt = now();
  if (!Number.isFinite(startedAt)) {
    throw new Error("disposable_postgres_startup_retry_options_invalid");
  }
  const deadline = startedAt + timeoutMs;
  if (!Number.isFinite(deadline)) {
    throw new Error("disposable_postgres_startup_retry_options_invalid");
  }

  while (true) {
    const remainingBeforeAttempt = readRemainingTime(deadline, now);
    if (remainingBeforeAttempt <= 0) {
      throw new Error("disposable_postgres_host_connection_not_ready");
    }
    let client;
    try {
      client = createClient(
        connectionString,
        Math.max(1, Math.min(5_000, Math.ceil(remainingBeforeAttempt))),
      );
      await client.connect();
      return client;
    } catch (error) {
      await client?.end?.().catch(() => {});
      if (!isRetryablePostgresStartupError(error)) {
        throw new Error("disposable_postgres_host_connection_failed");
      }
      const remainingAfterAttempt = readRemainingTime(deadline, now);
      if (remainingAfterAttempt <= 0) {
        throw new Error("disposable_postgres_host_connection_not_ready");
      }
      await sleep(Math.min(retryDelayMs, remainingAfterAttempt));
    }
  }
}
