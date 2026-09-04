import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { RETURN_TO_HEADER } from "./lib/return-to";

export function proxy(req: NextRequest): NextResponse {
  // Stamp the requested path (with query) onto the request so server-side
  // auth gates (requireSession / requireAuthenticatedUser) can bounce to
  // /login?returnTo=<here> and signIn can bring the user straight back.
  // Always overwritten — a client-supplied value never survives.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set(RETURN_TO_HEADER, req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  // Pages only — skip static assets, API/cron routes, and files.
  matcher: ["/((?!_next/static|_next/image|api|favicon.ico|.*\\.[^/]+$).*)"],
};
