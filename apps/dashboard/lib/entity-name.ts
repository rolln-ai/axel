/**
 * Shared 2–64 display-label validation used by sources, destinations, and
 * routes (pipelines). These names are human-readable labels only — they're
 * never used as slugs, URLs, table names, or keys (routes resolve by rt_ id,
 * sources by token), so spaces and mixed case are allowed. We only require the
 * name to start and end with a letter or number, which keeps out leading/
 * trailing whitespace and stray punctuation. Lives outside the "use server"
 * action modules so it can be imported by any of them (server-action files may
 * only export async actions). Returns a human-readable error, or null when OK.
 */
export function entityNameError(name: string): string | null {
  if (name.length < 2 || name.length > 64) return "Name must be 2–64 characters.";
  if (!/^[a-z0-9][a-z0-9 ._-]*[a-z0-9]$/i.test(name)) {
    return "Use letters, numbers, spaces, or . _ - and start and end with a letter or number.";
  }
  return null;
}

/**
 * A safe, length-capped default pipeline name derived from a source name.
 * Truncates the source part, not the suffix, so the result always ends with
 * a letter (a tail-end slice could leave a trailing space or dot, which
 * entityNameError rejects).
 */
export function defaultPipelineName(sourceName: string): string {
  const base = sourceName.slice(0, 64 - " pipeline".length).trim();
  return `${base} pipeline`;
}

/**
 * Recognise "this name is already taken" regardless of whether the failure
 * came from the in-app SELECT pre-check (throws a sentinel string) or from
 * Postgres rejecting the INSERT with a 23505 unique_violation on the new
 * (workspace_id, lower(name)) indexes added in migration 0005. Both code
 * paths matter: SELECT catches the common case without round-tripping a
 * failed INSERT, and the unique index closes the race when two concurrent
 * transactions both pass the SELECT.
 */
export function isUniqueViolation(err: unknown, kind: "sources" | "destinations"): boolean {
  const expectedSentinel = kind === "sources" ? "source_name_taken" : "destination_name_taken";
  if (err instanceof Error && err.message === expectedSentinel) return true;
  if (err && typeof err === "object" && (err as { code?: string }).code === "23505") {
    const constraint = (err as { constraint?: string }).constraint ?? "";
    const table = (err as { table?: string }).table ?? "";
    if (kind === "sources") {
      return constraint.includes("sources_workspace_lower_name") || table === "sources";
    }
    return constraint.includes("destinations_workspace_lower_name") || table === "destinations";
  }
  return false;
}
