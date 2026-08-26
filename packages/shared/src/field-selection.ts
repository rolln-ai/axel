/**
 * Field selection — project a payload down to an operator-selected set of dotted
 * paths so destinations only receive the contracted fields. Shared so the Node
 * router (replay/native path) projects identically to router-edge.
 *
 * Null/empty paths → the payload is returned unchanged. Non-object payloads pass
 * through. Missing paths are skipped. Nested paths are rebuilt at the same shape.
 */
// Path segments that must never be projected: selecting one of these would walk
// into (read side) and then write back over (cursor[seg] = …) the object's
// prototype chain, mutating Object.prototype for the whole process
// (prototype-pollution). They are never legitimate contracted fields.
const DANGEROUS_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

export function projectPayload(payload: unknown, paths: string[] | null | undefined): unknown {
  if (!paths || paths.length === 0) return payload;
  if (payload === null || payload === undefined) return payload;
  if (typeof payload !== "object" || Array.isArray(payload)) return payload;

  // Null-prototype accumulator: a bracket write like out[key] = … can therefore
  // never reach Object.prototype even if a key slips through, on top of the
  // per-path guard below (defence in depth; also clears CodeQL
  // js/prototype-polluting-assignment, which the path-level guard alone doesn't).
  const out: Record<string, unknown> = Object.create(null);
  for (const path of paths) {
    const segments = path.split(".");
    // Skip the whole path if any segment is a prototype-pollution key.
    if (segments.some((segment) => DANGEROUS_SEGMENTS.has(segment))) continue;
    let current: unknown = payload;
    let missing = false;
    for (const segment of segments) {
      if (
        current &&
        typeof current === "object" &&
        !Array.isArray(current) &&
        segment in (current as Record<string, unknown>)
      ) {
        current = (current as Record<string, unknown>)[segment];
      } else {
        missing = true;
        break;
      }
    }
    if (missing) continue;
    let cursor: Record<string, unknown> = out;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!;
      const existing = cursor[seg];
      if (existing && typeof existing === "object" && !Array.isArray(existing)) {
        cursor = existing as Record<string, unknown>;
      } else {
        const next: Record<string, unknown> = Object.create(null);
        cursor[seg] = next;
        cursor = next;
      }
    }
    cursor[segments[segments.length - 1]!] = current;
  }
  return out;
}
