import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Adversarial tests spawn worker_threads with tight CPU/memory caps and
    // intentionally OOM/timeout. Keep a generous per-test cap so vitest itself
    // doesn't kill mid-assertion, but small enough that a real hang fails.
    testTimeout: 10_000,
    pool: "forks",
  },
});
