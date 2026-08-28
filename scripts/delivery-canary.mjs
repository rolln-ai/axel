#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 15_000;
const RESPONSE_BODY_LIMIT_BYTES = 64 * 1024;
const CANARY_ABORTED = "canary_aborted";

function requiredEnv(env, name) {
  const value = env[name];
  if (!value) throw new Error(`missing_required_environment:${name}`);
  return value;
}

function numericEnv(env, name, fallback, bounds) {
  const raw = env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
    throw new Error(`invalid_numeric_environment:${name}`);
  }
  return value;
}

function credentialHeader(env, prefix) {
  const name = env[`${prefix}_HEADER`];
  const value = env[`${prefix}_VALUE`];
  if (!name && !value) return {};
  if (!name || !value || !/^[A-Za-z0-9-]{1,128}$/.test(name)) {
    throw new Error(`invalid_credential_header:${prefix}`);
  }
  return { [name]: value };
}

function receiptCredentialHeaders(env) {
  const configuredHeaders = [
    ["AXEL_CANARY_RECEIPT_AUTH", credentialHeader(env, "AXEL_CANARY_RECEIPT_AUTH")],
    [
      "AXEL_CANARY_RECEIPT_PROTECTION_BYPASS",
      credentialHeader(env, "AXEL_CANARY_RECEIPT_PROTECTION_BYPASS"),
    ],
  ];
  if (
    Object.keys(configuredHeaders[1][1]).length > 0
    && Object.keys(configuredHeaders[0][1]).length === 0
  ) {
    throw new Error("receipt_protection_bypass_requires_receipt_auth");
  }

  const headers = {};
  const normalizedNames = new Set();
  for (const [prefix, configured] of configuredHeaders) {
    for (const [name, value] of Object.entries(configured)) {
      const normalizedName = name.toLowerCase();
      if (normalizedNames.has(normalizedName)) {
        throw new Error(`duplicate_credential_header:${prefix}`);
      }
      normalizedNames.add(normalizedName);
      headers[name] = value;
    }
  }
  return headers;
}

function abortError() {
  return new Error(CANARY_ABORTED);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function isCanaryAbort(_error, signal) {
  return signal?.aborted === true;
}

async function cancelBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Keep cancellation and provider details out of diagnostics.
  }
}

function readChunk(reader, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(abortError());
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    reader.read().then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function readBoundedJson(response, signal) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > RESPONSE_BODY_LIMIT_BYTES) {
    await cancelBody(response);
    throw new Error("canary_response_too_large");
  }
  if (!response.body) throw new Error("canary_response_invalid");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await readChunk(reader, signal);
      throwIfAborted(signal);
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > RESPONSE_BODY_LIMIT_BYTES) {
        throw new Error("canary_response_too_large");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Keep the fixed local error.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("canary_response_invalid");
  }
}

