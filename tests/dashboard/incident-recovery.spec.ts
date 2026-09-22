import { expect, test } from "@playwright/test";
import { dashboardFixture, qaPassword } from "./fixtures.mjs";

test("route errors point to the route and live recovery overrides an old alert", async ({ page }, testInfo) => {
  const fixture = dashboardFixture(testInfo.project.name);
  const theme = testInfo.project.name.endsWith("light") ? "light" : "dark";
  const routeId = `${fixture.sourceId}_errored`;
  await page.addInitScript(value => localStorage.setItem("theme", value), theme);
  await page.goto("/inbox");
  await page.getByLabel("Email", { exact: true }).fill(fixture.email);
  await page.getByLabel("Password", { exact: true }).fill(qaPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const card = page.locator("article").filter({ hasText: "Synthetic healthy destination" });
  await expect(card.getByText("The route stopped after a processing error. Correct the route and enable it, then click Fix now to replay.", { exact: true })).toBeVisible();
  await expect(card).not.toContainText("destination is paused");
  await card.getByRole("button", { name: "Fix now", exact: true }).click();
  await expect(card.getByRole("status")).toContainText("Correct the route and enable it on the route page");
  await card.getByText("Details", { exact: true }).click();
  const screenshot = testInfo.outputPath("route-error-incident.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach("route-error-incident", { path: screenshot, contentType: "image/png" });
  await card.getByRole("link", { name: "Route", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/routes/${routeId}$`));
  await page.goto(`/routes/${routeId}?tab=destinations`);
  await page.getByRole("button", { name: "Enable", exact: true }).click();
  await expect(page.getByRole("button", { name: "Disable", exact: true })).toBeVisible();
  await page.goto("/inbox");
  // Monitoring is deliberately unavailable in local QA. The stored alert
  // still describes the route error, but the action must read current state.
  await expect(card.getByText("The route stopped after a processing error. Correct the route and enable it, then click Fix now to replay.", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Fix now", exact: true }).click();
  await expect(card.getByRole("button", { name: "Fixing…", exact: true })).toBeVisible();
  await expect(card.getByRole("status")).not.toContainText("Correct the route");
});
