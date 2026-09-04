import type http from "node:http";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  CliRequestBodyTooLargeError,
  handleCliApi,
  handleEventPayload,
  MAX_CLI_REQUEST_BODY_BYTES,
  readJsonBody,
  type CliApiDeps,
} from "../src/cli-api.ts";
import { handleListenStream } from "../src/cli-events-stream.ts";
import { readResponseBytesLimited } from "../src/cli-bounded-io.ts";

function responseRecorder(): {
  res: http.ServerResponse;
  status: () => number;
  body: () => Record<string, unknown>;
} {
  let statusCode = 0;
  let bodyText = "";
  const res = {
    writeHead(status: number) {
      statusCode = status;
      return this;
    },
    end(value?: string) {
      bodyText = value ?? "";
      return this;
    },
  } as unknown as http.ServerResponse;
  return {
    res,
    status: () => statusCode,
    body: () => JSON.parse(bodyText) as Record<string, unknown>,
  };
}

function deps(fetchImpl: typeof fetch, pool?: pg.Pool): CliApiDeps {
  return {
    pool: pool ?? ({ query: vi.fn() } as unknown as pg.Pool),
    sentry: null,
    ingestBaseUrl: "https://ingest.example.test",
    ingestAdminToken: "test-only-admin-token",
    cloudflareAccountId: "account_test",
    cloudflareApiToken: "test-only-api-token",
    rawPayloadBucket: "raw-test",
    clickhouseUrl: "https://clickhouse.example.test",
    clickhouseUser: undefined,
    clickhousePassword: undefined,
    fetchImpl,
  };
}

