import "server-only";
import {
  isSecretLikeWebhookKey,
  isWebhookHeaderContainerKey,
  redactSecretLikeText,
} from "@axel/shared";
import { isSensitivePath } from "./inference";

/**
 * Redact PII from a Data Contract fixture payload before it is stored.
 *
 * The activation gate first builds fixtures in memory from sampled payloads.
 * This pass masks recognizable PII before those fixtures leave codegen. The
 * repository then replaces every remaining scalar with a type placeholder
 * before storage, so arbitrary free text cannot become durable fixture data.
 *
 * Two layers:
 *   - path-based: a leaf whose field path is flagged sensitive (isSensitivePath —
 *     email/ssn/card/phone/etc. by name) is replaced with a type-preserving
 *     marker.
 *   - value-based: any remaining string leaf is checked for common PII,
 *     credentials, signed URLs, private keys, and opaque tokens.
 *
 * Consistency guarantee: the generated Data Contract transforms are purely
 * structural (pick-by-path / wrap / passthrough — never value-deriving), so
 * `runTransform(redact(input))` equals the redacted transform output. Storing
 * `input = redact(payload)` and `expected = runTransform(redact(payload))` keeps
 * the transient fixture pair valid for the activation check.
 */
export function redactFixturePayload(value: unknown): unknown {
  return redactAt(value, "", false);
}

const REDACTED = "[REDACTED]";

function redactAt(value: unknown, path: string, secretContainer: boolean): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactAt(item, `${path}[]`, secretContainer));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactAt(
        child,
        path ? `${path}.${key}` : key,
        secretContainer ||
          isSecretLikeWebhookKey(key) ||
          isWebhookHeaderContainerKey(key),
      );
    }
    return out;
  }
  // Leaf value.
  if (path && (secretContainer || isSensitivePath(path) || isSecretLikeWebhookKey(path))) {
    // Preserve the type so structural transforms behave identically.
    if (typeof value === "string") return REDACTED;
    if (typeof value === "number") return 0;
    return value; // booleans / other scalars aren't PII on their own
  }
  if (typeof value === "string") return redactSecretLikeText(value);
  return value;
}
