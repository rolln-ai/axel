"use client";

import { usePostHog } from "posthog-js/react";
import { useEffect } from "react";

/**
 * Links the current browser to the signed-in user and their active workspace.
 * Rendered once in the authenticated layout with values from the server-side
 * session, so PostHog attributes events to a known person and groups them by
 * workspace. Re-runs if the user switches workspace.
 *
 * Not rendered during admin impersonation — we don't want a support session to
 * overwrite the customer's identity or attribute staff actions to them.
 */
export function PostHogIdentify({
  distinctId,
  email,
  name,
  workspaceId,
  workspaceName,
}: {
  distinctId: string;
  email: string;
  name: string;
  workspaceId: string;
  workspaceName: string;
}) {
  const posthog = usePostHog();

  useEffect(() => {
    if (!posthog) return;
    posthog.identify(distinctId, { email, name });
    posthog.group("workspace", workspaceId, { name: workspaceName });
  }, [posthog, distinctId, email, name, workspaceId, workspaceName]);

  return null;
}
