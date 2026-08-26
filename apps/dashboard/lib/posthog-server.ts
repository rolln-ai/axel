import "server-only";
import { PostHog } from "posthog-node";

/**
 * Server-side PostHog for events that happen off the browser — account signup
 * inside a server action, subscription changes from a Stripe webhook. The
 * browser SDK can't see these, so we send them from Node with the same project
 * token.
 *
 * `flushAt: 1` / `flushInterval: 0` send each event on `flush()` rather than
 * batching, which is what we want in a serverless function: the instance can
 * freeze the moment the response is sent, so we flush before returning instead
 * of relying on a background timer that may never fire.
 *
 * Every helper here is best-effort and swallows its own errors. Analytics must
 * never be the reason a signup or a webhook fails.
 */
let client: PostHog | null = null;

function getClient(): PostHog | null {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return null;
  if (!client) {
    client = new PostHog(key, {
      host: process.env.POSTHOG_HOST ?? "https://us.i.posthog.com",
      flushAt: 1,
      flushInterval: 0,
    });
  }
  return client;
}

export async function captureServerEvent(params: {
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
  /** Group keys, e.g. `{ workspace: "ws_123" }`. */
  groups?: Record<string, string>;
}): Promise<void> {
  const ph = getClient();
  if (!ph) return;
  try {
    ph.capture({
      distinctId: params.distinctId,
      event: params.event,
      properties: params.properties,
      groups: params.groups,
    });
    await ph.flush();
  } catch {
    // Best-effort: a dropped analytics event must not surface to the caller.
  }
}