async function fetchBoundedJson(fetchImpl, input, init, options) {
  const externalSignal = options.signal;
  throwIfAborted(externalSignal);
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  const abortFromExternal = () => controller.abort();
  externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  if (externalSignal?.aborted) controller.abort();
  let response;
  try {
    response = await fetchImpl(input, {
      ...init,
      redirect: "error",
      signal: controller.signal,
    });
    throwIfAborted(externalSignal);
    if (timedOut) throw new Error("canary_request_timeout");
    if (!options.acceptStatus(response)) {
      await cancelBody(response);
      return { status: response.status, ok: response.ok, body: undefined };
    }
    const body = await readBoundedJson(response, controller.signal);
    throwIfAborted(externalSignal);
    if (timedOut) throw new Error("canary_request_timeout");
    return { status: response.status, ok: response.ok, body };
  } catch (error) {
    if (isCanaryAbort(error, externalSignal)) throw abortError();
    if (timedOut) throw new Error("canary_request_timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

function receiptUrl(template, probeId, eventId) {
  return template
    .replaceAll("{probe_id}", encodeURIComponent(probeId))
    .replaceAll("{event_id}", encodeURIComponent(eventId));
}

function hasMatchingReceipt(receipt, probeId) {
  if (
    receipt === null
    || typeof receipt !== "object"
    || Array.isArray(receipt)
    || receipt.probe_id !== probeId
    || typeof receipt.received_at !== "string"
  ) {
    return false;
  }
  const receivedAtMs = Date.parse(receipt.received_at);
  return Number.isFinite(receivedAtMs)
    && new Date(receivedAtMs).toISOString() === receipt.received_at;
}

function sleep(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(abortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/**
 * Send one uniquely identified event through production and wait until a
 * controlled native destination exposes that exact probe through its read API.
 *
 * The canary source must route to a native-runtime destination such as a
 * dedicated Postgres, MongoDB, or Databricks target. The receipt URL may use
 * `{probe_id}` and `{event_id}` placeholders. A successful ingest with no
 * matching receipt is reported as delivery divergence.
 */
export async function runDeliveryCanary(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const log = options.log ?? console.log;
  const errorLog = options.errorLog ?? console.error;
  const signal = options.signal;

  throwIfAborted(signal);

  const ingestUrl = requiredEnv(env, "AXEL_CANARY_INGEST_URL");
  const receiptTemplate = requiredEnv(env, "AXEL_CANARY_RECEIPT_URL");
  const ingestHeaders = credentialHeader(env, "AXEL_CANARY_INGEST_AUTH");
  const receiptHeaders = receiptCredentialHeaders(env);
  const credentialValues = [
    ...Object.values(ingestHeaders),
    ...Object.values(receiptHeaders),
  ];
  if (new Set(credentialValues).size !== credentialValues.length) {
    throw new Error("canary_credential_values_must_be_distinct");
  }
  const timeoutMs = numericEnv(env, "AXEL_CANARY_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, {
    min: 500,
    max: 10 * 60_000,
  });
  const pollIntervalMs = numericEnv(
    env,
    "AXEL_CANARY_POLL_INTERVAL_MS",
    DEFAULT_POLL_INTERVAL_MS,
    { min: 100, max: 60_000 },
  );
  const probeId = `axel_canary_${now()}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const sentAt = new Date(now()).toISOString();
  const payload = {
    event_type: "axel.delivery_canary",
    axel_canary_probe_id: probeId,
    sent_at: sentAt,
    expected_runtime: "native",
  };

  let ingestResponse;
  try {
    ingestResponse = await fetchBoundedJson(
      fetchImpl,
      ingestUrl,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "axel-production-delivery-canary/1",
          ...ingestHeaders,
        },
        body: JSON.stringify(payload),
      },
      { signal, acceptStatus: (response) => response.status === 202 },
    );
  } catch (error) {
    if (isCanaryAbort(error, signal)) throw abortError();
    if (
      error instanceof Error
      && ["canary_response_invalid", "canary_response_too_large"].includes(error.message)
    ) {
      throw new Error("canary_ingest_response_invalid");
    }
    throw new Error("canary_ingest_request_failed");
  }
  if (ingestResponse.status !== 202) {
    throw new Error(`canary_ingest_rejected_status:${ingestResponse.status}`);
  }

  const ingestBody = ingestResponse.body;
  const eventId = ingestBody !== null && typeof ingestBody === "object"
    && typeof ingestBody.event_id === "string" && ingestBody.event_id.length > 0
    ? ingestBody.event_id
    : null;
  if (!eventId) throw new Error("canary_ingest_response_missing_event_id");

  throwIfAborted(signal);
  log("canary accepted");
  const deadline = now() + timeoutMs;
  let receiptAttempts = 0;
  while (now() < deadline) {
    receiptAttempts += 1;
    let response;
    try {
      response = await fetchBoundedJson(
        fetchImpl,
        receiptUrl(receiptTemplate, probeId, eventId),
        {
          method: "GET",
          headers: {
            accept: "application/json, text/plain;q=0.9",
            "user-agent": "axel-production-delivery-canary/1",
            ...receiptHeaders,
          },
        },
        { signal, acceptStatus: (candidate) => candidate.ok },
      );
    } catch (error) {
      if (isCanaryAbort(error, signal)) throw abortError();
      response = null;
    }

    if (response?.ok && hasMatchingReceipt(response.body, probeId)) {
      throwIfAborted(signal);
      const latencyMs = Math.max(0, now() - Date.parse(sentAt));
      log(
        `canary delivered latency_ms=${latencyMs} receipt_attempts=${receiptAttempts}`,
      );
      return { probeId, eventId, latencyMs, receiptAttempts };
    }
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())), signal);
  }

  throwIfAborted(signal);
  errorLog(`canary delivery divergence timeout_ms=${timeoutMs}`);
  throw new Error("canary_delivery_divergence");
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  runDeliveryCanary().catch((error) => {
    const code = error instanceof Error ? error.message : "canary_failed";
    // Error codes contain no URLs, response bodies, tokens, or request data.
    console.error(`delivery canary failed: ${code}`);
    process.exitCode = 1;
  });
}
