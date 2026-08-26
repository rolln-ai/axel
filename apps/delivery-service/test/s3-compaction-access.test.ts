import { afterEach, describe, expect, it, vi } from "vitest";
import { createS3CompactionAccess } from "../src/connectors/s3-compaction-access.ts";

// One shared send mock; each command class tags its instances so the mock can
// branch by command type the way the real client does.
const sendMock = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/client-s3", () => {
  class Cmd {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return {
    S3Client: class S3Client {
      send = sendMock;
      destroy = vi.fn();
    },
    ListObjectsV2Command: class ListObjectsV2Command extends Cmd {},
    GetObjectCommand: class GetObjectCommand extends Cmd {},
    PutObjectCommand: class PutObjectCommand extends Cmd {},
    HeadObjectCommand: class HeadObjectCommand extends Cmd {
      readonly _kind = "head";
    },
    DeleteObjectsCommand: class DeleteObjectsCommand extends Cmd {
      readonly _kind = "delete";
    },
  };
});

const BASE = {
  region: "us-east-1",
  accessKeyId: "key",
  secretAccessKey: "secret",
} as const;

describe("createS3CompactionAccess — SSRF guard", () => {
  afterEach(() => sendMock.mockReset());

  it("throws when a custom endpoint targets a private/metadata host", () => {
    expect(() =>
      createS3CompactionAccess({ ...BASE, endpoint: "http://169.254.169.254" }),
    ).toThrow(/ssrf_blocked/);
  });

  it("builds a client for AWS (no endpoint) and for a safe public endpoint", () => {
    expect(() => createS3CompactionAccess({ ...BASE })).not.toThrow();
    expect(() =>
      createS3CompactionAccess({ ...BASE, endpoint: "https://t3.storage.dev" }),
    ).not.toThrow();
  });
});

describe("createS3CompactionAccess — exists() error classification", () => {
  afterEach(() => sendMock.mockReset());

  it("returns false ONLY for a genuine 404/NotFound", async () => {
    const access = createS3CompactionAccess({ ...BASE });
    sendMock.mockRejectedValueOnce(Object.assign(new Error("nope"), { name: "NotFound" }));
    expect(await access.exists("b", "missing")).toBe(false);

    sendMock.mockRejectedValueOnce(
      Object.assign(new Error("nope"), { $metadata: { httpStatusCode: 404 } }),
    );
    expect(await access.exists("b", "missing-2")).toBe(false);
  });

  it("returns true when HEAD succeeds", async () => {
    const access = createS3CompactionAccess({ ...BASE });
    sendMock.mockResolvedValueOnce({});
    expect(await access.exists("b", "present")).toBe(true);
  });

  it("re-throws a transient 5xx instead of misreporting absence", async () => {
    // A 5xx after a successful PUT must NOT be read as "object absent" — that
    // would let the verified-PUT gate delete sources whose merge actually
    // landed. The loop's per-job try/catch records this as a real error.
    const access = createS3CompactionAccess({ ...BASE });
    sendMock.mockRejectedValueOnce(
      Object.assign(new Error("internal"), { $metadata: { httpStatusCode: 503 } }),
    );
    await expect(access.exists("b", "k")).rejects.toThrow(/internal/);
  });
});

describe("createS3CompactionAccess — remove() failure surfacing", () => {
  afterEach(() => sendMock.mockReset());

  it("throws when DeleteObjects reports per-key Errors[]", async () => {
    const access = createS3CompactionAccess({ ...BASE });
    sendMock.mockResolvedValueOnce({
      Errors: [{ Key: "lake/a.parquet", Code: "AccessDenied", Message: "denied" }],
    });
    await expect(access.remove("b", ["lake/a.parquet"])).rejects.toThrow(
      /DeleteObjects reported 1 failure.*lake\/a\.parquet.*AccessDenied/,
    );
  });

  it("does not throw on a clean delete (Quiet:true → no Errors[])", async () => {
    const access = createS3CompactionAccess({ ...BASE });
    sendMock.mockResolvedValueOnce({});
    await expect(access.remove("b", ["lake/a.parquet"])).resolves.toBeUndefined();
  });

  it("is a no-op for an empty key list (no network call)", async () => {
    const access = createS3CompactionAccess({ ...BASE });
    await access.remove("b", []);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
