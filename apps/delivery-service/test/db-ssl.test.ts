import { describe, expect, it } from "vitest";
import {
  customerDbSslDecision,
  isTlsCertVerificationError,
  pgSslOption,
  postgresJsSslOption,
  pullPgSslOption,
  withMongoTlsNoVerify,
  withNoVerifySslMode,
} from "@axel/shared";

describe("customerDbSslDecision", () => {
  it("verifies by default for a remote DB with no sslmode", () => {
    expect(customerDbSslDecision("postgres://u:p@db.example.com:5432/app")).toBe("verify");
  });

  it("verifies even when the connection string says sslmode=require", () => {
    // libpq's `require` means encrypt-but-don't-verify; we deliberately override
    // it to verify — that MITM-open posture is exactly what this fix closes.
    expect(customerDbSslDecision("postgres://u:p@db.example.com/app?sslmode=require")).toBe(
      "verify",
    );
  });

  it("honours sslmode=no-verify as the explicit opt-out", () => {
    expect(customerDbSslDecision("postgres://u:p@db.example.com/app?sslmode=no-verify")).toBe(
      "no-verify",
    );
  });

  it("honours sslmode=disable", () => {
    expect(customerDbSslDecision("postgres://u:p@db.example.com/app?sslmode=disable")).toBe(
      "disable",
    );
  });

  it("disables TLS for loopback hosts", () => {
    expect(customerDbSslDecision("postgres://u:p@localhost:5432/app")).toBe("disable");
    expect(customerDbSslDecision("postgres://u:p@127.0.0.1:5432/app")).toBe("disable");
  });

  it("does not treat a password containing 'localhost' as a loopback host", () => {
    expect(customerDbSslDecision("postgres://u:localhost@db.example.com/app")).toBe("verify");
  });

  it("falls back to a query scan when the DSN is not URL-parseable", () => {
    // '@' in the password breaks new URL(); the regex fallback still finds sslmode.
    expect(customerDbSslDecision("postgres://u:p@ss@db.example.com/app?sslmode=no-verify")).toBe(
      "no-verify",
    );
  });
});

describe("pgSslOption (node-postgres)", () => {
  it("verifies by default", () => {
    expect(pgSslOption("postgres://u:p@db.example.com/app")).toEqual({ rejectUnauthorized: true });
  });
  it("skips verification on no-verify", () => {
    expect(pgSslOption("postgres://u:p@db.example.com/app?sslmode=no-verify")).toEqual({
      rejectUnauthorized: false,
    });
  });
  it("disables TLS on disable / loopback", () => {
    expect(pgSslOption("postgres://u:p@db.example.com/app?sslmode=disable")).toBe(false);
    expect(pgSslOption("postgres://u:p@localhost/app")).toBe(false);
  });
});

describe("postgresJsSslOption (postgres.js)", () => {
  it("verify-full by default", () => {
    expect(postgresJsSslOption("postgres://u:p@db.example.com/app")).toBe("verify-full");
  });
  it("require (encrypt, no verify) on no-verify", () => {
    expect(postgresJsSslOption("postgres://u:p@db.example.com/app?sslmode=no-verify")).toBe(
      "require",
    );
  });
  it("false on disable / loopback", () => {
    expect(postgresJsSslOption("postgres://u:p@db.example.com/app?sslmode=disable")).toBe(false);
    expect(postgresJsSslOption("postgres://u:p@localhost/app")).toBe(false);
  });
});

describe("pullPgSslOption", () => {
  it("verifies by default (host/port source, no ssl field)", () => {
    expect(pullPgSslOption({})).toEqual({ rejectUnauthorized: true });
  });
  it("respects the explicit ssl config field over the connection string", () => {
    expect(pullPgSslOption({ ssl: "disable", connection_string: "postgres://h/db" })).toBe(false);
    expect(pullPgSslOption({ ssl: "no-verify" })).toEqual({ rejectUnauthorized: false });
  });
  it("treats require/prefer as verify", () => {
    expect(pullPgSslOption({ ssl: "require" })).toEqual({ rejectUnauthorized: true });
    expect(pullPgSslOption({ ssl: "prefer" })).toEqual({ rejectUnauthorized: true });
  });
  it("falls back to the connection string's sslmode when ssl field is unset", () => {
    expect(
      pullPgSslOption({ connection_string: "postgres://u:p@db.example.com/app?sslmode=no-verify" }),
    ).toEqual({ rejectUnauthorized: false });
  });
});

