import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Stamps a first-party `axel_consent_required` cookie from edge geolocation so
 * the client can decide whether to show the cookie-consent banner without
 * making pages dynamic. Set once per visitor (skipped when already present) so
 * most responses stay cacheable.
 *
 * EEA (EU 27 + IS/LI/NO) + UK + Switzerland require prior consent before
 * non-essential analytics cookies. Unknown geo defaults to "required" — the
 * compliance-safe choice.
 */
const CONSENT_REQUIRED_COUNTRIES = new Set([
  // EU 27
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU",
  "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  // EEA
  "IS", "LI", "NO",
  // UK + Switzerland
  "GB", "CH",
]);

const COOKIE = "axel_consent_required";

export function proxy(req: NextRequest): NextResponse {
  if (req.cookies.has(COOKIE)) return NextResponse.next();

  const country = (
    req.headers.get("cf-ipcountry") || // Cloudflare, when proxied
    req.headers.get("x-vercel-ip-country") || // Vercel edge
    ""
  ).toUpperCase();

  // "", "XX", "T1" = unknown / Tor / anonymising proxy → require consent.
  const required =
    country === "" || country === "XX" || country === "T1" || CONSENT_REQUIRED_COUNTRIES.has(country);

  const res = NextResponse.next();
  res.cookies.set(COOKIE, required ? "1" : "0", {
    path: "/",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 180,
  });
  return res;
}

export const config = {
  // Pages only — skip static assets, API routes, the `/ingest` proxy, and files.
  matcher: ["/((?!_next/static|_next/image|api|ingest|favicon.ico|.*\\.[^/]+$).*)"],
};
