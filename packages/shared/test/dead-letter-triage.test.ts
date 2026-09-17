import { describe, expect, it } from "vitest";
import {
  buildDeadLetterTriageState,
  shouldAutoReplay,
  triageDeadLetter,
} from "../src/dead-letter-triage.js";

const base = {
  reason: "delivery_dead",
  message: "",
  destination_type: "postgres",
  same_fingerprint_1h: 3,
  same_fingerprint_24h: 10,
  replay_successes_24h: 1,
  replay_failures_24h: 0,
  age_minutes: 12,
};

describe("buildDeadLetterTriageState", () => {
  it("maps diagnostics to fixed signal tokens and a status code", () => {
    const s = buildDeadLetterTriageState({
      ...base,
      message: 'column "customer_email" of relation "events" does not exist (status 400)',
    });
    expect(s.signals).toEqual(expect.arrayContaining(["unknown_column", "not_found_resource"]));
    expect(s.http_status).toBe(400);
    expect(JSON.stringify(s)).not.toContain("customer_email");
  });

  it("folds unknown reasons and destination types to safe values", () => {
    const s = buildDeadLetterTriageState({ ...base, reason: "weird_thing", destination_type: "acme" });
    expect(s.failure_reason).toBe("other");
    expect(s.destination_type).toBe("unknown");
  });

  it("flags Axel-side backpressure reasons", () => {
    expect(buildDeadLetterTriageState({ ...base, reason: "delivery_service_503" }).axel_backpressure).toBe(true);
    expect(buildDeadLetterTriageState({ ...base, reason: "delivery_dead" }).axel_backpressure).toBe(false);
  });

  it("does not mistake a port or an id for a status", () => {
    expect(buildDeadLetterTriageState({ ...base, message: "connect ECONNREFUSED 10.1.2.3:443" }).http_status).toBeNull();
    expect(buildDeadLetterTriageState({ ...base, message: "AccessDenied: 403 Forbidden" }).http_status).toBe(403);
  });

  it("reads slug-style connector codes as schema signals", () => {
    const s = buildDeadLetterTriageState({ ...base, reason: "delivery_dead", message: "bigquery_schema_mismatch" });
    expect(s.signals).toContain("schema_mismatch");
    const t = buildDeadLetterTriageState({ ...base, reason: "transform_collapse_array_expected_array", message: "operation_failed" });
    expect(t.failure_reason).toBe("transform_error");
    expect(buildDeadLetterTriageState({ ...base, reason: "filter_invalid_path" }).failure_reason).toBe("filter_error");
  });

  it("returns no status when none is present", () => {
    expect(buildDeadLetterTriageState({ ...base, message: "ECONNREFUSED 10.0.0.1" }).http_status).toBeNull();
    expect(buildDeadLetterTriageState({ ...base, message: "ECONNREFUSED 10.0.0.1" }).signals).toContain("connection_refused");
  });
});

describe("shouldAutoReplay", () => {
  it("replays only confident transient failures with a fixable reason", () => {
    expect(shouldAutoReplay({ reason: "transient", confidence: 0.95 }, "delivery_dead")).toBe(true);
    expect(shouldAutoReplay({ reason: "transient", confidence: 0.75 }, "delivery_dead")).toBe(false);
    expect(shouldAutoReplay({ reason: "destination_down", confidence: 0.99 }, "delivery_dead")).toBe(false);
    expect(shouldAutoReplay({ reason: "transient", confidence: 0.99 }, "raw_payload_missing")).toBe(false);
    expect(shouldAutoReplay({ reason: "transient", confidence: 0.99 }, "transform_collapse_array_expected_array")).toBe(false);
    expect(shouldAutoReplay({ reason: "transient", confidence: 0.6 }, "delivery_dead", 0.5)).toBe(true);
  });
});

describe("triageDeadLetter", () => {
  it("parses a choice answer", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          answers: {
            triage: {
              type: "choice",
              choice: "schema_mismatch",
              confidence: 0.91,
              probabilities: { schema_mismatch: 0.93, transient: 0.07 },
            },
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const out = await triageDeadLetter(base, { apiKey: "k", fetch: fetchImpl });
    expect(out.reason).toBe("schema_mismatch");
    expect(out.confidence).toBe(0.91);
    expect(out.probabilities.transient).toBe(0.07);
  });

  it("rejects an answer outside the label set", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ answers: { triage: { type: "choice", choice: "gremlins", confidence: 1, probabilities: {} } } }),
        { status: 200 },
      )) as unknown as typeof fetch;
    await expect(triageDeadLetter(base, { apiKey: "k", fetch: fetchImpl })).rejects.toThrow(/gremlins/);
  });

  it("throws on HTTP errors", async () => {
    const fetchImpl = (async () => new Response("", { status: 529 })) as unknown as typeof fetch;
    await expect(triageDeadLetter(base, { apiKey: "k", fetch: fetchImpl })).rejects.toThrow("HTTP 529");
  });
});
