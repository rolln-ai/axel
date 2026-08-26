import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const configUrl = new URL("../next.config.mjs", import.meta.url).href;

function loadConfig(overrides: Partial<NodeJS.ProcessEnv>) {
  return spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", `await import(${JSON.stringify(configUrl)})`],
    {
      env: { ...process.env, ...overrides },
      encoding: "utf8",
    },
  );
}

function loadBuildOptions(overrides: Partial<NodeJS.ProcessEnv>): {
  status: number | null;
  stderr: string;
  options?: {
    authToken?: string;
    release?: { create?: boolean; finalize?: boolean };
  };
} {
  const marker = "__SENTRY_BUILD_OPTIONS__";
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const config = await import(${JSON.stringify(configUrl)}); process.stdout.write(${JSON.stringify(marker)} + JSON.stringify(config.sentryBuildOptions));`,
    ],
    {
      env: { ...process.env, ...overrides },
      encoding: "utf8",
    },
  );
  const markerIndex = result.stdout.lastIndexOf(marker);
  return {
    status: result.status,
    stderr: result.stderr,
    ...(markerIndex >= 0
      ? { options: JSON.parse(result.stdout.slice(markerIndex + marker.length)) }
      : {}),
  };
}

function loadDashboardEnv(overrides: Partial<NodeJS.ProcessEnv>): {
  status: number | null;
  stderr: string;
  env?: Record<string, string>;
} {
  const marker = "__DASHBOARD_ENV__";
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const config = await import(${JSON.stringify(configUrl)}); process.stdout.write(${JSON.stringify(marker)} + JSON.stringify(config.default.env));`,
    ],
    {
      env: { ...process.env, ...overrides },
      encoding: "utf8",
    },
  );
  const markerIndex = result.stdout.lastIndexOf(marker);
  return {
    status: result.status,
    stderr: result.stderr,
    ...(markerIndex >= 0
      ? { env: JSON.parse(result.stdout.slice(markerIndex + marker.length)) }
      : {}),
  };
}

describe("dashboard Sentry build config", () => {
  it("fails a hosted production build before deploying without an upload token", () => {
    const result = loadConfig({
      VERCEL: "1",
      CI: "1",
      VERCEL_ENV: "production",
      SENTRY_AUTH_TOKEN: "",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "SENTRY_AUTH_TOKEN is required for Vercel production builds",
    );
  });

  it("keeps preview builds credential-free", () => {
    const result = loadBuildOptions({
      VERCEL: "1",
      CI: "1",
      VERCEL_ENV: "preview",
      SENTRY_AUTH_TOKEN: "preview-integration-token",
    });

    expect(result.status).toBe(0);
    expect(result.options).not.toHaveProperty("authToken");
    expect(result.options?.release).toMatchObject({ create: false, finalize: false });
  });

  it("accepts a hosted production build when an upload token is present", () => {
    const result = loadBuildOptions({
      VERCEL: "1",
      CI: "1",
      VERCEL_ENV: "production",
      SENTRY_AUTH_TOKEN: "test-token",
    });

    expect(result.status).toBe(0);
    expect(result.options).toMatchObject({
      authToken: "test-token",
      release: { create: true, finalize: true },
    });
  });

  it("injects the server-preferred DSN into the browser bundle", () => {
    const result = loadDashboardEnv({
      VERCEL: "",
      CI: "",
      VERCEL_ENV: "",
      SENTRY_DSN: "https://server-preferred@example.invalid/1",
      NEXT_PUBLIC_SENTRY_DSN: "https://stale-public@example.invalid/2",
    });

    expect(result.status).toBe(0);
    expect(result.env?.NEXT_PUBLIC_SENTRY_DSN).toBe(
      "https://server-preferred@example.invalid/1",
    );
  });
});
