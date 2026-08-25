import { handoffToWorkspacePath } from "../../../../lib/workspace-handoff-route";

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
  const { workspaceId } = await params;
  return handoffToWorkspacePath(request, workspaceId, "/inbox");
}
