import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import { dashboardFixture, qaPassword } from "./fixtures.mjs";

function authenticatorCode(secret: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...secret].map(char => alphabet.indexOf(char).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map(byte => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[19]! & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, "0");
}

test("cloud adoption requires admin MFA and makes missing analytics explicit", async ({ page }, testInfo) => {
  // Two logins cover both themes, with mobile checks below. Combined with the
  // existing suite this stays inside the real per-IP sign-in limit.
  test.skip(!testInfo.project.name.startsWith("desktop"), "Mobile geometry is checked after the desktop view in each theme");
  const fixture = dashboardFixture(testInfo.project.name);
  const theme = testInfo.project.name.endsWith("light") ? "light" : "dark";
  await page.addInitScript(value => localStorage.setItem("theme", value), theme);
  await page.goto("/admin/growth");
  await expect(page).toHaveURL(/\/login(?:\?|$)/);
  await page.goto("/login?returnTo=%2Fadmin%2Fgrowth");
  await page.getByLabel("Email", { exact: true }).fill(`admin-${fixture.email}`);
  await page.getByLabel("Password", { exact: true }).fill(qaPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/admin-mfa/);
  await expect(page.getByRole("heading", { name: "Cloud adoption", exact: true })).toHaveCount(0);
  await page.getByLabel("Current password", { exact: true }).fill(qaPassword);
  await page.getByRole("button", { name: "Set up authenticator", exact: true }).click();
  const secret = page.locator("code").filter({ hasText: /^[A-Z2-7]{32}$/ });
  await expect(secret).toBeVisible();
  await page.getByLabel("Authenticator code", { exact: true }).fill(authenticatorCode((await secret.textContent())!));
  await page.getByRole("button", { name: "Continue to admin", exact: true }).click();
  await expect(page).toHaveURL(/\/admin(?:\/overview)?$/);
  await page.getByRole("link", { name: "Cloud adoption", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/growth$/);
  await expect(page.getByRole("heading", { name: "Cloud adoption", exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Event analytics are unavailable" })).toBeVisible();
  await expect(page.getByRole("rowheader", { name: "GitHub", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Unavailable", exact: true })).toHaveCount(9);
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.viewport + 2);
  const screenshot = testInfo.outputPath("cloud-adoption.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach("cloud-adoption", { path: screenshot, contentType: "image/png" });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileWidths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(mobileWidths.scroll).toBeLessThanOrEqual(mobileWidths.viewport + 2);
  const mobileScreenshot = testInfo.outputPath("cloud-adoption-mobile.png");
  await page.screenshot({ path: mobileScreenshot, fullPage: true });
  await testInfo.attach("cloud-adoption-mobile", { path: mobileScreenshot, contentType: "image/png" });
});
