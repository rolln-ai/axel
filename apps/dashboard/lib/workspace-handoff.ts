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

/**
 * Server actions POST to whatever URL the browser is on. When the hand-off
 * URL is what the router kept (a soft navigation that followed the 303, for
 * example straight after signing in with a `returnTo`), an action would hit
 * the GET-only hand-off handler and fail with 405. Map such POSTs to the
 * canonical page so the action runs where it was defined.
 */
export function workspaceHandoffActionRewrite(pathname: string): string | null {
  const match = /^\/workspaces\/[^/]+\/(inbox|deliveries)\/?$/.exec(pathname);
  return match ? `/${match[1]}` : null;
}
