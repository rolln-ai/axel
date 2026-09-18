-- Migration 0080: remind about an open incident once a day, not every six hours.
--
-- The opening notice is the first email for an incident. Later reminders for
-- the same incident are now 24 hours apart; apps/dashboard/lib/impact-alerts.ts
-- schedules the same interval when it records a reminder. Incidents that are
-- open under the six-hour cadence move to the daily one: their next reminder
-- was due six hours after the last notice, so 18 more hours makes it 24.
ALTER TABLE pipeline_incidents ALTER COLUMN next_reminder_at SET DEFAULT now() + interval '24 hours';
UPDATE pipeline_incidents SET next_reminder_at = next_reminder_at + interval '18 hours' WHERE resolved_at IS NULL;
