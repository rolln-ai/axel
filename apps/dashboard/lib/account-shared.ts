// Helpers shared by auth-actions.ts and workspace-team-actions.ts (both
// "use server" modules, which may only export async functions — so these
// sync/mixed helpers live here instead).

import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { formValue } from "./form";
import { normalizeWorkspaceTimezone, resolveWorkspaceTimezone } from "./timezones";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/**
 * Timezone to seed a brand-new workspace with, best signal first:
 *   1. the browser's own zone, posted by <TimezoneField /> — exact
 *   2. Vercel's IP-geolocation header — covers no-JS / non-Intl clients
 *   3. UTC
 * Both are resolved against the Settings picker's option list, so an
 * unrecognized zone degrades to UTC rather than a broken select. This is only
 * a default; owners can change it in Settings → General.
 */
export async function detectWorkspaceTimezone(formData: FormData): Promise<string> {
  const fromBrowser = resolveWorkspaceTimezone(formValue(formData, "timezone"));
  if (fromBrowser) return fromBrowser;
  return normalizeWorkspaceTimezone((await headers()).get("x-vercel-ip-timezone"));
}
