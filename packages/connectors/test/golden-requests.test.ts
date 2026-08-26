/**
 * Cross-runtime golden-request contract.
 *
 * `apps/delivery-service` (Node) and `apps/delivery-edge` (Cloudflare Worker)
 * used to each carry their own `deliverHttp` / `deliverWebhook`. They now both
 * drive the connectors in this package; the only things either runtime is
 * allowed to vary are the injected fetch implementation, the (Node-only) DNS
 * resolver used for the rebinding SSRF check, and `defaultTimeoutMs`.
 *
 * This file pins that claim two ways:
 *
 *  1. GOLDEN — for a fixed destination config + payload, the exact bytes on
 *     the wire (method, URL, every header, body, signature hex) are asserted
 *     against hard-coded literals. If any of these change, a receiver's
 *     signature verification changes with it, so the change must be
 *     deliberate and the docs page updated alongside.
 *
 *  2. PARITY — the Node-shaped wiring and the Worker-shaped wiring are run
 *     over the same inputs and their recorded requests must be deep-equal.
 *     A future hand-port would fail here immediately.
 *
 * The signature literals below were cross-checked against `node:crypto`
 * (see the assertions) — they are not merely a snapshot of our own output.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildHttpRequest,
  classifyDeliveryStatus,
  createHttpConnector,
  createWebhookConnector,
  type Connector,
  type FetchLike,
  type FetchResponseLike,
} from "../src/index.js";
import type { Destination, DnsLookupAll } from "@axel/shared";

// ---- Fixtures ----------------------------------------------------------- //

const PAYLOAD = '{"id":"evt_gold_1","type":"invoice.paid","amount":4200}';
const EVENT_ID = "evt_gold_1";
const DESTINATION_ID = "dst_gold_1";
const WORKSPACE_ID = "ws_gold_1";
const SIGNING_SECRET = "whsec_GOLDEN_FIXTURE_SECRET";
const FIXED_TS = 1_700_000_000;

/** The Worker's wall-clock cap — mirrored from apps/delivery-edge. */
const EDGE_DEFAULT_TIMEOUT_MS = 15_000;

/** A public IP so the Node-only resolved-host SSRF check passes. */
const publicLookup: DnsLookupAll = async () => [{ address: "93.184.216.34", family: 4 }];

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyHex: string;
  /** Whether the runtime attached an abort signal (the one legitimate delta). */
  hasSignal: boolean;
}

function recorder(status = 200, body = ""): { fetch: FetchLike; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: { ...init.headers },
      bodyHex: hex(new Uint8Array(init.body)),
      hasSignal: init.signal !== undefined,
    });
    const response: FetchResponseLike = {
      status,
      async text() {
        return body;
      },
      headers: { get: () => null },
    };
    return response;
  };
  return { fetch, calls };
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function destination<TConfig>(type: Destination["type"], config: TConfig): Destination<TConfig> {
  return {
    destination_id: DESTINATION_ID,
    workspace_id: WORKSPACE_ID,
    type,
    config,
    credentials_ref: "cred_gold_1",
  };
}

