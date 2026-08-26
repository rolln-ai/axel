"use client";

import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import type { ReactNode } from "react";

/**
 * Makes the browser PostHog client (initialised in `instrumentation-client.ts`)
 * available to client components via `usePostHog()`. Used by `PostHogIdentify`
 * and the sign-out button. Safe to mount even when PostHog is disabled — the
 * shared `posthog` singleton no-ops until `init` runs.
 */
export function PostHogProvider({ children }: { children: ReactNode }) {
  return <PHProvider client={posthog}>{children}</PHProvider>;
}
