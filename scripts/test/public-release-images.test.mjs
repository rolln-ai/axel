import assert from "node:assert/strict";
import test from "node:test";
import { verifyPublicImage } from "../verify-public-release-images.mjs";

const digest = `sha256:${"a".repeat(64)}`;
function registry({ tokenStatus = 200, manifestStatus = 200, architectures = ["amd64", "arm64"], contentDigest = digest } = {}) {
  const calls = [];
  return {
    calls,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.startsWith("https://ghcr.io/token?")) {
        assert.equal(options.headers, undefined, "Token request must be anonymous");
        return Response.json({ token: "anonymous-pull-token" }, { status: tokenStatus });
      }
      assert.equal(options.headers.authorization, "Bearer anonymous-pull-token");
      return Response.json({ manifests: [
        ...architectures.map((architecture) => ({ platform: { os: "linux", architecture } })),
        { platform: { os: "unknown", architecture: "unknown" } },
      ] }, { status: manifestStatus, headers: { "docker-content-digest": contentDigest } });
    },
  };
}

test("release metadata comes from an anonymous multi-architecture manifest", async () => {
  const mock = registry();
  assert.deepEqual(await verifyPublicImage("rolln-ai/axel-dashboard", "0.1.0", mock.fetch), {
    image: "ghcr.io/rolln-ai/axel-dashboard:0.1.0", digest, platforms: ["amd64", "arm64"],
  });
  assert.equal(mock.calls.length, 2);
  assert.ok(mock.calls.every(({ options }) => options.redirect === "error" && options.signal));
});

test("private or absent packages cannot pass the release gate", async () => {
  await assert.rejects(verifyPublicImage("rolln-ai/axel-dashboard", "0.1.0", registry({ tokenStatus: 403 }).fetch), /Anonymous registry token request failed/);
  for (const manifestStatus of [401, 403, 404, 503]) {
    await assert.rejects(verifyPublicImage("rolln-ai/axel-dashboard", "0.1.0", registry({ manifestStatus }).fetch), /not anonymously readable/);
  }
});

test("a single architecture or missing digest cannot produce release metadata", async () => {
  await assert.rejects(verifyPublicImage("rolln-ai/axel-dashboard", "0.1.0", registry({ architectures: ["amd64"] }).fetch), /must support/);
  await assert.rejects(verifyPublicImage("rolln-ai/axel-dashboard", "0.1.0", registry({ contentDigest: "latest" }).fetch), /invalid image digest/);
});

test("invalid image references never reach the registry", async () => {
  const mock = registry();
  for (const [repository, version] of [["../axel", "0.1.0"], ["rolln-ai/axel", "latest"], ["rolln-ai/axel", "0.1.0/path"]]) {
    await assert.rejects(verifyPublicImage(repository, version, mock.fetch), /Invalid release image reference/);
  }
  assert.equal(mock.calls.length, 0);
});