describe("CLI payload read boundaries", () => {
  it("does not reflect an unknown authenticated CLI pathname", async () => {
    const pool = {
      query: vi.fn(async () => ({
        rows: [
          {
            pat_id: "pat_alpha",
            pat_name: "test",
            pat_created_at: "2026-08-27T00:00:00.000Z",
            pat_expires_at: null,
            pat_revoked_at: null,
            user_id: "usr_alpha",
            user_email: "member@example.test",
            workspace_id: "ws_alpha",
            workspace_name: "Alpha",
            workspace_status: "active",
            membership_role: "member",
          },
        ],
        rowCount: 1,
      })),
    } as unknown as pg.Pool;
    const req = {
      method: "GET",
      url: "/v1/cli/private-route-marker",
      headers: { authorization: "Bearer axe_pat_test_only" },
    } as unknown as http.IncomingMessage;
    const output = responseRecorder();

    await handleCliApi(
      req,
      output.res,
      deps(vi.fn() as unknown as typeof fetch, pool),
    );

    expect(output.status()).toBe(404);
    expect(output.body()).toEqual({
      error: "not_found",
      message: "CLI route not found.",
    });
    expect(JSON.stringify(output.body())).not.toContain("private-route-marker");
  });

  it("rejects an oversized request body before buffering the remainder", async () => {
    const req = {
      headers: {},
      async *[Symbol.asyncIterator]() {
        yield Buffer.alloc(MAX_CLI_REQUEST_BODY_BYTES + 1, 0x61);
        throw new Error("iterator should not advance past the oversized chunk");
      },
    } as unknown as http.IncomingMessage;

    await expect(readJsonBody(req)).rejects.toBeInstanceOf(
      CliRequestBodyTooLargeError,
    );
  });

  it("rejects an oversized declared request before reading a body chunk", async () => {
    const req = {
      headers: {
        "content-length": String(MAX_CLI_REQUEST_BODY_BYTES + 1),
      },
      [Symbol.asyncIterator]() {
        throw new Error("body must not be read after the size preflight fails");
      },
    } as unknown as http.IncomingMessage;

    await expect(readJsonBody(req)).rejects.toBeInstanceOf(
      CliRequestBodyTooLargeError,
    );
  });

  it("rejects a declared oversized upstream body without reading it", async () => {
    const response = new Response("ignored", {
      headers: { "content-length": "1024" },
    });
    await expect(readResponseBytesLimited(response, 8)).rejects.toThrow(
      "upstream_response_body_too_large",
    );
  });

  it("blocks a poisoned single-event key before the R2 request", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [{
        event_id: "evt_alpha",
        source_id: "src_alpha",
        received_at: "2026-08-27 00:00:00.000",
        content_type: "application/json",
        r2_key: "events/ws_victim/2026-08-27/evt_alpha",
        headers_json: "{}",
      }],
    }), { status: 200 })) as unknown as typeof fetch;
    const output = responseRecorder();

    await handleEventPayload(
      {} as http.IncomingMessage,
      output.res,
      {
        user_id: "usr_alpha",
        user_email: "member@example.test",
        workspace_id: "ws_alpha",
        workspace_name: "Alpha",
        token_id: "pat_alpha",
        token_name: "test",
        token_created_at: "2026-08-27T00:00:00.000Z",
        membership_role: "member",
      },
      deps(fetchImpl),
      "evt_alpha",
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(output.status()).toBe(502);
    expect(output.body()).toEqual({
      error: "raw_payload_unavailable",
      message: "Raw payload storage reference is invalid.",
    });
    expect(JSON.stringify(output.body())).not.toContain("ws_victim");
  });

  it("does not return a ClickHouse error body to the PAT client", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("private upstream diagnostic", { status: 500 })) as unknown as typeof fetch;
    const output = responseRecorder();

    await handleEventPayload(
      {} as http.IncomingMessage,
      output.res,
      {
        user_id: "usr_alpha",
        user_email: "member@example.test",
        workspace_id: "ws_alpha",
        workspace_name: "Alpha",
        token_id: "pat_alpha",
        token_name: "test",
        token_created_at: "2026-08-27T00:00:00.000Z",
        membership_role: "member",
      },
      deps(fetchImpl),
      "evt_alpha",
    );

    expect(output.status()).toBe(502);
    expect(JSON.stringify(output.body())).not.toContain("private upstream");
    expect(output.body()).toMatchObject({ message: "ClickHouse request failed." });
  });

  it("does not reflect requested identifiers when an event is absent", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;
    const output = responseRecorder();

    await handleEventPayload(
      {} as http.IncomingMessage,
      output.res,
      {
        user_id: "usr_alpha",
        user_email: "member@example.test",
        workspace_id: "workspace-private-marker",
        workspace_name: "Alpha",
        token_id: "pat_alpha",
        token_name: "test",
        token_created_at: "2026-08-27T00:00:00.000Z",
        membership_role: "member",
      },
      deps(fetchImpl),
      "event-private-marker",
    );

    expect(output.status()).toBe(404);
    expect(output.body()).toEqual({
      error: "event_not_found",
      message: "Event not found or no longer retained.",
    });
    expect(JSON.stringify(output.body())).not.toContain("private-marker");
  });

  it("returns value-free headers for a single event and never selects the historical map", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{
          event_id: "evt_alpha",
          source_id: "src_alpha",
          received_at: "2026-08-27 00:00:00.000",
          content_type: "application/json",
          r2_key: "events/ws_alpha/2026-08-27/evt_alpha",
          headers_json: JSON.stringify({
            "x-customer-ref": "secret-under-innocuous-header-name",
          }),
        }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch;
    const output = responseRecorder();

    await handleEventPayload(
      {} as http.IncomingMessage,
      output.res,
      {
        user_id: "usr_alpha",
        user_email: "member@example.test",
        workspace_id: "ws_alpha",
        workspace_name: "Alpha",
        token_id: "pat_alpha",
        token_name: "test",
        token_created_at: "2026-08-27T00:00:00.000Z",
        membership_role: "member",
      },
      deps(fetchImpl),
      "evt_alpha",
    );

    expect(output.status()).toBe(200);
    expect(output.body().headers).toEqual({});
    expect(JSON.stringify(output.body())).not.toContain("secret-under-innocuous");
    expect(String(fetchImpl.mock.calls[0]?.[0])).not.toContain("headers_json");
  });

  it("drops a poisoned listen row without issuing an R2 request", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [{
        event_id: "evt_alpha",
        source_id: "src_alpha",
        received_at_text: "2026-08-27 00:00:00.000",
        content_type: "application/json",
        r2_key: "events/ws_victim/2026-08-27/evt_alpha",
        headers_json: "{}",
      }],
    }), { status: 200 })) as unknown as typeof fetch;
    const pool = {
      query: vi.fn(async () => ({ rows: [{ id: "src_alpha" }], rowCount: 1 })),
    } as unknown as pg.Pool;
    const output = responseRecorder();

    await handleListenStream(
      output.res,
      { workspace_id: "ws_alpha" },
      deps(fetchImpl, pool),
      new URL(
        "https://delivery.example.test/v1/cli/events?source_id=src_alpha&since=2026-08-27T00:00:00.000Z",
      ),
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(output.status()).toBe(200);
    expect(output.body()).toMatchObject({ events: [] });
  });

  it("does not reflect a missing source identifier", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const pool = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    } as unknown as pg.Pool;
    const output = responseRecorder();

    await handleListenStream(
      output.res,
      { workspace_id: "ws_alpha" },
      deps(fetchImpl, pool),
      new URL(
        "https://delivery.example.test/v1/cli/events?source_id=source-private-marker&since=2026-08-27T00:00:00.000Z",
      ),
    );

    expect(output.status()).toBe(404);
    expect(output.body()).toEqual({
      error: "source_not_found",
      message: "Source not found in this workspace.",
    });
    expect(JSON.stringify(output.body())).not.toContain("private-marker");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
