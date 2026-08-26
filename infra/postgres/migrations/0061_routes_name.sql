-- Add a human-readable name to routes (pipelines).
--
-- Nullable so this is safe to apply AHEAD of the code that writes it
-- (migrate-first): old code ignores the column, new code requires a name at
-- creation. Existing rows are backfilled from their source so the Live
-- pipelines list never shows a raw rt_ id. Length is app-enforced (2–64); we
-- only truncate the backfill so a long source name can't exceed that.

ALTER TABLE routes ADD COLUMN IF NOT EXISTS name text;

UPDATE routes r
   SET name = left(s.name || ' pipeline', 64)
  FROM sources s
 WHERE s.id = r.source_id
   AND r.name IS NULL;