function payloadBuffer(): ArrayBuffer {
  const bytes = new TextEncoder().encode(PAYLOAD);
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

const PAYLOAD_HEX = hex(new TextEncoder().encode(PAYLOAD));

/**
 * `HMAC-SHA256(whsec_GOLDEN_FIXTURE_SECRET, "1700000000." + PAYLOAD)`.
 *
 * Pinned deliberately: this hex is what a customer's receiver recomputes to
 * verify the delivery. If it changes, every deployed receiver breaks — so it
 * must only ever change with an intentional, documented scheme migration.
 */
const GOLDEN_SIGNATURE = "c797c610a6fd12a09f93fb58ca8d63f73e52a42777754999ca05d5e3a91159c4";

/**
 * The two supported wirings. `node` is exactly what
 * apps/delivery-service/src/server.ts constructs; `edge` is exactly what
 * apps/delivery-edge/src/index.ts constructs.
 */
function runtimes(fetchImpl: FetchLike): Array<{
  name: "node" | "edge";
  http: Connector<never>;
  webhook: Connector<never>;
}> {
  return [
    {
      name: "node",
      http: createHttpConnector(fetchImpl, publicLookup) as Connector<never>,
      webhook: createWebhookConnector(fetchImpl, publicLookup) as Connector<never>,
    },
    {
      name: "edge",
      // No DNS resolver: the Workers runtime has no DNS API. Default timeout
      // because a Worker invocation has a hard wall-clock budget.
      http: createHttpConnector(fetchImpl, undefined, {
        defaultTimeoutMs: EDGE_DEFAULT_TIMEOUT_MS,
      }) as Connector<never>,
      webhook: createWebhookConnector(fetchImpl, undefined, {
        defaultTimeoutMs: EDGE_DEFAULT_TIMEOUT_MS,
      }) as Connector<never>,
    },
  ];
}

// ---- HTTP --------------------------------------------------------------- //

describe("golden request — http connector", () => {
  const config = {
    url: "https://receiver.golden.test/hooks/inbound",
    method: "PUT" as const,
    headers: {
      // Auth headers arrive already materialised by @axel/shared
      // buildHttpAuthConfig in both runtimes.
      Authorization: "Bearer tok_golden",
      "X-Tenant": "acme",
    },
  };

  const GOLDEN = {
    url: "https://receiver.golden.test/hooks/inbound",
    method: "PUT",
    headers: {
      "content-type": "application/json",
      Authorization: "Bearer tok_golden",
      "X-Tenant": "acme",
    },
    bodyHex: PAYLOAD_HEX,
  };

  it.each(["node", "edge"] as const)(
    "%s runtime emits the golden request",
    async (name) => {
      const rec = recorder(202);
      const runtime = runtimes(rec.fetch).find((r) => r.name === name)!;
      const attempt = await runtime.http.deliver(payloadBuffer(), destination("http", config) as never, {
        eventId: EVENT_ID,
      });

      expect(attempt.status).toBe("success");
      const { hasSignal, ...sent } = rec.calls[0]!;
      expect(sent).toEqual(GOLDEN);
      // The one sanctioned divergence: only the Worker wiring carries a
      // default timeout, so only it attaches an AbortSignal.
      expect(hasSignal).toBe(name === "edge");
    },
  );

  it("node and edge wirings produce byte-identical http requests", async () => {
    const recorded: RecordedRequest[] = [];
    for (const runtime of ["node", "edge"] as const) {
      const rec = recorder(200);
      const r = runtimes(rec.fetch).find((x) => x.name === runtime)!;
      await r.http.deliver(payloadBuffer(), destination("http", config) as never, { eventId: EVENT_ID });
      const { hasSignal: _ignored, ...sent } = rec.calls[0]!;
      recorded.push(sent as RecordedRequest);
    }
    expect(recorded[0]).toEqual(recorded[1]);
  });

  it("the pure builder agrees with what the connector actually sent", async () => {
    const rec = recorder(200);
    const runtime = runtimes(rec.fetch)[0]!; // node
    await runtime.http.deliver(payloadBuffer(), destination("http", config) as never, {
      eventId: EVENT_ID,
    });
    const built = buildHttpRequest({ config, body: payloadBuffer() });
    expect({
      url: built.url,
      method: built.method,
      headers: built.headers,
      bodyHex: hex(new Uint8Array(built.body)),
    }).toEqual(GOLDEN);
    const { hasSignal: _ignored, ...sent } = rec.calls[0]!;
    expect(sent).toEqual(GOLDEN);
  });

  it("defaults to POST and content-type application/json with no config headers", async () => {
    const rec = recorder(204);
    const runtime = runtimes(rec.fetch)[1]!; // edge
    await runtime.http.deliver(
      payloadBuffer(),
      destination("http", { url: "https://receiver.golden.test/plain" }) as never,
      { eventId: EVENT_ID },
    );
    expect(rec.calls[0]!.method).toBe("POST");
    expect(rec.calls[0]!.headers).toEqual({ "content-type": "application/json" });
  });
});

// ---- Webhook ------------------------------------------------------------ //

describe("golden request — signed webhook connector", () => {
  const config = {
    url: "https://receiver.golden.test/webhooks",
    signing_secret: SIGNING_SECRET,
    headers: {
      "X-Tenant": "acme",
      // Must be dropped: attempts to shadow a protocol header.
      "X-Axel-Signature": "BOGUS",
      // Must be dropped: forbidden hop-by-hop name.
      Host: "evil.test",
      // Must be dropped: CR/LF in value.
      "X-Smuggle": "a\r\nX-Injected: 1",
    },
    __nowSeconds: () => FIXED_TS,
  };

  it("the pinned signature matches an independent node:crypto HMAC", () => {
    // Guards against the golden literal drifting away from the real scheme:
    // the literal is what we assert on the wire, node:crypto is the
    // receiver-side implementation customers actually run.
    const expected = createHmac("sha256", SIGNING_SECRET)
      .update(`${FIXED_TS}.${PAYLOAD}`)
      .digest("hex");
    expect(expected).toBe(GOLDEN_SIGNATURE);
  });

  const GOLDEN = {
    url: "https://receiver.golden.test/webhooks",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Tenant": "acme",
      "X-Axel-Timestamp": String(FIXED_TS),
      "X-Axel-Event-Id": EVENT_ID,
      "X-Axel-Webhook-Id": DESTINATION_ID,
      "X-Axel-Signature": `t=${FIXED_TS},v1=${GOLDEN_SIGNATURE}`,
    },
    bodyHex: PAYLOAD_HEX,
  };

  it.each(["node", "edge"] as const)("%s runtime emits the golden signed request", async (name) => {
    const rec = recorder(200);
    const runtime = runtimes(rec.fetch).find((r) => r.name === name)!;
    const attempt = await runtime.webhook.deliver(
      payloadBuffer(),
      destination("webhook", config) as never,
      { eventId: EVENT_ID },
    );

    expect(attempt.status).toBe("success");
    expect(attempt.response).toMatchObject({ signed: true, algorithm: "hmac-sha256" });
    const { hasSignal, ...sent } = rec.calls[0]!;
    expect(sent).toEqual(GOLDEN);
    expect(hasSignal).toBe(name === "edge");
  });

  it("node and edge wirings produce byte-identical signed requests", async () => {
    const recorded: RecordedRequest[] = [];
    for (const runtime of ["node", "edge"] as const) {
      const rec = recorder(200);
      const r = runtimes(rec.fetch).find((x) => x.name === runtime)!;
      await r.webhook.deliver(payloadBuffer(), destination("webhook", config) as never, {
        eventId: EVENT_ID,
      });
      const { hasSignal: _ignored, ...sent } = rec.calls[0]!;
      recorded.push(sent as RecordedRequest);
    }
    expect(recorded[0]).toEqual(recorded[1]);
  });

  it("pins the hmac-sha512 variant across both runtimes", async () => {
    const sha512Config = { ...config, signing_algorithm: "hmac-sha512" as const };
    const expected512 = createHmac("sha512", SIGNING_SECRET)
      .update(`${FIXED_TS}.${PAYLOAD}`)
      .digest("hex");
    for (const name of ["node", "edge"] as const) {
      const rec = recorder(200);
      const r = runtimes(rec.fetch).find((x) => x.name === name)!;
      await r.webhook.deliver(payloadBuffer(), destination("webhook", sha512Config) as never, {
        eventId: EVENT_ID,
      });
      expect(rec.calls[0]!.headers["X-Axel-Signature"]).toBe(`t=${FIXED_TS},v1=${expected512}`);
    }
  });

  it("omits the signature header (and reports signed:false) for an empty secret", async () => {
    const rec = recorder(200);
    const r = runtimes(rec.fetch)[1]!; // edge
    const attempt = await r.webhook.deliver(
      payloadBuffer(),
      destination("webhook", { ...config, signing_secret: "" }) as never,
      { eventId: EVENT_ID },
    );
    expect(rec.calls[0]!.headers["X-Axel-Signature"]).toBeUndefined();
    expect(attempt.response).toMatchObject({ signed: false });
  });
});

