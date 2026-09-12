import { expect, type Page, type TestInfo } from "@playwright/test";

export async function verifySlowNavigation(page: Page, testInfo: TestInfo) {
  const mobile = testInfo.project.name.startsWith("mobile");
  const theme = testInfo.project.name.endsWith("light") ? "light" : "dark";
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();

  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let intercepted = 0;
  await page.route("**/sources?*", async (route) => {
    const headers = route.request().headers();
    if (headers.rsc === "1" && headers["next-router-prefetch"] !== "1") {
      intercepted += 1;
      await held;
    }
    await route.continue();
  });
  try {
    if (mobile) await page.getByRole("button", { name: "Open menu" }).click();
    await page.locator('nav[aria-label="Dashboard"] a[href="/sources"]').filter({ visible: true }).click();
    await expect.poll(() => intercepted).toBeGreaterThan(0);
    await expect(page.getByRole("status").filter({ hasText: "Loading page…" }).first()).toBeVisible();
    const pendingScreenshot = testInfo.outputPath("navigation-loading.png");
    await page.screenshot({ path: pendingScreenshot });
    await testInfo.attach("navigation-loading", { path: pendingScreenshot, contentType: "image/png" });
  } finally {
    release();
  }
  await expect(page.getByRole("heading", { name: "Sources", exact: true })).toBeVisible();
  await expect(page.locator("[data-navigation-progress]")).toHaveCount(0);
  if (mobile) await expect(page.getByRole("dialog")).toHaveCount(0);

  // A new navigation can finish while a previous request is still in flight.
  let releaseEvents!: () => void;
  const heldEvents = new Promise<void>((resolve) => { releaseEvents = resolve; });
  await page.route("**/events?*", async (route) => {
    if (route.request().headers().rsc === "1") await heldEvents;
    await route.continue();
  });
  try {
    if (mobile) await page.getByRole("button", { name: "Open menu" }).click();
    const events = page.locator('nav[aria-label="Dashboard"] a[href="/events"]').filter({ visible: true });
    await events.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-navigation-progress]").first()).toBeVisible();
    const menu = page.getByRole("button", { name: "Open menu" });
    if (mobile && await menu.isVisible() && !await page.getByRole("dialog").count()) await menu.click();
    await page.locator('nav[aria-label="Dashboard"] a[href="/settings"]').filter({ visible: true }).click();
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  } finally {
    releaseEvents();
  }
  await expect(page.locator("[data-navigation-progress]")).toHaveCount(0);
  await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${theme}\\b`));
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.viewport + 2);
}
