import { handoffToWorkspacePath } from "../../../../lib/workspace-handoff-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Workspace-aware entry for digest / replay-complete links.
 *
 * `/workspaces/:id/deliveries?status=failed` switches the active workspace
 * (when the recipient is a member) then lands on the canonical deliveries
 * stream with the query string intact.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const { workspaceId } = await params;
  return handoffToWorkspacePath(request, workspaceId, "/deliveries");
}