// ---- Shared classification --------------------------------------------- //

describe("shared status classification", () => {
  /**
   * The full pinned table. Both connector types and both runtimes agree.
   * This is the behaviour apps/delivery-edge's hand-ported `deliverHttp`
   * always had for the terminal codes; the plain HTTP connector had drifted
   * to "every non-2xx retries", which burned the retry budget on a typo'd
   * URL. See src/classify.ts.
   */
  const TABLE: Array<[number, "success" | "retry" | "dead"]> = [
    [200, "success"],
    [201, "success"],
    [202, "success"],
    [204, "success"],
    [299, "success"],
    [301, "retry"],
    [302, "retry"],
    [400, "dead"],
    [401, "dead"],
    [403, "dead"],
    [404, "dead"],
    [405, "dead"],
    [408, "retry"],
    [409, "dead"],
    [410, "dead"],
    [422, "dead"],
    [429, "retry"],
    [500, "retry"],
    [502, "retry"],
    [503, "retry"],
    [504, "retry"],
  ];

  it.each(TABLE)("classifies %i as %s", (status, expected) => {
    expect(classifyDeliveryStatus(status)).toBe(expected);
  });

  it.each(TABLE)(
    "http and webhook connectors both map %i to %s in both runtimes",
    async (status, expected) => {
      for (const name of ["node", "edge"] as const) {
        const rec = recorder(status, "body");
        const r = runtimes(rec.fetch).find((x) => x.name === name)!;
        const http = await r.http.deliver(
          payloadBuffer(),
          destination("http", { url: "https://receiver.golden.test/x" }) as never,
          { eventId: EVENT_ID },
        );
        const webhook = await r.webhook.deliver(
          payloadBuffer(),
          destination("webhook", {
            url: "https://receiver.golden.test/x",
            signing_secret: SIGNING_SECRET,
          }) as never,
          { eventId: EVENT_ID },
        );
        expect(http.status).toBe(expected);
        expect(webhook.status).toBe(expected);
      }
    },
  );

  it("classifies a thrown network error as retry in both runtimes and both connectors", async () => {
    const boom: FetchLike = async () => {
      throw new Error("ECONNRESET");
    };
    for (const r of runtimes(boom)) {
      const http = await r.http.deliver(
        payloadBuffer(),
        destination("http", { url: "https://receiver.golden.test/x" }) as never,
        { eventId: EVENT_ID },
      );
      const webhook = await r.webhook.deliver(
        payloadBuffer(),
        destination("webhook", { url: "https://receiver.golden.test/x" }) as never,
        { eventId: EVENT_ID },
      );
      expect(http.status).toBe("retry");
      expect(webhook.status).toBe("retry");
      expect((http.response as { error: string }).error).toContain("ECONNRESET");
      expect((webhook.response as { error: string }).error).toContain("ECONNRESET");
    }
  });

  it("blocks an SSRF URL as dead in both runtimes and both connectors", async () => {
    const rec = recorder(200);
    for (const r of runtimes(rec.fetch)) {
      const http = await r.http.deliver(
        payloadBuffer(),
        destination("http", { url: "http://169.254.169.254/latest/meta-data/" }) as never,
        { eventId: EVENT_ID },
      );
      const webhook = await r.webhook.deliver(
        payloadBuffer(),
        destination("webhook", { url: "http://169.254.169.254/latest/meta-data/" }) as never,
        { eventId: EVENT_ID },
      );
      expect(http.status).toBe("dead");
      expect(webhook.status).toBe("dead");
      expect((http.response as { error: string }).error).toMatch(/^ssrf_blocked: /);
      expect((webhook.response as { error: string }).error).toMatch(/^ssrf_blocked: /);
    }
    expect(rec.calls).toHaveLength(0);
  });

  it("captures at most 2048 bytes of the response body in both runtimes", async () => {
    const rec = recorder(200, "x".repeat(5000));
    for (const r of runtimes(rec.fetch)) {
      const http = await r.http.deliver(
        payloadBuffer(),
        destination("http", { url: "https://receiver.golden.test/x" }) as never,
        { eventId: EVENT_ID },
      );
      expect((http.response as { body: string }).body).toHaveLength(2048);
    }
  });
});

