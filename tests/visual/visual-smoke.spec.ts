import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { origins } from "./origins";

type AppName = "marketing" | "dashboard";

type VisualRoute = {
  app: AppName;
  name: string;
  path: string;
  minTextLength?: number;
};

const routes: VisualRoute[] = [
  { app: "marketing", name: "marketing-home", path: "/" },
  { app: "marketing", name: "marketing-pricing", path: "/pricing" },
  { app: "marketing", name: "marketing-docs", path: "/docs" },
  { app: "marketing", name: "marketing-security", path: "/security" },
  { app: "marketing", name: "marketing-legal", path: "/legal" },
  { app: "marketing", name: "marketing-terms", path: "/terms" },
  { app: "marketing", name: "marketing-privacy", path: "/privacy" },
  { app: "marketing", name: "marketing-dpa", path: "/dpa" },
  { app: "marketing", name: "marketing-subprocessors", path: "/subprocessors" },
  { app: "marketing", name: "marketing-acceptable-use", path: "/acceptable-use" },
  { app: "marketing", name: "marketing-cookies", path: "/cookies" },
  { app: "dashboard", name: "dashboard-root", path: "/", minTextLength: 40 },
  { app: "dashboard", name: "dashboard-login", path: "/login" },
  { app: "dashboard", name: "dashboard-signup", path: "/signup" },
  { app: "dashboard", name: "dashboard-forgot", path: "/forgot" },
  { app: "dashboard", name: "dashboard-reset", path: "/reset" },
  { app: "dashboard", name: "dashboard-api-docs", path: "/docs/api" },
  { app: "dashboard", name: "dashboard-status", path: "/status" },
  { app: "dashboard", name: "dashboard-protected-dashboard", path: "/dashboard", minTextLength: 40 },
];

/**
 * Read the page's rendered state, tolerating a navigation landing mid-read.
 *
 * A protected route (e.g. /dashboard) redirects to /login, and that can fire
 * after `networkidle` — destroying the execution context while page.evaluate
 * is running and failing the test with "Execution context was destroyed".
 * The redirect is the page behaving correctly, so wait for it to settle and
 * read again rather than reporting a failure.
 */
async function readPageState(page: Page) {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      return await page.evaluate(() => {
        const bodyText = document.body?.innerText ?? "";
        const headingText = document.querySelector("h1")?.textContent?.trim() ?? "";
        const documentElement = document.documentElement;
        const clientWidth = documentElement.clientWidth;
        const scrollWidth = documentElement.scrollWidth;
        const browserConnectionError =
          /This site can't be reached|ERR_CONNECTION_REFUSED|DNS_PROBE_FINISHED/.test(bodyText);
        const appError =
          Boolean(document.querySelector("[data-nextjs-dialog], nextjs-portal")) ||
          bodyText.includes("Application error: a client-side exception has occurred") ||
          headingText === "Internal Server Error" ||
          headingText === "This page could not be found";

        return {
          appError,
          browserConnectionError,
          clientWidth,
          headingText,
          scrollWidth,
          textLength: bodyText.trim().length,
          title: document.title,
          viewportWidth: window.innerWidth,
        };
      });
    } catch (error) {
      const navigatedMidRead =
        /Execution context was destroyed|frame was detached|Target closed/i.test(String(error));
      if (!navigatedMidRead || attempt >= MAX_ATTEMPTS) throw error;
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    }
  }
}

