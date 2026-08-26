/**
 * Retention bounds — the single source of truth for the dashboard surfaces
 * that read or write workspace/source retention:
 *   - RetentionSettingsPanel (workspace form min/max)
 *   - TransientModeEditor (per-source raw-payload override min/max)
 *   - updateWorkspaceRetentionAction / updateSourceTransientModeAction (server
 *     validation, so the form never submits a value the DB would reject)
 *
 * These MUST stay in lockstep with the Postgres CHECK constraints in
 * infra/postgres/migrations/0048_retention_caps.sql. That migration is the real
 * backstop; this constant only keeps the UI/action honest. If you change a
 * bound here, change it there too (and vice versa).
 *
 * Why these maxes (lowered off 0018's flat 10-year / 3650-day ceiling):
 *   - raw_payload capped at 30 to match the R2 lifecycle ceiling
 *     (infra/cloudflare/r2-lifecycle.json hard-deletes event bodies at 30d).
 *     Sub-30 values ARE enforced on the bytes by the delivery-service R2
 *     sweep (apps/delivery-service/src/r2-retention.ts), down to a short
 *     safety floor (RAW_RETENTION_MIN_AGE_DAYS) that protects in-flight
 *     delivery. 0 = transient (purged a few days after delivery).
 *   - dead_letter / replay lowered to bound the only genuinely expensive,
 *     long-pinnable Postgres tables.
 *   - audit_log LEFT at 3650 — compliance frameworks (SOC2/ISO27001/HIPAA) want
 *     long audit retention; the 30-day floor is the minimum, not a ceiling.
 */
export interface RetentionBound {
  min: number;
  max: number;
}

export const RETENTION_BOUNDS = {
  raw_payload_retention_days: { min: 0, max: 30 },
  dead_letter_retention_days: { min: 1, max: 365 },
  replay_request_retention_days: { min: 1, max: 90 },
  audit_log_retention_days: { min: 30, max: 3650 },
} as const satisfies Record<string, RetentionBound>;

export type RetentionField = keyof typeof RETENTION_BOUNDS;
