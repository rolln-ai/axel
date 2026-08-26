import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/node-sentry-fatal.ts", import.meta.url));
const tsx = `${packageRoot}/node_modules/.bin/tsx${process.platform === "win32" ? ".cmd" : ""}`;

function runFatalFixture(mode: "uncaught" | "rejection" | "timeout" | "duplicate") {
  return spawnSync(tsx, [fixture, mode], {
    cwd: packageRoot,
    encoding: "utf8",
    // The fixture itself has a one-second watchdog once Node starts. Keep the
    // outer allowance wider because a cold tsx process can start slowly while
    // every monorepo package is testing in parallel on a shared CI runner.
    timeout: 10_000,
  });
}

function captureLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line.startsWith("CAPTURE "));
}

describe("Node fatal Sentry handlers", () => {
  it.each([
    ["uncaught", "uncaught-probe", "uncaughtException"],
    ["rejection", "rejection-probe", "unhandledRejection"],
  ] as const)("captures and exits nonzero for %s failures", (mode, message, kind) => {
    const result = runFatalFixture(mode);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(captureLines(result.stdout)).toHaveLength(1);
    expect(result.stdout).toContain(`"message":"${message}"`);
    expect(result.stdout).toContain(`"kind":"${kind}"`);
    expect(result.stdout).toContain("EXIT 1 CAPTURES 1");
  });

  it("captures only the first fatal signal while the process is flushing", () => {
    const result = runFatalFixture("duplicate");

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(captureLines(result.stdout)).toHaveLength(1);
    expect(result.stdout).toContain("first-probe");
    expect(result.stdout).not.toContain("second-probe");
    expect(result.stdout).toContain("EXIT 1 CAPTURES 1");
  });

  it("forces exit when the Sentry transport never settles", () => {
    const result = runFatalFixture("timeout");

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(captureLines(result.stdout)).toHaveLength(1);
    expect(result.stderr).toContain("fatal capture timed out after 40ms");
    expect(result.stdout).toContain("EXIT 1 CAPTURES 1");
  });
});
