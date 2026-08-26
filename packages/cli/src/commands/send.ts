import { SAMPLE_PAYLOADS, listEventTypesFor, listProviders } from "../sample-payloads.js";

/**
 * `axel send <provider> <event_type> --to <url> [--payload <json>]`
 *
 * Offline simulator. Same canned payload library as `axel trigger`,
 * but POSTs directly to a destination URL — bypasses Axel entirely.
 * Drop-in `curl` replacement for "is my Stripe handler working?"
 * smoke tests, no source/route required, no signin required.
 *
 * Notably:
 *   - No PAT needed (this command is config-free).
 *   - Forwards canned provider headers so the receiver can dispatch
 *     by `Stripe-Signature` / `X-GitHub-Event` / `X-Shopify-Topic`.
 *   - Strips the canned signature (it's `t=0,v1=cli-sample`, won't
 *     verify) unless --keep-signature is set.
 */
export async function sendCommand(
  provider: string,
  eventType: string,
  flags: Record<string, string>,
): Promise<void> {
  const to = flags.to;
  if (!to) {
    console.error("Missing --to <url>. Example: --to http://localhost:3000/webhooks");
    process.exitCode = 64;
    return;
  }

  const key = `${provider}/${eventType}`;
  const sample = SAMPLE_PAYLOADS[key];
  if (!sample && !flags.payload) {
    console.error(`No canned payload for "${key}".`);
    console.error(`Providers available: ${listProviders().join(", ")}`);
    const eventTypesForProvider = listEventTypesFor(provider);
    if (eventTypesForProvider.length > 0) {
      console.error(`Event types for ${provider}: ${eventTypesForProvider.join(", ")}`);
    }
    console.error(`Pass --payload '{"json":"…"}' to send a custom body.`);
    process.exitCode = 64;
    return;
  }

  let body: unknown;
  if (flags.payload) {
    try {
      body = JSON.parse(flags.payload);
    } catch (err: unknown) {
      console.error(`--payload is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 64;
      return;
    }
  } else {
    body = sample!.body;
  }

  const keepSignature = flags["keep-signature"] === "true";
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  for (const [k, v] of Object.entries(sample?.headers ?? {})) {
    const lc = k.toLowerCase();
    // The canned `stripe-signature: t=0,v1=cli-sample` value never
    // verifies. Strip by default so a properly-coded handler doesn't
    // 401 the smoke test for the wrong reason.
    if (!keepSignature && (lc === "stripe-signature" || lc === "x-axel-signature")) continue;
    headers[k] = v;
  }
  headers["x-axel-cli-source"] = "axel send";

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(to, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err: unknown) {
    console.error(`POST failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  const took = Date.now() - started;
  const text = await res.text().catch(() => "");
  const statusOk = res.status >= 200 && res.status < 300;
  console.log(`POST ${to} → ${res.status} (${took}ms)`);
  if (text.length > 0) {
    const preview = text.length > 500 ? text.slice(0, 500) + "…" : text;
    console.log(preview);
  }
  if (!statusOk) process.exitCode = 1;
}
