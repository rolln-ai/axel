import { defineConfig } from "@playwright/test";
import { origins } from "./tests/visual/origins";
import { qaProjects } from "./tests/dashboard/fixtures.mjs";

if (process.env.AXEL_DISPOSABLE_DASHBOARD_QA !== "1") {
  throw new Error("Use pnpm test:dashboard to start the disposable database and app");
}

export default defineConfig({
  testDir: "./tests/dashboard",
  timeout: 60_000,
  workers: 2,
  retries: 0,
  outputDir: "artifacts/dashboard-results",
  reporter: [["list"], ["html", { outputFolder: "artifacts/dashboard-report", open: "never" }]],
  use: {
    baseURL: origins.dashboard,
    actionTimeout: 15_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: qaProjects.map((name) => ({
    name,
    use: {
      viewport: name.startsWith("mobile") ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      isMobile: name.startsWith("mobile"),
    },
  })),
});
