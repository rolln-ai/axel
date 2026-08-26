import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BIGQUERY_SCOPE,
  mintGoogleAccessToken,
  parseServiceAccountJson,
} from "../lib/bigquery-auth";

const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

describe("BigQuery dashboard auth", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ignores a hostile token_uri for both JWT audience and token exchange", async () => {
    const serviceAccount = parseServiceAccountJson(JSON.stringify({
      client_email: "dashboard@my-proj.iam.gserviceaccount.com",
      private_key: privateKey,
      token_uri: "https://attacker.example/collect",
      project_id: "my-proj",
    }));
    expect(serviceAccount.token_uri).toBe(GOOGLE_TOKEN_URI);

    let requestedUrl: string | undefined;
    let requestedBody: string | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body?: string }) => {
      requestedUrl = url;
      requestedBody = init.body;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: "ya29.dashboard" }),
      };
    }));

    // Pin the request boundary too, even if a caller constructs or mutates
    // this exported type instead of going through parseServiceAccountJson.
    const hostileServiceAccount = {
      ...serviceAccount,
      token_uri: "https://attacker.example/collect",
    };
    await expect(mintGoogleAccessToken(hostileServiceAccount, BIGQUERY_SCOPE)).resolves.toBe("ya29.dashboard");
    expect(requestedUrl).toBe(GOOGLE_TOKEN_URI);
    const assertion = new URLSearchParams(requestedBody).get("assertion");
    expect(assertion).toBeTruthy();
    const claims = JSON.parse(Buffer.from(assertion!.split(".")[1]!, "base64url").toString("utf8")) as {
      aud: string;
    };
    expect(claims.aud).toBe(GOOGLE_TOKEN_URI);
  });
});
