import { expect, test } from "@playwright/test";
import { dashboardFixture, qaPassword } from "./fixtures.mjs";

test("sign-in, workspace changes, source isolation, and sign-out", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const fixture = dashboardFixture(testInfo.project.name);
  const theme = testInfo.project.name.endsWith("light") ? "light" : "dark";
  await page.addInitScript((value) => localStorage.setItem("theme", value), theme);

  await page.goto("/settings");
  await expect(page).toHaveURL(/\/login\?/);
  await page.getByLabel("Email", { exact: true }).fill(fixture.email);
  await page.getByLabel("Password", { exact: true }).fill(qaPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${theme}\\b`));

  const currentName = await page.getByLabel("Name", { exact: true }).inputValue();
  const updatedName = currentName === fixture.workspaceName ? `${fixture.workspaceName} updated` : fixture.workspaceName;
  await page.getByLabel("Name", { exact: true }).fill(updatedName);
  await page.getByRole("button", { name: "Save workspace", exact: true }).click();
  await expect(page.getByText("Workspace settings updated.", { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.reload();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(updatedName);

  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Top sources this month" })).toBeVisible();
  await page.getByRole("link", { name: /Synthetic webhook/ }).click();
  await expect(page.getByRole("heading", { name: "Synthetic webhook", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Source analytics unavailable" })).toBeVisible();
  await expect(page.getByRole("img", { name: /Daily event stream/ })).toHaveCount(0);
  await expect(page.getByText("no events yet", { exact: true })).toHaveCount(0);
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.viewport + 2);
  const screenshot = testInfo.outputPath("source-overview.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach("source-overview", { path: screenshot, contentType: "image/png" });

  await page.goto(`/sources/${fixture.sourceId}?tab=contract`);
  await expect(page.getByRole("heading", { name: "Drift", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Skip to content", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();

  await page.goto("/sources/src_qa_foreign");
  await expect(page.getByRole("heading", { name: "Not found", exact: true })).toBeVisible();
  await expect(page.getByText("Foreign source", { exact: true })).toHaveCount(0);

  await page.goto("/dashboard");
  if (testInfo.project.name.startsWith("mobile")) {
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
  }
  await expect(page.getByRole("link", { name: "View system status (opens in new tab)" })).toHaveText("System status");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto(`/sources/${fixture.sourceId}`);
  await expect(page).toHaveURL(/\/login\?/);
  expect(pageErrors).toEqual([]);
});
