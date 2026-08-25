import "server-only";

import { NextResponse } from "next/server";
import { requireSession, setActiveWorkspaceId } from "./session";
import { workspaceHandoffLocation } from "./workspace-handoff";

/**
 * Activate `workspaceId` (if the caller is a member) and 303 to `destPath`,
 * preserving the incoming query string. Used by `/workspaces/:id/inbox` and
 * `/workspaces/:id/deliveries` so email links switch tenant then filter.
 */
export async function handoffToWorkspacePath(
  request: Request,
  workspaceId: string,
  destPath: string,
): Promise<Response> {
  const session = await requireSession();
  const membership = session.memberships.find((item) => item.workspace_id === workspaceId);

  if (!membership) {
    return NextResponse.redirect(new URL("/dashboard", request.url), 303);
  }

  await setActiveWorkspaceId(membership.workspace_id);
  return NextResponse.redirect(workspaceHandoffLocation(request.url, destPath), 303);
}
