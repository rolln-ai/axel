import { afterEach, describe, expect, it, vi } from "vitest";
import type { Destination } from "@axel/shared";
import { createS3Connector, closeAllS3Clients, flushAllS3ParquetBatches } from "../src/connectors/s3.ts";

const sendMock = vi.hoisted(() => vi.fn());
const clientConfigMock = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/client-s3", () => ({
  PutObjectCommand: class PutObjectCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  S3Client: class S3Client {
    constructor(config: unknown) {
      clientConfigMock(config);
    }
    send = sendMock;
    destroy = vi.fn();
  },
}));

describe("delivery-service S3 connector", () => {
  afterEach(async () => {
    await flushAllS3ParquetBatches();
    sendMock.mockReset();
    clientConfigMock.mockReset();
    vi.unstubAllEnvs();
    closeAllS3Clients();
  });

  it("writes the event payload to the configured bucket/key", async () => {
    sendMock.mockResolvedValue({});
    const connector = createS3Connector();

    const out = await connector.deliver(
      new TextEncoder().encode(JSON.stringify({ hello: "world" })).buffer,
      destination(),
      { eventId: "evt-1" },
    );

    expect(out.status).toBe("success");
    expect(out.response).toMatchObject({ bucket: "archive", key: "axel/2026-05-02/evt-1.json" });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[0].input).toMatchObject({
      Bucket: "archive",
      Key: "axel/2026-05-02/evt-1.json",
      ContentType: "application/json",
      Metadata: {
        event_id: "evt-1",
        workspace_id: "ws-1",
      },
    });
  });

  it("classifies credential and bucket errors as terminal", async () => {
    sendMock.mockRejectedValue(new Error("AccessDenied: bad key"));
    const connector = createS3Connector();

    const out = await connector.deliver(new ArrayBuffer(0), destination(), { eventId: "evt-1" });

    expect(out.status).toBe("dead");
    expect(out.response).toMatchObject({ error: "AccessDenied: bad key" });
  });

  it("classifies transient S3 errors as retryable", async () => {
    sendMock.mockRejectedValue(new Error("socket hang up"));
    const connector = createS3Connector();

    const out = await connector.deliver(new ArrayBuffer(0), destination(), { eventId: "evt-1" });

    expect(out.status).toBe("retry");
  });

  it("dead-letters a token error carried on err.name / $metadata, not the message (ROL-207)", async () => {
    // AWS SDK v3 shape: the code is on `.name`; the message has no code string.
    const tokenErr = Object.assign(
      new Error("The security token included in the request is invalid."),
      { name: "InvalidClientTokenId", $metadata: { httpStatusCode: 403 } },
    );
    sendMock.mockRejectedValue(tokenErr);
    const connector = createS3Connector();

    const out = await connector.deliver(new ArrayBuffer(0), destination(), { eventId: "evt-1" });

    expect(out.status).toBe("dead");
  });

  it("dead-letters a bare 401 auth failure via $metadata status (ROL-207)", async () => {
    const authErr = Object.assign(new Error("Unauthorized"), {
      $metadata: { httpStatusCode: 401 },
    });
    sendMock.mockRejectedValue(authErr);
    const connector = createS3Connector();

    const out = await connector.deliver(new ArrayBuffer(0), destination(), { eventId: "evt-1" });

    expect(out.status).toBe("dead");
  });

  it("honors virtual-hosted addressing for S3-compatible endpoints", async () => {
    sendMock.mockResolvedValue({});
    const connector = createS3Connector();

    const out = await connector.deliver(
      new ArrayBuffer(0),
      destination({
        endpoint: "https://t3.storage.dev",
        addressing_style: "virtual_hosted",
      }),
      { eventId: "evt-1" },
    );

    expect(out.status).toBe("success");
    expect(clientConfigMock).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: "https://t3.storage.dev",
      forcePathStyle: false,
    }));
  });

  it("batches parquet events into one S3 object", async () => {
    sendMock.mockResolvedValue({});
    vi.stubEnv("S3_PARQUET_BATCH_MAX_ROWS", "2");
    const connector = createS3Connector();

    const first = connector.deliver(
      encode({ hello: "world" }),
      destination(),
      {
        eventId: "evt-1",
        workspaceId: "ws-1",
        sourceId: "src-1",
        routeId: "rt-1",
        receivedAt: "2026-05-02T12:00:00.000Z",
        binding: { key_prefix: "lake/", format: "parquet" },
      },
    );
    const second = connector.deliver(
      encode({ hello: "again" }),
      destination(),
      {
        eventId: "evt-2",
        workspaceId: "ws-1",
        sourceId: "src-1",
        routeId: "rt-1",
        receivedAt: "2026-05-02T12:00:01.000Z",
        binding: { key_prefix: "lake/", format: "parquet" },
      },
    );

    const [out1, out2] = await Promise.all([first, second]);

    expect(out1.status).toBe("success");
    expect(out2.status).toBe("success");
    expect(out1.response).toMatchObject({ bucket: "archive", format: "parquet", rows: 2 });
    expect(sendMock).toHaveBeenCalledTimes(1);
    const input = sendMock.mock.calls[0]?.[0].input as {
      Bucket: string;
      Key: string;
      Body: Buffer;
      ContentType: string;
      Metadata: Record<string, string>;
    };
    expect(input).toMatchObject({
      Bucket: "archive",
      ContentType: "application/vnd.apache.parquet",
      Metadata: {
        format: "parquet",
        row_count: "2",
        workspace_id: "ws-1",
        route_id: "rt-1",
      },
    });
    expect(input.Key).toMatch(/^lake\/\d{4}-\d{2}-\d{2}\/part-batch_[a-z0-9]+_[a-z0-9]+\.parquet$/);
    expect(Buffer.isBuffer(input.Body)).toBe(true);
    expect(input.Body.subarray(0, 4).toString("utf8")).toBe("PAR1");
    expect(input.Body.subarray(input.Body.length - 4).toString("utf8")).toBe("PAR1");
  });

  it("flushes a parquet batch when the byte target is reached", async () => {
    sendMock.mockResolvedValue({});
    // 1 MiB target (the floor); row cap stays at its high default so the
    // size target is the only trigger that can fire here.
    vi.stubEnv("S3_PARQUET_TARGET_BYTES", String(1024 * 1024));
    const connector = createS3Connector();
    const big = () => encode({ blob: "x".repeat(600_000) }); // ~600 KB each

    const ctx = (eventId: string) => ({
      eventId,
      workspaceId: "ws-1",
      sourceId: "src-1",
      routeId: "rt-1",
      receivedAt: "2026-05-02T12:00:00.000Z",
      binding: { key_prefix: "lake/", format: "parquet" as const },
    });

    // First ~600 KB event stays buffered (under 1 MiB); the second crosses
    // the target and flushes both into a single object.
    const first = connector.deliver(big(), destination(), ctx("evt-1"));
    const second = connector.deliver(big(), destination(), ctx("evt-2"));
    const [out1, out2] = await Promise.all([first, second]);

    expect(out1.status).toBe("success");
    expect(out2.status).toBe("success");
    expect(out1.response).toMatchObject({ format: "parquet", rows: 2 });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});

type TestS3Config = {
  bucket: string;
  region: string;
  access_key_id: string;
  secret_access_key: string;
  key_prefix: string;
  key_template: string;
  endpoint?: string;
  addressing_style?: "path" | "virtual_hosted";
};

function destination(overrides: Partial<TestS3Config> = {}): Destination<TestS3Config> {
  return {
    destination_id: "dest-1",
    workspace_id: "ws-1",
    type: "s3",
    credentials_ref: "cred-1",
    config: {
      bucket: "archive",
      region: "us-east-1",
      access_key_id: "key",
      secret_access_key: "secret",
      key_prefix: "axel/",
      key_template: "2026-05-02/{event_id}.json",
      ...overrides,
    },
  };
}

function encode(value: unknown): ArrayBuffer {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}
