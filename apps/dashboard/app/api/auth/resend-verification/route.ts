import { resendVerificationEmailForUser } from "../../../../lib/email-verification-resend";
import { getAuthenticatedUser } from "../../../../lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

function redirectBack(request: Request, succeeded: boolean): Response {
  const requestUrl = new URL(request.url);
  const referer = request.headers.get("referer");
  let target = new URL("/dashboard", requestUrl);
  if (referer) {
    const candidate = new URL(referer);
    if (candidate.origin === requestUrl.origin) target = candidate;
  }
  target.searchParams.set("verification-email", succeeded ? "sent" : "failed");
  return Response.redirect(target, 303);
}

/**
 * A stable URL for the verification banner. Unlike a generated Server Action
 * identifier, this endpoint keeps working for tabs left open across deploys.
 */
export async function POST(request: Request): Promise<Response> {
  const wantsJson = request.headers.get("accept")?.includes("application/json") === true;
  if (!sameOrigin(request)) {
    return wantsJson
      ? Response.json({ error: "Invalid request." }, { status: 403 })
      : redirectBack(request, false);
  }

  const auth = await getAuthenticatedUser();
  if (!auth) {
    return wantsJson
      ? Response.json({ error: "Your session expired. Refresh the page and sign in again." }, { status: 401 })
      : Response.redirect(new URL("/login", request.url), 303);
  }

  try {
    const state = await resendVerificationEmailForUser(auth.user.id);
    if (!wantsJson) return redirectBack(request, !state.error);
    return Response.json(state, { headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error("[api/auth/resend-verification] failed");
    if (!wantsJson) return redirectBack(request, false);
    return Response.json(
      { error: "Could not send the verification email. Try again." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
