import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { RETURN_TO_HEADER } from "./lib/return-to";
import { workspaceHandoffActionRewrite } from "./lib/workspace-handoff";

export function proxy(req: NextRequest): NextResponse {
  // Stamp the requested path (with query) onto the request so server-side
  // auth gates (requireSession / requireAuthenticatedUser) can bounce to
  // /login?returnTo=<here> and signIn can bring the user straight back.
  // Always overwritten — a client-supplied value never survives.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set(RETURN_TO_HEADER, req.nextUrl.pathname + req.nextUrl.search);

  // Server actions fired from a workspace hand-off URL (`/workspaces/:id/inbox`)
  // must reach the canonical page; the hand-off route only answers GET.
  if (req.method === "POST") {
    const canonical = workspaceHandoffActionRewrite(req.nextUrl.pathname);
    if (canonical) {
      const url = req.nextUrl.clone();
      url.pathname = canonical;
      return NextResponse.rewrite(url, { request: { headers: requestHeaders } });
    }
  }
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  // Pages only — skip static assets, API/cron routes, and files.
  matcher: ["/((?!_next/static|_next/image|api|favicon.ico|.*\\.[^/]+$).*)"],
};
