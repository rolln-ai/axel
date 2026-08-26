import "server-only";
import { maskPiiInText } from "@axel/shared";
import { isSensitivePath } from "./inference";

/**
 * Redact PII from a Data Contract fixture payload before it is stored.
 *
 * `data_contract_fixtures` keep verbatim sampled payloads (`input_payload`) and
 * their transformed output (`expected_output`) as the contract's regression
 * test set. Fixtures are long-lived (they gate activation), so they can't be
 * age-purged — instead we mask PII at capture and recompute the expected output
 * from the masked input.
 *
 * Two layers:
 *   - path-based: a leaf whose field path is flagged sensitive (isSensitivePath —
 *     email/ssn/card/phone/etc. by name) is replaced with a type-preserving
 *     marker.
 *   - value-based: any remaining string leaf is run through maskPiiInText to
 *     catch emails and long digit runs embedded in non-obviously-named fields.
 *
 * Consistency guarantee: the generated Data Contract transforms are purely
 * structural (pick-by-path / wrap / passthrough — never value-deriving), so
 * `runTransform(redact(input))` equals the redacted transform output. Storing
 * `input = redact(payload)` and `expected = runTransform(redact(payload))` keeps
 * the fixture pair valid while removing PII from both sides.
 */
export function redactFixturePayload(value: unknown): unknown {
  return redactAt(value, "");
}

const REDACTED = "[REDACTED]";

function redactAt(value: unknown, path: string): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactAt(item, `${path}[]`));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactAt(child, path ? `${path}.${key}` : key);
    }
    return out;
  }
  // Leaf value.
  if (path && isSensitivePath(path)) {
    // Preserve the type so structural transforms behave identically.
    if (typeof value === "string") return REDACTED;
    if (typeof value === "number") return 0;
    return value; // booleans / other scalars aren't PII on their own
  }
  if (typeof value === "string") return maskPiiInText(value);
  return value;
}
