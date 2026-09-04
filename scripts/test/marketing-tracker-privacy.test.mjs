import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const trackedBoundaries = [
  ".env.example",
  "apps/dashboard/lib/auth-actions.ts",
  "apps/marketing/app/layout.tsx",
  "apps/marketing/app/robots.ts",
  "apps/marketing/app/_components/SiteChrome.tsx",
  "apps/marketing/next.config.mjs",
  "apps/marketing/package.json",
];
const trackerPattern =
  /posthog|cloud\.umami\.is|googletagmanager\.com|\bgtag\b|\bdataLayer\b|axel_signup_conversion/iu;

test("browser-facing marketing and signup boundaries contain no tracking SDK", () => {
  for (const relativePath of trackedBoundaries) {
    const source = readFileSync(path.join(repoRoot, relativePath), "utf8");
    assert.doesNotMatch(source, trackerPattern, relativePath);
  }
});

test("removed analytics entrypoints cannot be restored accidentally", () => {
  for (const relativePath of [
    "apps/marketing/instrumentation-client.ts",
    "apps/marketing/lib/consent.ts",
    "apps/marketing/proxy.ts",
    "apps/marketing/app/providers.tsx",
    "apps/marketing/app/_components/CookieConsent.tsx",
    "apps/marketing/app/_components/CookiePreferencesButton.tsx",
    "apps/dashboard/app/_components/SignupConversionTracker.tsx",
  ]) {
    assert.equal(existsSync(path.join(repoRoot, relativePath)), false, relativePath);
  }
});

test("product support uses the public environment variable", () => {
  const contact = readFileSync(path.join(repoRoot, "apps/marketing/lib/contact.ts"), "utf8");
  const environment = readFileSync(path.join(repoRoot, ".env.example"), "utf8");

  assert.match(contact, /process\.env\.NEXT_PUBLIC_SUPPORT_EMAIL/);
  assert.match(environment, /^NEXT_PUBLIC_SUPPORT_EMAIL=$/m);

  for (const relativePath of [
    "apps/marketing/app/_components/SiteChrome.tsx",
    "apps/marketing/app/docs/page.tsx",
    "apps/marketing/lib/structured-data.ts",
  ]) {
    const source = readFileSync(path.join(repoRoot, relativePath), "utf8");
    assert.doesNotMatch(source, /founders@axelapp\.ai/u, relativePath);
  }
});
