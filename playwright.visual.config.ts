import { defineConfig } from "@playwright/test";

const isCi = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./tests/visual",
  timeout: 60_000,
  fullyParallel: true,
  retries: isCi ? 1 : 0,
  workers: isCi ? 2 : undefined,
  outputDir: "artifacts/playwright-results",
  reporter: [
    ["list"],
    ["html", { outputFolder: "artifacts/playwright-report", open: "never" }],
  ],
  use: {
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: {
        viewport: { width: 1440, height: 1000 },
        deviceScaleFactor: 1,
      },
    },
    {
      name: "mobile",
      use: {
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 1,
        isMobile: true,
      },
    },
  ],
  webServer: [
    {
      command: "pnpm --filter @axel/marketing exec next start -H 127.0.0.1 -p 34100",
      url: "http://127.0.0.1:34100",
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: "pnpm --filter @axel/dashboard exec next start -H 127.0.0.1 -p 34101",
      url: "http://127.0.0.1:34101/login",
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