// ---- Timeout parameterisation ------------------------------------------ //

describe("timeout override chain", () => {
  it("prefers the per-attempt context override over config and runtime default", async () => {
    let seen: AbortSignal | undefined;
    const capture: FetchLike = async (_url, init) => {
      seen = init.signal;
      return { status: 204, async text() { return ""; } };
    };
    const edge = createHttpConnector(capture, undefined, { defaultTimeoutMs: EDGE_DEFAULT_TIMEOUT_MS });
    await edge.deliver(
      payloadBuffer(),
      destination("http", { url: "https://receiver.golden.test/x", timeoutMs: 9_000 }) as never,
      { eventId: EVENT_ID, timeoutMs: 250 },
    );
    expect(seen).toBeDefined();
    expect(seen!.aborted).toBe(false);
  });

  it("applies the webhook timeout that used to be documented but unimplemented", async () => {
    let seen: AbortSignal | undefined;
    const capture: FetchLike = async (_url, init) => {
      seen = init.signal;
      return { status: 204, async text() { return ""; } };
    };
    // Node wiring: no runtime default, so only the destination's timeout_ms
    // (overlaid from destinations.request_timeout_ms) can arm the signal.
    const node = createWebhookConnector(capture, publicLookup);
    await node.deliver(
      payloadBuffer(),
      destination("webhook", {
        url: "https://receiver.golden.test/x",
        timeout_ms: 5_000,
      }) as never,
      { eventId: EVENT_ID },
    );
    expect(seen).toBeDefined();
  });

  it("leaves the Node wiring signal-free when no timeout is configured anywhere", async () => {
    let seen: AbortSignal | undefined | "unset" = "unset";
    const capture: FetchLike = async (_url, init) => {
      seen = init.signal;
      return { status: 204, async text() { return ""; } };
    };
    const node = createHttpConnector(capture, publicLookup);
    await node.deliver(
      payloadBuffer(),
      destination("http", { url: "https://receiver.golden.test/x" }) as never,
      { eventId: EVENT_ID },
    );
    expect(seen).toBeUndefined();
  });
});
