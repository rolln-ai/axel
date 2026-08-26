import { beforeEach, describe, expect, it, vi } from "vitest";
import { capturingPg } from "@axel/test-utils";
import { hashPassword } from "../lib/passwords";

// Style B (module mock): verifyEmail token confirmation and signIn's returnTo
// handling, exercised against a capturing fake { query } and a sentinel
// redirect. The real lib/email-verification module runs here (only db is
// mocked) so the confirm path exercises its actual SQL.

const pg = capturingPg();
const { calls: pgCalls, responses: pgResponses } = pg;

vi.mock("../lib/db", () => pg.dbModule());

const createSession = vi.fn(async (_userId: string) => {});
vi.mock("../lib/session", () => ({
  createSession: (userId: string) => createSession(userId),
  destroySession: vi.fn(async () => {}),
  requireSession: vi.fn(),
  requireAuthenticatedUser: vi.fn(),
  setActiveWorkspaceId: vi.fn(async () => {}),
}));

vi.mock("../lib/rate-limit", () => ({
  enforceAuthRateLimits: vi.fn(async () => null),
  rateLimitMessage: () => "rate limited",
}));

vi.mock("next/cache", () => ({
  updateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Map(),
  cookies: async () => ({ get: () => undefined, set: vi.fn() }),
}));

// Sentinel redirect so tests can assert the destination without Next's
// internal NEXT_REDIRECT machinery.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  permanentRedirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

function formData(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

async function captureRedirect(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("REDIRECT:")) return message.slice("REDIRECT:".length);
    throw err;
  }
  throw new Error("expected a redirect");
}

const PASSWORD = "GoodPassword9";
const PASSWORD_HASH = hashPassword(PASSWORD);

describe("signIn — returnTo", () => {
  beforeEach(() => {
    pgCalls.length = 0;
    pgResponses.length = 0;
    createSession.mockClear();
  });

  async function signInWith(returnTo?: string): Promise<string> {
    pgResponses.push({ rows: [{ id: "usr_1", password_hash: PASSWORD_HASH }] });
    const { signIn } = await import("../lib/auth-actions");
    return captureRedirect(() =>
      signIn(
        {},
        formData({
          email: "a@b.co",
          password: PASSWORD,
          ...(returnTo !== undefined ? { returnTo } : {}),
        }),
      ),
    );
  }

  it("returns the user to the validated origin path", async () => {
    expect(await signInWith("/routes/abc?x=1")).toBe("/routes/abc?x=1");
    expect(createSession).toHaveBeenCalledWith("usr_1");
  });

  it("falls back to /dashboard when returnTo is absent", async () => {
    expect(await signInWith()).toBe("/dashboard");
  });

  it("rejects open-redirect material and falls back to /dashboard", async () => {
    expect(await signInWith("//evil.com")).toBe("/dashboard");
    expect(await signInWith("https://evil.com")).toBe("/dashboard");
    expect(await signInWith("/\\evil")).toBe("/dashboard");
  });
});

describe("verifyEmail — token confirmation", () => {
  beforeEach(() => {
    pgCalls.length = 0;
    pgResponses.length = 0;
    createSession.mockClear();
  });

  it("consumes the token, stamps users.email_verified_at, signs in, and lands on /dashboard", async () => {
    // (1) token lookup
    pgResponses.push({
      rows: [{ verification_id: "evr_1", user_id: "usr_9", email: "a@b.co" }],
    });
    // (2) mark token used — succeeds
    pgResponses.push({ rows: [], rowCount: 1 });
    // (3) UPDATE users … WHERE email_verified_at IS NULL — first verification
    pgResponses.push({ rows: [], rowCount: 1 });
    // (4) audit_log INSERT
    pgResponses.push({ rows: [], rowCount: 1 });

    const { verifyEmail } = await import("../lib/auth-actions");
    const dest = await captureRedirect(() => verifyEmail({}, formData({ token: "tok_1" })));

    expect(dest).toBe("/dashboard");
    expect(createSession).toHaveBeenCalledWith("usr_9");

    const markUsed = pgCalls.find((c) => /UPDATE email_verifications SET used_at/.test(c.sql));
    expect(markUsed?.params[0]).toBe("evr_1");

    const stamp = pgCalls.find((c) => /UPDATE users/.test(c.sql) && /email_verified_at = now\(\)/.test(c.sql));
    expect(stamp).toBeDefined();
    // Idempotence guard: a later token can never move an existing timestamp.
    expect(stamp?.sql).toMatch(/email_verified_at IS NULL/);
    expect(stamp?.params[0]).toBe("usr_9");

    const audit = pgCalls.find(
      (c) => /INSERT INTO audit_log/.test(c.sql) && c.params[2] === "user.email_verified",
    );
    // writeAudit param order: ws, actor, action, target_type, target_id, metadata
    expect(audit?.params).toEqual([null, "usr_9", "user.email_verified", "user", "usr_9", "{}"]);
  });

  it("rejects an expired or already-used token without creating a session", async () => {
    // Token lookup finds nothing.
    pgResponses.push({ rows: [], rowCount: 0 });
    const { verifyEmail } = await import("../lib/auth-actions");
    const result = await verifyEmail({}, formData({ token: "tok_stale" }));
    expect(result.error).toMatch(/expired or already been used/i);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("requires a token", async () => {
    const { verifyEmail } = await import("../lib/auth-actions");
    const result = await verifyEmail({}, formData({}));
    expect(result.error).toMatch(/missing or malformed/i);
  });
});
