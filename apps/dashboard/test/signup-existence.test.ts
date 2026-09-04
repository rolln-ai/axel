import { beforeEach, describe, expect, it, vi } from "vitest";
import { capturingPg } from "@axel/test-utils";

// Style B (module mock): exercise signUp against a capturing fake { query }
// injected via the mocked db/withTransaction. Locks the anti-enumeration
// contract: the public signup form returns the IDENTICAL generic notice for a
// brand-new address and an already-registered one — the fork happens in the
// mailbox (verification link vs "you already have an account" note), never in
// the response. No real Postgres, no real email.

const pg = capturingPg();
const { calls: pgCalls, responses: pgResponses } = pg;

vi.mock("../lib/db", () => pg.dbModule());

// Deterministic (not counter-based) so assertions hold regardless of how many
// signUp runs precede them in this file.
vi.mock("../lib/ids", () => ({
  prefixedId: (prefix: string) => `${prefix}_test`,
  slugifyWorkspaceName: (s: string) => s,
}));

const createSession = vi.fn(async (_userId: string) => {});
vi.mock("../lib/session", () => ({
  createSession: (userId: string) => createSession(userId),
  destroySession: vi.fn(async () => {}),
  requireSession: vi.fn(),
  requireAuthenticatedUser: vi.fn(),
  setActiveWorkspaceId: vi.fn(async () => {}),
}));

// Auth rate limits are Postgres-backed; stub them out so the scripted FIFO
// only answers signUp's own queries.
vi.mock("../lib/rate-limit", () => ({
  enforceAuthRateLimits: vi.fn(async () => null),
  rateLimitMessage: () => "rate limited",
}));

const sentEmails: Array<{ to: string; subject: string }> = [];
vi.mock("../lib/email", () => ({
  sendEmail: vi.fn(async (args: { to: string; subject: string }) => {
    sentEmails.push({ to: args.to, subject: args.subject });
    return { ok: true };
  }),
}));

const issuedTokensFor: string[] = [];
vi.mock("../lib/email-verification", () => ({
  issueEmailVerificationToken: vi.fn(async (userId: string) => {
    issuedTokensFor.push(userId);
    return { token: "tok_test", expiresAt: new Date(Date.now() + 86_400_000) };
  }),
  findValidEmailVerificationToken: vi.fn(async () => null),
  markEmailVerificationUsed: vi.fn(async () => {}),
}));

vi.mock("../lib/admin-signup-alert", () => ({
  sendAdminSignupAlert: vi.fn(async () => ({ errors: [] })),
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

function signupForm(email: string): FormData {
  const fd = new FormData();
  fd.set("name", "Casey Operator");
  fd.set("email", email);
  fd.set("workspaceName", "Acme Webhooks");
  fd.set("password", "GoodPassword9");
  fd.set("acceptTerms", "on");
  return fd;
}

describe("signUp — account-existence leak closed", () => {
  beforeEach(() => {
    pgCalls.length = 0;
    pgResponses.length = 0;
    sentEmails.length = 0;
    issuedTokensFor.length = 0;
    createSession.mockClear();
  });

  async function runNewEmailSignup(): Promise<{ error?: string; notice?: string }> {
    // Transaction: existence SELECT finds nothing; the INSERTs succeed.
    pgResponses.push({ rows: [], rowCount: 0 });
    const { signUp } = await import("../lib/auth-actions");
    return signUp({}, signupForm("new@example.com"));
  }

  async function runExistingEmailSignup(): Promise<{ error?: string; notice?: string }> {
    // Transaction: existence SELECT finds the account → email_taken.
    pgResponses.push({ rows: [{ id: "usr_existing" }], rowCount: 1 });
    const { signUp } = await import("../lib/auth-actions");
    return signUp({}, signupForm("taken@example.com"));
  }

  it("returns the identical generic notice for new and already-registered emails", async () => {
    const fresh = await runNewEmailSignup();
    const taken = await runExistingEmailSignup();

    expect(fresh.error).toBeUndefined();
    expect(taken.error).toBeUndefined();
    expect(fresh.notice).toBeTruthy();
    expect(taken.notice).toBe(fresh.notice);
    // The old distinct error must never come back.
    expect(JSON.stringify(taken)).not.toMatch(/already has an account/i);
  });

  it("new address: creates the account unverified, emails a verification link, and does NOT auto-login", async () => {
    const result = await runNewEmailSignup();
    expect(result.notice).toBeTruthy();

    // users INSERT carries email_verified_at = null for public signups.
    const insertUser = pgCalls.find((c) => /INSERT INTO users/.test(c.sql));
    expect(insertUser?.sql).toMatch(/email_verified_at/);
    expect(insertUser?.params[4]).toBeNull();

    // Verification token issued for the new user, and its email sent.
    expect(issuedTokensFor).toEqual(["usr_test"]);
    expect(sentEmails.some((e) => /verify your email/i.test(e.subject) && e.to === "new@example.com")).toBe(true);

    // The response is a notice, not a session: auto-login would make the two
    // branches distinguishable (redirect vs notice, plus Set-Cookie).
    expect(createSession).not.toHaveBeenCalled();
  });

  it("existing address: emails the owner a 'you already have an account' note instead of leaking via the form", async () => {
    const result = await runExistingEmailSignup();
    expect(result.notice).toBeTruthy();

    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]?.to).toBe("taken@example.com");
    expect(sentEmails[0]?.subject).toMatch(/already have an axel account/i);

    // No account row written, no verification token, no session.
    expect(pgCalls.some((c) => /INSERT INTO users/.test(c.sql))).toBe(false);
    expect(issuedTokensFor).toHaveLength(0);
    expect(createSession).not.toHaveBeenCalled();
  });
});
