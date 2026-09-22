import { expect, test } from "@playwright/test";
import { dashboardFixture, qaPassword } from "./fixtures.mjs";
import { verifySlowNavigation } from "./navigation";
import { verifyIncidentRecovery } from "./incident-recovery";

test("sign-in, workspace changes, source isolation, and sign-out", async ({ page, request }, testInfo) => {
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

  await test.step("Slow navigation stays visible and interruptible", () => verifySlowNavigation(page, testInfo));

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

  // Synthetic fixtures only. Capture writes without changing the user's clipboard.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (value: string) => { (window as unknown as { qaClipboard: string }).qaClipboard = value; },
    } });
  });
  await page.goto(`/sources/${fixture.sourceId}?tab=settings`);
  // Streamed page content waits in a hidden container at body level until
  // React reveals it. Label lookups match hidden nodes, so scope them to main.
  const settings = page.getByRole("main");
  await settings.getByLabel("Maximum expected gap in minutes", { exact: true }).fill("60");
  await page.getByRole("button", { name: "Save monitoring", exact: true }).click();
  await expect(page.getByText("Traffic monitoring saved.", { exact: true })).toBeVisible();
  await page.reload();
  await expect(settings.getByLabel("Maximum expected gap in minutes", { exact: true })).toHaveValue("60");
  await expect(page.getByRole("heading", {name: "Traffic monitoring", exact: true})).toBeVisible();
  await expect(page.getByRole("button", {name: "Save monitoring", exact: true})).toBeVisible();
  const monitorScreenshot = testInfo.outputPath("traffic-monitoring.png");
  await page.screenshot({path: monitorScreenshot, fullPage: true});
  await testInfo.attach("traffic-monitoring", {path: monitorScreenshot, contentType: "image/png"});
  const clipboard = () => page.evaluate(() => (window as unknown as { qaClipboard: string }).qaClipboard);
  await page.getByRole("button", { name: "Copy URL", exact: true }).click();
  const cleanUrl = await clipboard();
  expect(new URL(cleanUrl).pathname).toBe(`/in/${fixture.sourceId}`);
  expect(new URL(cleanUrl).search).toBe("");
  await page.getByRole("button", { name: "Rotate token", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Rotate", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Token rotated." })).toBeVisible();
  await page.getByRole("button", { name: "Copy header value", exact: true }).click();
  const headerToken = await clipboard();
  expect(headerToken).toMatch(/^axt_/);
  await page.getByRole("button", { name: "Copy header name", exact: true }).click();
  expect(await clipboard()).toBe("x-axel-token");

  await page.getByRole("button", { name: "Generate webhook URL", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copy authenticated URL", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Copy authenticated URL", exact: true }).click();
  const authenticatedUrl = await clipboard();
  expect(authenticatedUrl).toContain(cleanUrl);
  expect(new URL(authenticatedUrl).searchParams.get("url_token")).toMatch(/^axu_[A-Za-z0-9_-]{43}$/);
  expect(authenticatedUrl).not.toContain(headerToken);
  expect((await request.post(authenticatedUrl, { data: { synthetic: "headerless QA" } })).status()).toBe(202);
  expect((await request.post(cleanUrl, { data: {}, headers: { "x-axel-token": headerToken } })).status()).toBe(202);
  expect((await request.post(cleanUrl, { data: {} })).status()).toBe(401);
  // Creating URL auth leaves the current header token visible and unchanged.
  await page.getByRole("button", { name: "Copy header value", exact: true }).click();
  expect(await clipboard()).toBe(headerToken);
  const setupWidths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(setupWidths.scroll).toBeLessThanOrEqual(setupWidths.viewport + 2);
  const setupScreenshot = testInfo.outputPath("webhook-setup.png");
  await page.screenshot({ path: setupScreenshot, fullPage: true });
  await testInfo.attach("webhook-setup", { path: setupScreenshot, contentType: "image/png" });

  await page.reload();
  await expect(page.getByRole("main").getByText(/URL authentication is enabled/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy authenticated URL", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy header value", exact: true })).toHaveCount(0);
  expect(await page.locator("body").innerText()).not.toContain(headerToken);
  expect(await page.locator("body").innerText()).not.toContain(authenticatedUrl);

  await page.getByRole("button", { name: "Replace webhook URL", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Replace URL", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copy authenticated URL", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Copy authenticated URL", exact: true }).click();
  const replacementUrl = await clipboard();
  expect(replacementUrl).not.toBe(authenticatedUrl);
  expect((await request.post(authenticatedUrl, { data: {} })).status()).toBe(401);
  expect((await request.post(replacementUrl, { data: {} })).status()).toBe(202);
  await page.getByRole("button", { name: "Disable URL", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Disable URL", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "URL authentication disabled." })).toBeVisible();
  expect((await request.post(replacementUrl, { data: {} })).status()).toBe(401);
  expect((await request.post(cleanUrl, { data: {}, headers: { "x-axel-token": headerToken } })).status()).toBe(202);
  await expect(page.getByRole("button", { name: "Copy authenticated URL", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Generate webhook URL", exact: true })).toBeVisible();

  // Reuse this real sign-in so the full suite stays inside auth throttling.
  await test.step("Errored route recovery", () => verifyIncidentRecovery(page, testInfo));
  await page.goto("/inbox");
  await expect(page.getByRole("heading", {name: "Synthetic webhook stopped receiving data", exact: true})).toBeVisible();
  await expect(page.getByText("Monitoring has not completed a recent check. Current data flow is unverified.", {exact: true})).toBeVisible();
  const incidentScreenshot = testInfo.outputPath("pipeline-incident.png");
  await page.screenshot({path: incidentScreenshot, fullPage: true});
  await testInfo.attach("pipeline-incident", {path: incidentScreenshot, contentType: "image/png"});
  // A silent source cannot be fixed from the Inbox; it links to the source instead.
  const silentIncident = page.locator("article").filter({hasText: "Synthetic webhook stopped receiving data"});
  await expect(silentIncident.getByRole("button", {name: "Fix now", exact: true})).toHaveCount(0);
  await expect(silentIncident.getByRole("link", {name: "Check source setup", exact: true})).toBeVisible();
  await silentIncident.getByText("Details", {exact: true}).click();
  await silentIncident.getByRole("button", {name: "Pause reminder emails for 24 hours", exact: true}).click();
  await expect(silentIncident.getByText(/Reminder emails paused until/)).toBeVisible();
  await page.reload();
  await silentIncident.getByText("Details", {exact: true}).click();
  await expect(silentIncident.getByRole("button", {name: "Pause reminder emails for 24 hours", exact: true})).toHaveCount(0);
  await page.goto("/settings?tab=notifications");
  await expect(page.getByRole("checkbox", {name: /^Data flow incidents/})).toBeChecked();
  await expect(page.getByRole("checkbox", {name: /^Weekly schema observations/})).not.toBeChecked();

  await page.goto(`/deliveries/${fixture.investigationId}/investigate`);
  await expect(page.getByRole("heading", {name: "Investigate failure", exact: true})).toBeVisible();
  await expect(page.getByRole("heading", {name: "AI explanation unavailable", exact: true})).toBeVisible();
  await expect(page.getByRole("button", {name: "Reveal payload", exact: true})).toBeVisible();
  await expect(page.getByRole("button", {name: "Replay 1 unresolved", exact: true})).toBeVisible();
  const recoveryWidths = await page.evaluate(() => ({scroll: document.documentElement.scrollWidth, viewport: innerWidth}));
  expect(recoveryWidths.scroll).toBeLessThanOrEqual(recoveryWidths.viewport + 2);
  const recoveryScreenshot = testInfo.outputPath("investigation-fallback.png");
  await page.screenshot({path: recoveryScreenshot, fullPage: true});
  await testInfo.attach("investigation-fallback", {path: recoveryScreenshot, contentType: "image/png"});

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
