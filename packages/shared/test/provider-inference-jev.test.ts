import { describe, expect, it } from "vitest";
import {
  buildJevRequest,
  inferProviderAuto,
  inferProviderWithJev,
  resolveJevConfig,
} from "../src/provider-inference-jev.js";

type Fetch = typeof fetch;

function fakeFetch(
  answers: Record<string, unknown>,
  opts: { status?: number; capture?: { body?: unknown; headers?: Record<string, string> } } = {},
): Fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    if (opts.capture) {
      opts.capture.body = JSON.parse(String(init?.body));
      opts.capture.headers = init?.headers as Record<string, string>;
    }
    const status = opts.status ?? 200;
    return new Response(JSON.stringify({ model: "jev-latest", answers }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as Fetch;
}

const choice = (choice: string, confidence: number, probabilities: Record<string, number>) => ({
  type: "choice",
  choice,
  confidence,
  probabilities,
});

describe("resolveJevConfig", () => {
  it("returns null without a key", () => {
    expect(resolveJevConfig({})).toBeNull();
    expect(resolveJevConfig({ TYPESAFE_API_KEY: "  " })).toBeNull();
  });

  it("reads key, base URL, model, and timeout", () => {
    expect(
      resolveJevConfig({
        TYPESAFE_API_KEY: "k",
        TYPESAFE_BASE_URL: "https://example.test/v1",
        TYPESAFE_MODEL: "jev-x",
        TYPESAFE_TIMEOUT_MS: "1500",
      }),
    ).toEqual({ apiKey: "k", baseUrl: "https://example.test/v1", model: "jev-x", timeoutMs: 1500 });
  });
});

describe("inferProviderAuto", () => {
  it("uses heuristics when Jev is not configured", async () => {
    const out = await inferProviderAuto(
      { payload: { id: "evt_1", object: "event", type: "invoice.paid" } },
      null,
    );
    expect(out.source).toBe("heuristic");
    expect(out.provider).toBe("stripe");
    expect(out.event_type).toBe("invoice.paid");
  });
});

describe("inferProviderWithJev", () => {
  it("skips the network when a header smoking gun exists", async () => {
    let called = false;
    const fetchSpy = (async () => {
      called = true;
      throw new Error("should not be called");
    }) as unknown as Fetch;
    const out = await inferProviderWithJev(
      { payload: {}, headers: { "Stripe-Signature": "t=0,v1=a" } },
      { apiKey: "k", fetch: fetchSpy },
    );
    expect(called).toBe(false);
    expect(out.source).toBe("heuristic");
    expect(out.provider).toBe("stripe");
  });

  it("sends only schema and header names, never values", async () => {
    const capture: { body?: unknown; headers?: Record<string, string> } = {};
    await inferProviderWithJev(
      {
        payload: { email: "jane@example.com", api_key: "sk_live_abc", event: "user.created" },
        headers: { "X-Custom-Token": "supersecret", "content-type": "application/json" },
      },
      {
        apiKey: "k",
        fetch: fakeFetch({ provider: choice("custom", 0.9, { custom: 0.95 }) }, { capture }),
      },
    );
    const text = JSON.stringify(capture.body);
    expect(text).not.toContain("jane@example.com");
    expect(text).not.toContain("sk_live_abc");
    expect(text).not.toContain("supersecret");
    expect(text).not.toContain("user.created");
    const body = capture.body as { state: { header_names: string[] }; questions: Record<string, unknown> };
    expect(body.state.header_names).toEqual(["content-type", "x-custom-token"]);
    expect(Object.keys(body.questions)).toEqual(["provider", "event_type_field"]);
    expect(capture.headers?.authorization).toBe("Bearer k");
  });

  it("takes Jev's answer when it beats the rules and clears the floor", async () => {
    const out = await inferProviderWithJev(
      { payload: { repository: { full_name: "a/b" }, action: "opened" } },
      {
        apiKey: "k",
        fetch: fakeFetch({
          provider: choice("github", 0.8, { github: 0.9, stripe: 0.05, custom: 0.05 }),
        }),
      },
    );
    expect(out.source).toBe("jev");
    expect(out.provider).toBe("github");
    expect(out.confidence).toBe(0.8);
    expect(out.event_type).toBe("opened");
    expect(out.probabilities?.github).toBe(0.9);
    expect(out.why).toContain("Jev picked github");
  });

  it("keeps the heuristic answer when Jev is below the floor", async () => {
    const out = await inferProviderWithJev(
      { payload: { repository: { full_name: "a/b" } } },
      { apiKey: "k", fetch: fakeFetch({ provider: choice("shopify", 0.3, { shopify: 0.4 }) }) },
    );
    expect(out.source).toBe("heuristic");
    expect(out.provider).toBe("github");
    expect(out.probabilities?.shopify).toBe(0.4);
  });

  it("keeps the heuristic answer when its confidence ties or beats Jev", async () => {
    const out = await inferProviderWithJev(
      { payload: { event_type: "subscription_created", content: {} } }, // chargebee 0.8
      { apiKey: "k", fetch: fakeFetch({ provider: choice("custom", 0.8, { custom: 0.8 }) }) },
    );
    expect(out.source).toBe("heuristic");
    expect(out.provider).toBe("chargebee");
  });

  it("reads the event type from the field Jev names when rules find none", async () => {
    const out = await inferProviderWithJev(
      { payload: { kind: "order.paid", id: "abc" } },
      {
        apiKey: "k",
        fetch: fakeFetch({
          provider: choice("custom", 0.7, { custom: 0.8 }),
          event_type_field: choice("kind", 0.9, { kind: 0.95, id: 0.05 }),
        }),
      },
    );
    expect(out.source).toBe("jev");
    expect(out.event_type).toBe("order.paid");
    expect(out.why).toContain("`kind`");
  });

  it("ignores a low-confidence event-type field answer", async () => {
    const out = await inferProviderWithJev(
      { payload: { kind: "order.paid", id: "abc" } },
      {
        apiKey: "k",
        fetch: fakeFetch({
          provider: choice("custom", 0.7, { custom: 0.8 }),
          event_type_field: choice("id", 0.2, { kind: 0.5, id: 0.5 }),
        }),
      },
    );
    expect(out.event_type).toBeNull();
  });

  it("falls back to heuristics on HTTP errors and records the reason", async () => {
    const out = await inferProviderWithJev(
      { payload: { hello: "world" } },
      { apiKey: "k", fetch: fakeFetch({}, { status: 401 }) },
    );
    expect(out.source).toBe("heuristic");
    expect(out.provider).toBe("custom");
    expect(out.jev_error).toBe("HTTP 401");
  });

  it("falls back to heuristics when the network throws", async () => {
    const boom = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as Fetch;
    const out = await inferProviderWithJev({ payload: { hello: "world" } }, { apiKey: "k", fetch: boom });
    expect(out.source).toBe("heuristic");
    expect(out.jev_error).toContain("ECONNRESET");
  });

  it("falls back to heuristics on a timeout", async () => {
    const slow = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as Fetch;
    const out = await inferProviderWithJev(
      { payload: { hello: "world" } },
      { apiKey: "k", fetch: slow, timeoutMs: 10 },
    );
    expect(out.source).toBe("heuristic");
    expect(out.jev_error).toBe("request timed out");
  });

  it("falls back when Jev names a provider outside the label set", async () => {
    const out = await inferProviderWithJev(
      { payload: { hello: "world" } },
      { apiKey: "k", fetch: fakeFetch({ provider: choice("paddle", 0.9, { paddle: 0.9 }) }) },
    );
    expect(out.source).toBe("heuristic");
    expect(out.jev_error).toContain("paddle");
  });
});

describe("buildJevRequest", () => {
  it("omits the event-type question when no short string fields exist", () => {
    const req = buildJevRequest({ payload: { count: 1, nested: { type: "x" } } }, { apiKey: "k" });
    expect(Object.keys(req.questions)).toEqual(["provider"]);
    expect(req.model).toBe("jev-latest");
  });

  it("drops unsafe keys from the event-type candidates", () => {
    const req = buildJevRequest(
      { payload: { type: "a", "jane@example.com": "b", access_token: "c" } },
      { apiKey: "k" },
    );
    expect(Object.keys(req.questions.event_type_field!.criteria)).toEqual(["type", "none"]);
  });
});
