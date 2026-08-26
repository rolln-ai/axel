import { NextResponse } from "next/server";
import { requireSession, setActiveWorkspaceId } from "../../../../lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Workspace-aware entry point for notification and email links.
 *
 * Never trust the workspace id from the URL: only activate it when the signed-in
 * user is currently a member. Keeping the final inbox URL canonical also means
 * ordinary navigation continues to work exactly as before.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const session = await requireSession();
  const { workspaceId } = await params;
  const membership = session.memberships.find((item) => item.workspace_id === workspaceId);

  if (!membership) {
    return NextResponse.redirect(new URL("/dashboard", request.url), 303);
  }

  await setActiveWorkspaceId(membership.workspace_id);
  return NextResponse.redirect(new URL("/inbox", request.url), 303);
}
