/**
 * Workspace-scoped entry URLs used by notification and email links
 * (`/workspaces/:id/inbox`, `/workspaces/:id/deliveries?...`).
 *
 * The signed-in user may be looking at a different workspace than the one
 * the notification is about. These helpers activate the target workspace
 * (when the user is a member) and bounce to the canonical in-app path,
 * keeping the query string so filters survive the hop.
 */

export function workspaceHandoffLocation(requestUrl: string, destPath: string): URL {
  const dest = new URL(destPath, requestUrl);
  dest.search = new URL(requestUrl).search;
  return dest;
}
