import { validateDestinationUrl } from "@axel/shared";
import {
  CREATABLE_DESTINATION_SCHEMAS,
  DESTINATION_SCHEMAS,
  schemaFor,
  type DestinationType,
} from "./destination-defaults";

/**
 * Shared destination form validation — one copy for the create/edit actions
 * (lib/destination-actions.ts) AND the connectivity probes (lib/test-destination.ts).
 *
 * test-destination.ts used to carry hand-mirrored copies of these checks
 * ("kept in sync here" by comment) that had already drifted: its copy lost
 * the SSRF host check on connection strings and the outer-whitespace
 * rejection. Centralising here closes that gap for good.
 */

/**
 * True for ANY known destination type, including legacy types that can no
 * longer be created (`availableForCreate: false`, e.g. databricks_sql).
 * Use for surfaces that must keep working against existing rows: edit,
 * rotate-credentials, and the connectivity probes.
 */
export function validateDestinationType(value: string): value is DestinationType {
  return DESTINATION_SCHEMAS.some((s) => s.type === value);
}

/**
 * True only for types the create form offers. Use for create-time gates so
 * a hand-crafted POST can't mint a destination of a retired type.
 */
export function isCreatableDestinationType(value: string): value is DestinationType {
  return CREATABLE_DESTINATION_SCHEMAS.some((s) => s.type === value);
}

/**
 * Pick every (key,value) pair from FormData whose key matches a field in
 * the chosen destination type's schema. Anything else (CSRF tokens, the
 * type selector itself) is dropped.
 *
 * Values are kept RAW (untrimmed) so validateDestinationValues can detect
 * leading/trailing whitespace — almost always a paste error. Trim before
 * handing values to code that expects clean input (persistence already
 * trims in splitFieldsByKind).
 *
 * `prefix` supports namespaced forms (the pipeline wizard posts destination
 * fields as `dest_field_<key>`).
 */
export function readDestinationValues(
  formData: FormData,
  type: DestinationType,
  opts: { prefix?: string } = {},
): Record<string, string> {
  const prefix = opts.prefix ?? "";
  const schema = schemaFor(type);
  const out: Record<string, string> = {};
  for (const field of schema.fields) {
    const v = formData.get(`${prefix}${field.key}`);
    if (typeof v === "string") out[field.key] = v;
  }
  return out;
}

/**
 * Catch obvious paste-mistakes BEFORE we encrypt and persist them, then
 * spend a 30-minute round-trip wondering why Atlas/RDS are returning
 * "bad auth". The single most common one we've actually seen in
 * production is a literal space between the username colon and the
 * password — copy/paste from chat or email often introduces it. The
 * Mongo/PG drivers happily URL-encode that space as part of the
 * password, present a 17-char password to a server that knows a
 * 16-char password, and the operator gets a generic "bad auth" with
 * no hint of where to look.
 *
 * Returns a human-readable error string or null if everything looks OK.
 * Validation is intentionally permissive — we only catch shapes that
 * are *definitely* wrong, never "looks weird". A legitimate password
 * containing %20 is fine; a literal space is rejected.
 *
 * NOTE: mutates `values` in place for textarea secrets (trims them), same
 * as the original actions.ts implementation.
 */
export function validateDestinationValues(
  type: DestinationType,
  values: Record<string, string>,
): string | null {
  // AXE-34 — SSRF pre-check on URL-shaped fields. Catches private /
  // link-local / metadata / loopback hosts before they ever hit our
  // delivery pipeline. The HTTP connector enforces the same rule at
  // delivery time as belt+suspenders against DNS rebinding.
  const schema = schemaFor(type);
  for (const field of schema.fields) {
    if (field.inputType !== "url") continue;
    const raw = values[field.key];
    if (raw === undefined || raw === "") continue;
    const reason = validateDestinationUrl(raw.trim());
    if (reason) {
      return `${field.label}: ${publicUrlValidationReason(reason)}`;
    }
  }
  for (const field of schema.fields) {
    if (field.kind !== "secret") continue;
    const raw = values[field.key];
    if (raw === undefined || raw === "") continue;

    // Multi-line pasted secrets (e.g. a BigQuery service-account JSON key)
    // legitimately carry a trailing newline, and outer whitespace is
    // insignificant for a JSON blob (JSON.parse ignores it). Normalize by
    // trimming in place rather than rejecting the paste.
    if (field.inputType === "textarea") {
      values[field.key] = raw.trim();
      continue;
    }

    // Outer-whitespace check applies to every single-line secret. Trimming
    // would be tempting, but a value that starts/ends with whitespace is
    // almost never intentional and almost always a paste-error — surfacing it
    // explicitly avoids silently changing what the operator typed.
    if (raw !== raw.trim()) {
      return `${field.label} has leading or trailing whitespace — remove it (or URL-encode as %20 if intentional).`;
    }

    // Connection-string-shaped fields get extra structural checks.
    if (field.key === "connection_string") {
      const schemeMatch = raw.match(/^([a-z][a-z0-9+\-.]*):\/\//i);
      if (!schemeMatch) {
        return `${field.label} doesn't look like a URL — it must start with mongodb://, mongodb+srv://, postgres://, or postgresql://.`;
      }
      // Userinfo segment is everything between "://" and the first "@".
      // No "@" at all → no host → reject (would fail at connect time
      // anyway, but with a worse error).
      const afterScheme = raw.slice(schemeMatch[0].length);
      const atIndex = afterScheme.indexOf("@");
      if (atIndex === -1) {
        return `${field.label} is missing the "@host" portion — expected format: ${schemeMatch[1]}://user:password@host/...`;
      }
      const userinfo = afterScheme.slice(0, atIndex);
      // Literal whitespace in userinfo is the bug we keep getting bitten
      // by. Tabs and newlines are equally bad — match \s.
      if (/\s/.test(userinfo)) {
        return `${field.label} has whitespace inside the user:password segment. The most common cause is a stray space between ":" and the password — try ${schemeMatch[1]}://user:passwordWithoutSpaces@host/...`;
      }
      // SSRF: connection_string is inputType "password", so the URL-field loop
      // above skips it. Check the host portion here so a postgres/mongodb URL
      // can't point at a private/link-local/metadata host (e.g.
      // postgres://u:p@169.254.169.254/db). Multi-host strings are comma-split.
      const hostPart = afterScheme.slice(atIndex + 1).split(/[/?]/)[0] ?? "";
      for (const entry of hostPart.split(",")) {
        const hostport = entry.trim();
        if (!hostport) continue;
        const ssrf = validateDestinationUrl(`https://${hostport}`);
        if (ssrf) {
          return `${field.label}: The connection target is not allowed by the outbound network policy.`;
        }
      }
    }
  }
  return null;
}

/** Keep field-level validation useful without reflecting a submitted host or scheme. */
function publicUrlValidationReason(reason: string): string {
  if (/username|password|credentials/i.test(reason)) {
    return "URL credentials are not allowed. Use an encrypted authentication field instead.";
  }
  if (/malformed|required|hostname/i.test(reason)) {
    return "URL is malformed or incomplete.";
  }
  if (/http or https|must use https/i.test(reason)) {
    return "URL must use HTTP or HTTPS.";
  }
  return "The URL target is not allowed by the outbound network policy.";
}
