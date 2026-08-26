-- Migration 0012: AI-generated dead letter explanations (AXE-54).
--
-- Caches the result of the "Why did this fail?" Claude call against the
-- dead_letters row so repeat clicks cost nothing. The values render as
-- a small card above the existing investigate-page failure summary.
--
-- Columns are nullable so the rest of the dashboard stays oblivious
-- when AI features are disabled (no OPENROUTER_API_KEY) or the
-- explanation hasn't been requested yet.

ALTER TABLE dead_letters
  ADD COLUMN IF NOT EXISTS ai_summary text;

ALTER TABLE dead_letters
  ADD COLUMN IF NOT EXISTS ai_suggested_action text;

ALTER TABLE dead_letters
  ADD COLUMN IF NOT EXISTS ai_summarized_at timestamptz;
