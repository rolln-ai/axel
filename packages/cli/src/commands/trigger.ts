import { CliApiError, makeClient } from "../api-client.js";
import { readConfig } from "../config.js";
import { SAMPLE_PAYLOADS, listEventTypesFor, listProviders } from "../sample-payloads.js";

interface TriggerResponse {
  event_id: string;
  received_at: string;
  source_id: string;
}

/**
 * `axel trigger <provider> <event_type> --source <id> [--payload <json>]`
 *
 * Sends a sample (or `--payload`-overridden) event through delivery-
 * service `/v1/cli/trigger`, which proxies into the ingest worker's
 * admin/trigger-event endpoint. The event is stamped is_test=true so
 * it shows up in the dashboard inspector without polluting billing
 * counters or fanning out to live destinations.
 */
export async function triggerCommand(
  provider: string,
  eventType: string,
  flags: Record<string, string>,
): Promise<void> {
  const config = await readConfig();
  if (!config) {
    console.error("Not signed in. Run `axel auth login`.");
    process.exitCode = 1;
    return;
  }

  const sourceId = flags.source;
  if (!sourceId) {
    console.error("Missing --source <source_id>. Pass the source you want to trigger an event into.");
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

  try {
    const response = await makeClient(config).post<TriggerResponse>("/v1/cli/trigger", {
      source_id: sourceId,
      provider,
      event_type: eventType,
      body,
      headers: sample?.headers ?? { "content-type": "application/json" },
    });
    console.log(`Triggered ${provider}/${eventType} → source ${response.source_id}`);
    console.log(`  event_id:    ${response.event_id}`);
    console.log(`  received_at: ${response.received_at}`);
    console.log(`  inspect:     ${config.api_base}/sources/${sourceId}/events/${response.event_id}`);
  } catch (err: unknown) {
    if (err instanceof CliApiError) {
      console.error(`Trigger failed (${err.status} ${err.code}): ${err.message}`);
    } else {
      console.error(`Trigger failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exitCode = 1;
  }
}
