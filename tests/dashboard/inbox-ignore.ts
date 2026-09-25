import { expect, type Page, type TestInfo } from "@playwright/test";
import { dashboardFixture, qaPassword } from "./fixtures.mjs";

/**
 * Sign in through an incident-email style link. The hand-off URL redirects to
 * the canonical Inbox, and whatever URL the router keeps afterwards, the Fix
 * button's server action must still run instead of failing with 405 and
 * unmounting the page.
 */
export async function signInThroughInboxHandoff(page: Page, testInfo: TestInfo) {
  const fixture = dashboardFixture(testInfo.project.name);
  await page.goto(`/workspaces/${fixture.workspaceId}/inbox`);
  await expect(page).toHaveURL(/\/login\?returnTo=/);
  await page.getByLabel("Email", { exact: true }).fill(fixture.email);
  await page.getByLabel("Password", { exact: true }).fill(qaPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
  const card = page.locator("article").filter({ hasText: "Synthetic healthy destination" });
  await card.getByRole("button", { name: "Fix now", exact: true }).click();
  await expect(card.getByRole("status")).toContainText("Correct the route and enable it on the route page");
  await expect(page.getByText("Something went wrong", { exact: true })).toHaveCount(0);
}

/** "Ignore and close" hides a card without touching monitoring; "Bring back" undoes it. */
export async function verifyIgnoreAndRestore(page: Page, testInfo: TestInfo) {
  await page.goto("/inbox");
  const silent = page.locator("article").filter({ hasText: "Synthetic webhook stopped receiving data" });
  await expect(silent).toBeVisible();
  await silent.getByRole("button", { name: "Ignore and close", exact: true }).click();
  await expect(silent).toHaveCount(0);
  const ignoredLink = page.getByRole("link", { name: "Ignored (1)", exact: true });
  await expect(ignoredLink).toBeVisible();
  const screenshot = testInfo.outputPath("inbox-after-ignore.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach("inbox-after-ignore", { path: screenshot, contentType: "image/png" });
  await ignoredLink.click();
  await expect(page).toHaveURL(/\/inbox\?show=ignored$/);
  await expect(silent).toBeVisible();
  await expect(silent.getByText(/Ignored .*no more emails about it\./)).toBeVisible();
  await expect(silent.getByRole("button", { name: "Fix now", exact: true })).toHaveCount(0);
  const ignoredScreenshot = testInfo.outputPath("inbox-ignored-view.png");
  await page.screenshot({ path: ignoredScreenshot, fullPage: true });
  await testInfo.attach("inbox-ignored-view", { path: ignoredScreenshot, contentType: "image/png" });
  await silent.getByRole("button", { name: "Bring back", exact: true }).click();
  await expect(page.getByText("Nothing ignored.", { exact: true })).toBeVisible();
  await page.goto("/inbox");
  await expect(silent).toBeVisible();
  await expect(page.getByRole("link", { name: /^Ignored \(/ })).toHaveCount(0);
}
