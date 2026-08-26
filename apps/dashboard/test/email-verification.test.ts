import { beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { capturingPg } from "@axel/test-utils";

// Style B (module mock): exercise the email-verification token store against
// a capturing fake { query } injected via the mocked db, asserting the SQL it
// emits — hash-at-rest, single-use, TTL. No real Postgres.

const fakePg = capturingPg();
const { calls: pgCalls, responses: pgResponses } = fakePg;

vi.mock("../lib/db", () => fakePg.dbModule());

vi.mock("../lib/ids", () => ({
  prefixedId: (prefix: string) => `${prefix}_test`,
  slugifyWorkspaceName: (s: string) => s,
}));

describe("email verification tokens", () => {
  beforeEach(() => {
    pgCalls.length = 0;
    pgResponses.length = 0;
  });

  it("issues a token, persisting only the sha256 hash with a 24h expiry", async () => {
    const { issueEmailVerificationToken, hashVerificationToken } = await import(
      "../lib/email-verification"
    );
    const before = Date.now();
    const { token, expiresAt } = await issueEmailVerificationToken("usr_1", "1.2.3.4");

    // Pre-clears surplus live tokens (bounded per user), then inserts.
    const cleanup = pgCalls.find((c) => /DELETE FROM email_verifications/.test(c.sql));
    expect(cleanup?.params).toEqual(["usr_1", 3]);

    const insert = pgCalls.find((c) => /INSERT INTO email_verifications/.test(c.sql));
    expect(insert).toBeDefined();
    expect(insert?.params[0]).toBe("evr_test");
    expect(insert?.params[1]).toBe("usr_1");
    // Never the plaintext — the stored value is sha256(token).
    expect(insert?.params[2]).not.toBe(token);
    expect(insert?.params[2]).toBe(hashVerificationToken(token));
    expect(insert?.params[4]).toBe("1.2.3.4");

    const ttlMs = expiresAt.getTime() - before;
    expect(ttlMs).toBeGreaterThan(23.9 * 60 * 60 * 1000);
    expect(ttlMs).toBeLessThan(24.1 * 60 * 60 * 1000);
  });

  it("looks tokens up by hash, only while unused and unexpired", async () => {
    const { findValidEmailVerificationToken, hashVerificationToken } = await import(
      "../lib/email-verification"
    );
    pgResponses.push({
      rows: [{ verification_id: "evr_test", user_id: "usr_1", email: "a@b.co" }],
    });
    const lookup = await findValidEmailVerificationToken("tok_plain");
    expect(lookup?.user_id).toBe("usr_1");

    const select = pgCalls[0];
    expect(select?.sql).toMatch(/used_at IS NULL/);
    expect(select?.sql).toMatch(/expires_at > now\(\)/);
    expect(select?.params[0]).toBe(hashVerificationToken("tok_plain"));
  });

  it("returns null for an unknown token", async () => {
    const { findValidEmailVerificationToken } = await import("../lib/email-verification");
    expect(await findValidEmailVerificationToken("nope")).toBeNull();
  });

  it("refuses to mark an already-used token (single redemption)", async () => {
    const { markEmailVerificationUsed } = await import("../lib/email-verification");
    const client = {
      query: async (sql: string) => {
        pgCalls.push({ sql, params: [] });
        return { rows: [], rowCount: 0 };
      },
    };
    await expect(
      markEmailVerificationUsed("evr_test", client as unknown as pg.PoolClient),
    ).rejects.toThrow("verification_token_already_used");
    expect(pgCalls[0]?.sql).toMatch(/used_at IS NULL/);
  });
});
