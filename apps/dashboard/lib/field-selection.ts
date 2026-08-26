/**
 * Source-level field projection.
 *
 * A source's `field_selection` is an array of dot-paths (e.g.
 * `["customer.email", "amount", "data.object.id"]`). When set, the router
 * projects each event's decoded payload through these paths before fanning
 * out to destinations — only the named fields make it to the destination.
 *
 * Behavior:
 *   - `null` / `[]` selection → pass payload through unchanged
 *   - non-empty selection → return a NEW object containing only the picked
 *     paths, preserving nested structure (so `customer.email` produces
 *     `{customer: {email: "..."}}`, not `{"customer.email": "..."}`)
 *   - missing paths are silently omitted from the output
 *   - non-object payloads (string, number, array at root) wrap into
 *     `{value: payload}` for projection — only `{}-rooted` payloads make
 *     sense to project.
 *
 * The projection itself delegates to `projectPayload` in @axel/shared — the
 * exact implementation the routers run at fan-out time (including its
 * prototype-pollution guard) — so the dashboard preview always matches
 * production behavior. This module keeps only the editor-facing parse/format
 * helpers plus the dashboard-specific non-object wrapping (see below).
 */

import { projectPayload as sharedProjectPayload } from "@axel/shared";

export type FieldSelection = readonly string[] | null;

export interface ParseResult {
  paths: string[];
  errors: { line: number; message: string }[];
}

/**
 * Parse the textarea input for the editor. One path per line. Lines starting
 * with `#` are comments and ignored. Empty lines are ignored. Each non-empty
 * line is validated against the path syntax (alphanumeric segments separated
 * by dots; segments may not start with a digit; no whitespace).
 */
export function parseFieldSelectionText(text: string): ParseResult {
  const paths: string[] = [];
  const errors: { line: number; message: string }[] = [];

  const lines = text.split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line.length === 0) return;
    if (line.startsWith("#")) return;
    if (!isValidDotPath(line)) {
      errors.push({
        line: index + 1,
        message: `Invalid path "${line}". Use letters, digits and dots only — segments can't start with a digit and can't contain spaces.`,
      });
      return;
    }
    if (paths.includes(line)) {
      // Silently dedupe — operator typed the same path twice; not an error.
      return;
    }
    paths.push(line);
  });
  return { paths, errors };
}

export function formatFieldSelectionText(paths: FieldSelection): string {
  if (!paths || paths.length === 0) return "";
  return paths.join("\n");
}

const PATH_SEGMENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function isValidDotPath(path: string): boolean {
  if (path.length === 0) return false;
  const segments = path.split(".");
  return segments.every((segment) => PATH_SEGMENT.test(segment));
}

/**
 * Project `payload` to only the fields named by `paths`. Returns a new object
 * preserving nested structure. Returns the input unchanged when `paths` is
 * empty or null.
 *
 * Delegates to @axel/shared's implementation for the object case; the only
 * dashboard-specific behavior kept here is wrapping non-object roots into
 * `{value: payload}` so the preview editor still renders something sensible
 * for scalar payloads.
 */
export function projectPayload(payload: unknown, paths: FieldSelection): unknown {
  if (!paths || paths.length === 0) return payload;
  if (payload === null || payload === undefined) return payload;
  if (typeof payload !== "object") return { value: payload };
  return sharedProjectPayload(payload, [...paths]);
}
