import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "server-only": fileURLToPath(new URL("./test/server-only.ts", import.meta.url)),
      // Mirror tsconfig's "@/*" → "./*" so component tests can import app code.
      "@": fileURLToPath(new URL(".", import.meta.url)).replace(/\/$/, ""),
    },
  },
  // The app compiles JSX via Next/SWC (automatic runtime); tests that import
  // .tsx components need esbuild to do the same (tsconfig says "preserve").
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup-env.ts"],
    // The first test in each file pays a one-time cost to lazily import the
    // large server-action modules (e.g. lib/first-run-actions.ts). Under parallel CI load
    // (`turbo run test` fans out ~20 vitest pools at once) that import can push
    // the first test past the default 5s cap; the resulting timeout then leaves
    // a dangling async server-action that mutates a sibling test's shared mock
    // FIFO, cascading into spurious assertion failures. A generous timeout
    // (~4x the observed worst case under load) breaks that whole chain.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