describe("withNoVerifySslMode", () => {
  it("appends sslmode=no-verify with a ? when the DSN has no query string", () => {
    expect(withNoVerifySslMode("postgres://u:p@db.example.com/app")).toBe(
      "postgres://u:p@db.example.com/app?sslmode=no-verify",
    );
  });

  it("appends with an & when the DSN already has a query string", () => {
    expect(withNoVerifySslMode("postgres://u:p@db.example.com/app?connect_timeout=5")).toBe(
      "postgres://u:p@db.example.com/app?connect_timeout=5&sslmode=no-verify",
    );
  });

  it("leaves an existing no-verify / disable untouched (already permissive, non-conflicting)", () => {
    const already = "postgres://u:p@db.example.com/app?sslmode=no-verify";
    expect(withNoVerifySslMode(already)).toBe(already);
    const disabled = "postgres://u:p@db.example.com/app?sslmode=disable";
    expect(withNoVerifySslMode(disabled)).toBe(disabled);
  });

  it("overrides a verify-inducing mode — the explicit toggle wins over require", () => {
    // Railway/Heroku hand out ?sslmode=require; our policy maps require→verify,
    // so leaving it would re-trap the operator in the same self-signed failure.
    expect(withNoVerifySslMode("postgres://u:p@db.example.com/app?sslmode=require")).toBe(
      "postgres://u:p@db.example.com/app?sslmode=no-verify",
    );
    expect(
      withNoVerifySslMode("postgres://u:p@db.example.com/app?sslmode=verify-full&connect_timeout=5"),
    ).toBe("postgres://u:p@db.example.com/app?sslmode=no-verify&connect_timeout=5");
  });

  it("appends even when the DSN is not URL-parseable (@ in password)", () => {
    // The whole point: this is the case the operator can't easily hand-fix.
    expect(withNoVerifySslMode("postgres://u:p@ss@db.example.com/app")).toBe(
      "postgres://u:p@ss@db.example.com/app?sslmode=no-verify",
    );
  });

  it("round-trips to a no-verify decision", () => {
    expect(customerDbSslDecision(withNoVerifySslMode("postgres://u:p@db.example.com/app"))).toBe(
      "no-verify",
    );
  });
});

describe("withMongoTlsNoVerify", () => {
  it("appends tlsAllowInvalidCertificates=true when absent", () => {
    expect(withMongoTlsNoVerify("mongodb://u:p@host:27017/db")).toBe(
      "mongodb://u:p@host:27017/db?tlsAllowInvalidCertificates=true",
    );
    expect(withMongoTlsNoVerify("mongodb+srv://u:p@c.example.mongodb.net/db?retryWrites=true")).toBe(
      "mongodb+srv://u:p@c.example.mongodb.net/db?retryWrites=true&tlsAllowInvalidCertificates=true",
    );
  });

  it("leaves an already-permissive URI untouched (=true or tlsInsecure)", () => {
    const already = "mongodb://u:p@host/db?tlsAllowInvalidCertificates=true";
    expect(withMongoTlsNoVerify(already)).toBe(already);
    const insecure = "mongodb://u:p@host/db?tlsInsecure=true";
    expect(withMongoTlsNoVerify(insecure)).toBe(insecure);
  });

  it("normalises a stale =false to =true (explicit toggle wins), preserving key casing", () => {
    expect(withMongoTlsNoVerify("mongodb://u:p@host/db?tls=true&tlsAllowInvalidCertificates=false")).toBe(
      "mongodb://u:p@host/db?tls=true&tlsAllowInvalidCertificates=true",
    );
    // MongoDB option keys are case-insensitive; a lowercased key still matches.
    expect(withMongoTlsNoVerify("mongodb://u:p@host/db?tlsallowinvalidcertificates=false")).toBe(
      "mongodb://u:p@host/db?tlsallowinvalidcertificates=true",
    );
  });
});

describe("isTlsCertVerificationError", () => {
  it("detects the self-signed OpenSSL code", () => {
    expect(isTlsCertVerificationError({ code: "SELF_SIGNED_CERT_IN_CHAIN" })).toBe(true);
    expect(isTlsCertVerificationError({ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" })).toBe(true);
  });

  it("detects the code nested in a cause chain (pg wraps the TLS error)", () => {
    expect(
      isTlsCertVerificationError(
        Object.assign(new Error("connection error"), {
          cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" },
        }),
      ),
    ).toBe(true);
  });

  it("falls back to the message when the code is absent", () => {
    expect(isTlsCertVerificationError(new Error("self-signed certificate in certificate chain"))).toBe(
      true,
    );
    // Older OpenSSL builds omit the hyphen.
    expect(isTlsCertVerificationError(new Error("self signed certificate in certificate chain"))).toBe(
      true,
    );
  });

  it("detects the reason in a wrapped message deeper in the cause chain (Mongo shape)", () => {
    expect(
      isTlsCertVerificationError(
        Object.assign(new Error("Server selection timed out"), {
          cause: new Error("unable to get local issuer certificate"),
        }),
      ),
    ).toBe(true);
  });

  it("does not flag unrelated failures (auth, expiry, hostname mismatch)", () => {
    expect(isTlsCertVerificationError(new Error("password authentication failed"))).toBe(false);
    expect(isTlsCertVerificationError({ code: "CERT_HAS_EXPIRED" })).toBe(false);
    expect(isTlsCertVerificationError({ code: "ERR_TLS_CERT_ALTNAME_INVALID" })).toBe(false);
    expect(isTlsCertVerificationError(undefined)).toBe(false);
  });
});
