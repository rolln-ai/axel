import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { qaPassword } from "./fixtures.mjs";

test("fresh signup, emailed verification, pipeline setup, rejection and delivery recovery", async ({ page, request }, testInfo) => {
  const email = `new-${testInfo.project.name}@example.test`;
  const theme = testInfo.project.name.endsWith("light") ? "light" : "dark";
  await page.addInitScript(value => localStorage.setItem("theme", value), theme);
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
    writeText: async (value: string) => { (window as unknown as { qaClipboard: string }).qaClipboard = value; },
  } }));
  await page.goto("/signup?ref=github");
  await page.getByLabel("Name", { exact: true }).fill("New QA operator");
  await page.getByLabel("Work email", { exact: true }).fill(email);
  await page.getByLabel("Workspace name", { exact: true }).fill(`First workspace ${testInfo.project.name}`);
  await page.getByLabel("Password", { exact: true }).fill(qaPassword);
  await page.getByLabel("I agree to Axel's:", { exact: true }).check();
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Check your email" })).toBeVisible();
  const messagesResponse = await request.get(`${process.env.RESEND_BASE_URL}/messages?to=${encodeURIComponent(email)}`, {
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}` },
  });
  expect(messagesResponse.ok()).toBe(true);
  const messages = await messagesResponse.json() as { text: string }[];
  const verifyUrl = messages.map(message => message.text.match(/https?:\/\/[^\s]+\/verify\?token=[A-Za-z0-9_-]+/)?.[0]).find(Boolean);
  expect(verifyUrl).toBeTruthy();
  expect(new URL(verifyUrl!).origin).toBe(new URL(page.url()).origin);
  await page.goto(verifyUrl!);
  await page.getByRole("button", { name: "Confirm email", exact: true }).click();
  await expect(page).toHaveURL(/\/setup$/);

  // Read the disposable DB to verify persistence. Do not manufacture a session
  // or verification token: both came through the public forms above.
  const databaseUrl = process.env.DATABASE_URL!;
  expect(new URL(databaseUrl).hostname).toBe("127.0.0.1");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  let workspaceId: string;
  try {
    const result = await client.query(`SELECT wm.workspace_id, u.email_verified_at, a.metadata
      FROM users u JOIN workspace_members wm ON wm.user_id=u.id
      JOIN audit_log a ON a.workspace_id=wm.workspace_id AND a.action='workspace.created'
      WHERE u.email=$1`, [email]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].email_verified_at).toBeTruthy();
    expect(result.rows[0].metadata).toEqual({ signup_source: "github" });
    workspaceId = result.rows[0].workspace_id;
  } finally { await client.end(); }

  await page.getByLabel("Source name", { exact: true }).fill("First webhook");
  await page.getByRole("button", { name: "Create source", exact: true }).click();
  const clipboard = () => page.evaluate(() => (window as unknown as { qaClipboard: string }).qaClipboard);
  await page.getByRole("button", { name: "Copy URL", exact: true }).click();
  const ingestUrl = await clipboard();
  await page.getByRole("button", { name: "Copy header value", exact: true }).click();
  const token = await clipboard();
  await expect(page.getByText("Live event check unavailable", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Skip for now — I'll send an event later", exact: true }).click();
  await page.getByRole("button", { name: /^HTTP endpoint/ }).click();
  await page.getByLabel("Endpoint URL", { exact: true }).fill(`https://receiver.example.test/${workspaceId}/retry-once`);
  await page.getByRole("button", { name: "Connect destination", exact: true }).click();
  await expect(page.getByText("Save your destination signing secret", { exact: true })).toBeVisible();
  const secretRow = page.getByText("Destination signing secret", { exact: true }).locator("../..");
  const signingSecret = await secretRow.locator("pre").textContent();
  expect(signingSecret).toBeTruthy();
  await secretRow.getByRole("button", { name: "Copy", exact: true }).click();
  expect(await clipboard()).toBe(signingSecret);
  expect(token).toMatch(/^axt_/);
  const payload = { event: "first-real-event", synthetic: true, project: testInfo.project.name };
  expect((await request.post(ingestUrl, { data: payload, headers: { "x-axel-token": "invalid-qa-token" } })).status()).toBe(401);
  const drain = async () => {
    const response = await request.post(`${process.env.AXEL_INGEST_URL}/__qa/drain`, {
      data: { workspaceId }, headers: { authorization: `Bearer ${process.env.INGEST_ADMIN_TOKEN}` },
    });
    expect(response.status()).toBe(200);
    return response.json();
  };
  expect((await drain()).received).toEqual([]);
  expect((await request.post(ingestUrl, { data: payload, headers: { "x-axel-token": token } })).status()).toBe(202);
  const failed = await drain();
  expect(failed.attempts.map((attempt: { status: string }) => attempt.status)).toEqual(["retry"]);
  expect(failed.retries).toBe(1);
  expect(failed.received.map((entry: { status: number }) => entry.status)).toEqual([503]);
  const recovered = await drain();
  expect(recovered.attempts.map((attempt: { status: string }) => attempt.status)).toEqual(["retry", "success"]);
  expect(recovered.retries).toBe(0);
  expect(recovered.received.map((entry: { status: number }) => entry.status)).toEqual([503, 204]);
  for (const receipt of recovered.received) {
    expect(JSON.parse(receipt.body)).toEqual(payload);
    const [, timestamp, signature] = receipt.signature.match(/^t=(\d+),v1=([a-f0-9]+)$/);
    expect(signature).toBe(createHmac("sha256", signingSecret!).update(`${timestamp}.${receipt.body}`).digest("hex"));
  }
  const screenshot = testInfo.outputPath("first-pipeline.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach("first-pipeline", { path: screenshot, contentType: "image/png" });
  await page.getByRole("button", { name: "View on dashboard", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.reload();
  expect(await page.locator("body").innerText()).not.toContain(signingSecret);
  expect(await page.locator("body").innerText()).not.toContain(token);
  await page.goto("/admin/growth");
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { name: "Cloud adoption", exact: true })).toHaveCount(0);
});
