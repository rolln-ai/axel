import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  audit: vi.fn(async () => undefined),
  create: vi.fn(),
  rotate: vi.fn(),
  tags: vi.fn(),
}));

vi.mock("../lib/destinations", () => ({
  createDestinationWithCredential: mocks.create,
  rotateDestinationCredentialBlob: mocks.rotate,
}));

vi.mock("../lib/with-mutation", () => ({
  withWorkspaceMutation: async (
    _options: unknown,
    fn: (context: unknown) => Promise<unknown>,
  ) => fn({
    workspaceId: "ws_test",
    actorUserId: "usr_test",
    audit: mocks.audit,
    tags: mocks.tags,
  }),
}));

vi.mock("../lib/db", () => ({
  db: () => ({ query: vi.fn() }),
}));

import {
  createDestination,
  rotateDestinationCredentials,
} from "../lib/destination-actions";

function webhookForm(): FormData {
  const form = new FormData();
  form.set("type", "webhook");
  form.set("name", "Production hook");
  form.set("url", "https://receiver.example.test/events");
  form.set("signing_secret", "whsec_test_fixture_only");
  return form;
}

function rotateForm(): FormData {
  const form = new FormData();
  form.set("destination_id", "dst_test");
  form.set("type", "webhook");
  form.set("signing_secret", "whsec_rotated_fixture_only");
  return form;
}

describe("destination action error privacy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a stable create error without reflecting an exception", async () => {
    const marker = "postgresql://user:marker-secret@private-db.internal/schema";
    mocks.create.mockRejectedValueOnce(new Error(`INSERT failed: ${marker}`));

    const result = await createDestination({}, webhookForm());

    expect(result).toEqual({ error: "Could not create the destination. Try again." });
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(JSON.stringify(result)).not.toContain("private-db.internal");
  });

  it("does not expose the credential-storage environment variable", async () => {
    mocks.create.mockRejectedValueOnce(
      new Error("CREDENTIALS_MASTER_KEY is not set: marker-secret"),
    );

    const result = await createDestination({}, webhookForm());

    expect(result).toEqual({
      error: "Secure credential storage is unavailable. Contact the operator.",
    });
    expect(JSON.stringify(result)).not.toContain("CREDENTIALS_MASTER_KEY");
    expect(JSON.stringify(result)).not.toContain("marker-secret");
  });

  it("keeps field validation specific without calling persistence", async () => {
    const form = webhookForm();
    form.delete("url");

    const result = await createDestination({}, form);

    expect(result).toEqual({ error: "Missing required field: Receiver URL." });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("returns a stable rotation error and preserves safe sentinel outcomes", async () => {
    const marker = "SELECT * FROM credentials WHERE secret='marker-secret'";
    mocks.rotate.mockRejectedValueOnce(new Error(marker));

    const failed = await rotateDestinationCredentials({}, rotateForm());
    expect(failed).toEqual({ error: "Could not rotate the credential. Try again." });
    expect(JSON.stringify(failed)).not.toContain(marker);

    mocks.rotate.mockRejectedValueOnce(new Error("destination_not_found"));
    await expect(rotateDestinationCredentials({}, rotateForm())).resolves.toEqual({
      error: "Destination not found in this workspace.",
    });

    mocks.rotate.mockRejectedValueOnce(new Error("no_secrets_to_rotate"));
    await expect(rotateDestinationCredentials({}, rotateForm())).resolves.toEqual({
      error: "This destination type doesn't have any rotatable credentials.",
    });
  });
});