for (const route of routes) {
  test(`${route.name} renders cleanly`, async ({ page }, testInfo) => {
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() !== "error") {
        return;
      }
      consoleErrors.push(formatConsoleError(message.text(), message.location().url));
    });
    page.on("pageerror", (error) => {
      consoleErrors.push(`pageerror: ${error.message}`);
    });

    const url = `${origins[route.app]}${route.path}`;
    const response = await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    await expect(page.locator("body")).toBeVisible();

    expect(response?.ok(), `${url} returned ${response?.status() ?? "no response"}`).toBe(true);

    const state = await readPageState(page);

    expect(state.browserConnectionError, `${url} rendered a browser connection error`).toBe(false);
    expect(state.appError, `${url} rendered an application error: ${state.headingText}`).toBe(false);
    expect(state.textLength, `${url} rendered too little visible text`).toBeGreaterThan(route.minTextLength ?? 100);
    expect(
      state.scrollWidth,
      `${url} overflows horizontally: scrollWidth ${state.scrollWidth}, viewport ${state.viewportWidth}`,
    ).toBeLessThanOrEqual(state.viewportWidth + 2);

    const screenshotPath = path.join(
      process.cwd(),
      "artifacts",
      "visual-smoke",
      testInfo.project.name,
      `${route.name}.png`,
    );
    await mkdir(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await testInfo.attach("screenshot", { path: screenshotPath, contentType: "image/png" });

    const unexpectedConsoleErrors = consoleErrors.filter((error) => !isIgnorableConsoleError(error));
    expect(unexpectedConsoleErrors, unexpectedConsoleErrors.join("\n")).toEqual([]);
  });
}

test("marketing-home integration pipeline flows sources through Axel to destinations", async ({ page }) => {
  const sourceNames = ["Webhook endpoint", "Custom HMAC"];
  const destinationNames = ["Signed webhook", "MongoDB", "Postgres", "S3", "Cloudflare R2", "Databricks", "BigQuery"];

  await page.goto(`${origins.marketing}/#integrations`, { waitUntil: "domcontentloaded" });

  const flow = page.locator(".integrationFlow");
  await expect(flow).toBeVisible();

  // Reading order: sources, then the Axel routing stage, then destinations.
  const stageHeadings = flow.locator(
    "#source-integrations, #process-integrations, #destination-integrations",
  );
  await expect(stageHeadings).toHaveText(["Sources", "Axel", "Destinations"]);

  const sources = flow.locator("section[aria-labelledby='source-integrations'] .integrationItem");
  await expect(sources).toHaveCount(sourceNames.length);
  for (const name of sourceNames) {
    await expect(sources.locator("strong", { hasText: name }).first()).toBeVisible();
  }

  const destinations = flow.locator("section[aria-labelledby='destination-integrations'] .integrationItem");
  await expect(destinations).toHaveCount(destinationNames.length);
  for (const name of destinationNames) {
    await expect(destinations.locator("strong", { hasText: name }).first()).toBeVisible();
  }

  // Connector rails are decorative only: hidden from the accessibility tree.
  const rails = flow.locator(".integrationRail");
  await expect(rails).toHaveCount(2);
  for (const rail of await rails.all()) {
    await expect(rail).toHaveAttribute("aria-hidden", "true");
  }

  // The pipeline must not force horizontal scrolling on either project
  // viewport (1440px desktop, 390px mobile).
  const { scrollWidth, viewportWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(
    scrollWidth,
    `integration pipeline overflows horizontally: scrollWidth ${scrollWidth}, viewport ${viewportWidth}`,
  ).toBeLessThanOrEqual(viewportWidth + 2);
});

function formatConsoleError(message: string, url: string): string {
  return url ? `${url}: ${message}` : message;
}

function isIgnorableConsoleError(message: string): boolean {
  return /favicon\.ico/.test(message);
}

for (const theme of ["light", "dark"]) {
  test(`status remains readable in ${theme} mode`, async ({ page }, testInfo) => {
    await page.addInitScript((selectedTheme) => {
      window.localStorage.setItem("theme", selectedTheme);
    }, theme);
    await page.goto(`${origins.dashboard}/status`);
    await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${theme}\\b`));
    await expect(page.getByRole("heading", { name: "Axel status", exact: true })).toBeVisible();
    const state = await readPageState(page);
    expect(state.scrollWidth).toBeLessThanOrEqual(state.viewportWidth + 2);
    const screenshot = path.join("artifacts", "visual-smoke", testInfo.project.name, `dashboard-status-${theme}.png`);
    await mkdir(path.dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach(`status-${theme}`, { path: screenshot, contentType: "image/png" });
  });
}
