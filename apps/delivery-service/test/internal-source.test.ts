import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { sourceSigningSecretAadString } from "@axel/shared";
import {
  handleInternalSourceRequest,
  isInternalSecretAuthorized,
  loadInternalSource,
  resolveInternalSourceAuthSecrets,
  type InternalSourceRow,
  type SourceLookupPool,
} from "../src/internal-source.ts";

const SOURCE_LOOKUP_SECRET = "source-lookup-test-secret"; // gitleaks:allow
const PREVIOUS_SOURCE_LOOKUP_SECRET = "previous-source-lookup-test-secret"; // gitleaks:allow
const DELIVERY_SHARED_SECRET = "delivery-shared-test-secret"; // gitleaks:allow
const MASTER_KEY = Buffer.from(
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
  "hex",
); // gitleaks:allow

function encryptV1(plaintext: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", MASTER_KEY, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
}

function encryptV2(
  plaintext: string,
  workspaceId: string = "ws_1",
  sourceId: string = "src_1",
): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", MASTER_KEY, nonce);
  cipher.setAAD(Buffer.from(sourceSigningSecretAadString(workspaceId, sourceId), "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([0x02]), nonce, ciphertext, cipher.getAuthTag()]);
}

function sourceRow(overrides: Partial<InternalSourceRow> = {}): InternalSourceRow {
  return {
    id: "src_1",
    workspace_id: "ws_1",
    name: "Billing webhooks",
    secret_token_hash: "sha256-token-hash",
    status: "active",
    max_body_bytes: 2048,
    max_body_depth: 12,
    max_events_per_minute: 90,
    field_selection: ["customer.id", "amount"],
    provider: "stripe",
    signing_secret_ciphertext: encryptV2("whsec_current"),
    signing_secret_previous_ciphertext: encryptV1("whsec_previous"),
    redact_paths: ["customer.email"],
    ordering_enabled: true,
    ordering_key_header: "x-order-key",
    ordering_key_path: "customer.id",
    subject_key_paths: [{ loc: "body", path: "customer.id", kind: "id" }],
    inbound_ip_allowlist: ["10.0.0.0/8"],
    ...overrides,
  };
}

function fakePool(rows: InternalSourceRow[]): SourceLookupPool & { query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => ({ rows }));
  return { query } as unknown as SourceLookupPool & { query: ReturnType<typeof vi.fn> };
}

function request(
  body: string = JSON.stringify({ source_id: "src_1" }),
  providedSecret: string | undefined = SOURCE_LOOKUP_SECRET,
) {
  return {
    providedSecret,
    readBody: vi.fn(async () => body),
  };
}

