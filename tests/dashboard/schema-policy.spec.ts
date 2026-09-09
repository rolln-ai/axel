import { expect, test } from "@playwright/test";
import { dashboardFixture, qaPassword } from "./fixtures.mjs";

test("warehouse schema permissions are explicit and persist across route edits", async ({ page }, testInfo) => {
  const fixture = dashboardFixture(testInfo.project.name);
  const theme = testInfo.project.name.endsWith("light") ? "light" : "dark";
  const routeId = `${fixture.sourceId}_schema`;
  await page.addInitScript(value => localStorage.setItem("theme", value), theme);
  await page.goto(`/routes/${routeId}?tab=destinations`);
  await page.getByLabel("Email", { exact: true }).fill(fixture.email);
  await page.getByLabel("Password", { exact: true }).fill(qaPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/routes/${routeId}`));
  const controls = page.getByRole("combobox", { name: "Schema changes", exact: true });
  await expect(controls).toHaveCount(3);
  for (let i = 0; i < 3; i++) await expect(controls.nth(i)).toHaveText("Keep existing schema");
  await controls.first().click();
  await page.getByRole("option", { name: "Allow new fields", exact: true }).click();
  await expect(page.getByText(/Added fields can break downstream views/)).toBeVisible();
  const screenshot = testInfo.outputPath("schema-policy.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach("schema-policy", { path: screenshot, contentType: "image/png" });
  const saved = page.waitForResponse(response => response.request().method() === "POST"
    && response.url().includes(`/routes/${routeId}`)
    && (response.request().postData() ?? "").includes("destination_ids"));
  await page.getByRole("button", { name: "Save destinations", exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(page.getByRole("button", { name: "Save destinations", exact: true })).toBeEnabled({ timeout: 30_000 });
  await page.reload();
  await expect(controls.first()).toHaveText("Allow new fields");
  await expect(controls.nth(1)).toHaveText("Keep existing schema");
  await expect(controls.nth(2)).toHaveText("Keep existing schema");
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.viewport + 2);
});
