const AXEL_CLOUD_INGEST_URL = "https://ingest.axelapp.ai";
const AXEL_CLOUD_RAW_PAYLOAD_BUCKET = "axel-events-raw";

function isSelfHosted(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.AXEL_DEPLOYMENT_MODE?.trim().toLowerCase() === "self-hosted";
}

export function resolveIngestBaseUrl(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const selfHosted = isSelfHosted(env);
  const privateConfigured = env.AXEL_INGEST_URL?.trim();
  const configured = privateConfigured
    || (!selfHosted ? env.NEXT_PUBLIC_AXEL_INGEST_URL?.trim() : undefined);

  if (!configured) {
    if (selfHosted) {
      throw new Error(
        "AXEL_INGEST_URL is required when AXEL_DEPLOYMENT_MODE=self-hosted; refusing to send data to the Axel Cloud default",
      );
    }
    return AXEL_CLOUD_INGEST_URL;
  }

  const parsed = new URL(configured);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("AXEL_INGEST_URL must use http:// or https://");
  }
  const localHost = parsed.hostname === "localhost"
    || parsed.hostname === "127.0.0.1"
    || parsed.hostname === "[::1]";
  if (selfHosted && parsed.protocol !== "https:" && !localHost) {
    throw new Error(
      "AXEL_INGEST_URL must use https:// outside localhost when AXEL_DEPLOYMENT_MODE=self-hosted",
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error("AXEL_INGEST_URL must not contain embedded credentials");
  }

  let end = configured.length;
  while (end > 0 && configured.charCodeAt(end - 1) === 47) end -= 1;
  return configured.slice(0, end);
}

/**
 * Hosted Axel keeps its historical bucket default. A self-hosted process must
 * name its installation-specific bucket explicitly so an incomplete deploy
 * cannot read from or write to Axel Cloud's similarly named bucket.
 */
export function resolveRawPayloadBucket(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const configured = env.RAW_PAYLOAD_BUCKET?.trim();
  if (configured) return configured;
  if (isSelfHosted(env)) {
    throw new Error(
      "RAW_PAYLOAD_BUCKET is required when AXEL_DEPLOYMENT_MODE=self-hosted; refusing to use the Axel Cloud default",
    );
  }
  return AXEL_CLOUD_RAW_PAYLOAD_BUCKET;
}