describe("POST /internal/source", () => {
  it("uses delivery auth only as a bootstrap fallback", () => {
    expect(resolveInternalSourceAuthSecrets({
      DELIVERY_SHARED_SECRET,
    })).toEqual({
      current: DELIVERY_SHARED_SECRET,
      previous: "",
      usingDeliveryFallback: true,
    });
  });

  it("separates dedicated source auth and preserves an explicit rotation secret", () => {
    expect(resolveInternalSourceAuthSecrets({
      DELIVERY_SHARED_SECRET,
      SOURCE_LOOKUP_SHARED_SECRET: SOURCE_LOOKUP_SECRET,
      SOURCE_LOOKUP_SHARED_SECRET_PREVIOUS: PREVIOUS_SOURCE_LOOKUP_SECRET,
    })).toEqual({
      current: SOURCE_LOOKUP_SECRET,
      previous: PREVIOUS_SOURCE_LOOKUP_SECRET,
      usingDeliveryFallback: false,
    });
  });

  it("authenticates before reading the secret-bearing request", async () => {
    const req = request(undefined, "wrong-secret");
    const lookupSource = vi.fn();

    const response = await handleInternalSourceRequest(req, {
      sharedSecret: SOURCE_LOOKUP_SECRET,
      lookupSource,
    });

    expect(response.status).toBe(401);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({ ok: false, error: "unauthorized" });
    expect(req.readBody).not.toHaveBeenCalled();
    expect(lookupSource).not.toHaveBeenCalled();
  });

  it("accepts the previous source secret during a rotation window", async () => {
    const lookupSource = vi.fn(async () => null);
    const response = await handleInternalSourceRequest(
      request(undefined, PREVIOUS_SOURCE_LOOKUP_SECRET),
      {
        sharedSecret: SOURCE_LOOKUP_SECRET,
        previousSharedSecret: PREVIOUS_SOURCE_LOOKUP_SECRET,
        lookupSource,
      },
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ source: null });
    expect(lookupSource).toHaveBeenCalledOnce();
  });

  it("rejects delivery auth after dedicated source auth is configured", async () => {
    const req = request(undefined, DELIVERY_SHARED_SECRET);
    const lookupSource = vi.fn();
    const response = await handleInternalSourceRequest(req, {
      sharedSecret: SOURCE_LOOKUP_SECRET,
      lookupSource,
    });

    expect(response.status).toBe(401);
    expect(req.readBody).not.toHaveBeenCalled();
    expect(lookupSource).not.toHaveBeenCalled();
  });

  it("returns a generic validation error for invalid JSON", async () => {
    const response = await handleInternalSourceRequest(request("{secret parser detail"), {
      sharedSecret: SOURCE_LOOKUP_SECRET,
      lookupSource: vi.fn(),
    });

    expect(response.status).toBe(400);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({ ok: false, error: "invalid_body" });
    expect(JSON.stringify(response.body)).not.toContain("parser detail");
  });

  it("maps every Source field and decrypts current v2 + legacy v1 secrets", async () => {
    const pool = fakePool([sourceRow()]);
    const response = await handleInternalSourceRequest(request(), {
      sharedSecret: SOURCE_LOOKUP_SECRET,
      lookupSource: (sourceId) => loadInternalSource(pool, sourceId, MASTER_KEY),
    });

    expect(response.status).toBe(200);
    expect(response.headers).toMatchObject({
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("field_selection"),
      ["src_1"],
    );
    expect(response.body).toEqual({
      source: {
        source_id: "src_1",
        workspace_id: "ws_1",
        name: "Billing webhooks",
        secret_token: "sha256-token-hash",
        status: "active",
        max_body_bytes: 2048,
        max_body_depth: 12,
        max_events_per_minute: 90,
        field_selection: ["customer.id", "amount"],
        provider: "stripe",
        signing_secret: "whsec_current",
        signing_secret_previous: "whsec_previous",
        redact_paths: ["customer.email"],
        ordering_enabled: true,
        ordering_key_header: "x-order-key",
        ordering_key_path: "customer.id",
        subject_key_paths: [{ loc: "body", path: "customer.id", kind: "id" }],
        inbound_ip_allowlist: ["10.0.0.0/8"],
      },
    });
  });

  it("returns an explicit cacheable miss only when the database has no row", async () => {
    const pool = fakePool([]);
    const response = await handleInternalSourceRequest(request(), {
      sharedSecret: SOURCE_LOOKUP_SECRET,
      lookupSource: (sourceId) => loadInternalSource(pool, sourceId, MASTER_KEY),
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ source: null });
  });

  it("fails closed on v2 AAD mismatch and never exposes raw crypto errors", async () => {
    const transplanted = encryptV2("whsec_transplanted", "ws_other", "src_other");
    const pool = fakePool([sourceRow({ signing_secret_ciphertext: transplanted })]);
    const onError = vi.fn();

    const response = await handleInternalSourceRequest(request(), {
      sharedSecret: SOURCE_LOOKUP_SECRET,
      lookupSource: (sourceId) => loadInternalSource(pool, sourceId, MASTER_KEY),
      onError,
    });

    expect(response.status).toBe(503);
    expect(response.headers).toMatchObject({
      "cache-control": "no-store",
      "retry-after": "2",
    });
    expect(response.body).toEqual({ ok: false, error: "source_lookup_unavailable" });
    expect(JSON.stringify(response.body)).not.toContain("authenticate data");
    expect(onError).toHaveBeenCalledOnce();
  });

  it("fails closed when ciphertext exists but the master key is missing", async () => {
    const pool = fakePool([sourceRow()]);
    const response = await handleInternalSourceRequest(request(), {
      sharedSecret: SOURCE_LOOKUP_SECRET,
      lookupSource: (sourceId) => loadInternalSource(pool, sourceId, null),
    });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ ok: false, error: "source_lookup_unavailable" });
    expect(JSON.stringify(response.body)).not.toContain("CREDENTIALS_MASTER_KEY");
  });
});

describe("internal shared-secret comparison", () => {
  it("accepts only an exact string match", () => {
    expect(isInternalSecretAuthorized("same-secret", "same-secret")).toBe(true);
    expect(isInternalSecretAuthorized("same-secret-x", "same-secret")).toBe(false);
    expect(isInternalSecretAuthorized(["same-secret"], "same-secret")).toBe(false);
    expect(isInternalSecretAuthorized(undefined, "same-secret")).toBe(false);
    expect(isInternalSecretAuthorized("", "")).toBe(false);
  });
});
