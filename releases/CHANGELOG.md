# Axel pre-public verification ledger

These entries came from internal verification runs before Axel had public Git
tags. They are build records, not published releases. Public releases start at
v0.1.0 and use reviewed tags.

## v1.0.11 — 2026-06-11 (green)

- 34 real checks passed, 0 failed, 20 stubs skipped, 9 skipped.
- git 75164dd @ release-readiness-wave1 (dirty)
- Notes: Remediate all 5 1.0.10 findings: scheduleRetry throws on CF non-2xx (restores the double-delivery fix's ack-after-reenqueue invariant), billing rollup uniqExact dedup (stop overbilling on requeues), ingest fail-closed when DATABASE_URL absent in prod, erasure_requests audit retained on workspace teardown (GDPR proof), databricks workspace_host SSRF egress guards

## v1.0.10 — 2026-06-11 (green)

- 34 real checks passed, 0 failed, 20 stubs skipped, 9 skipped.
- git 7d6fc7f @ release-readiness-wave1 (dirty)
- Notes: Focused 1.0.9 hardening: resumePageCursor persistence (DB column, collapses 5 connector findings), updateRouteDestinations rejects pipeline routes (no DAG dead-letter), MongoClient close() (no per-tick leak), notification alerted_at after send, mute writable-role, signin constant-time, impersonation audit compensating-rollback

## v1.0.9 — 2026-06-11 (green)

- 34 real checks passed, 0 failed, 20 stubs skipped, 9 skipped.
- git 58e76c2 @ release-readiness-wave1 (dirty)
- Notes: Remediate all 5 1.0.8 blockers: CRITICAL pull-loop/deliver double-delivery (re-enqueue owns retries, transports ack), API-key workspace.status gate, source signing-secret AAD binding (v2 + v1 back-compat, cross-runtime), schema.sql event_maps→data_contracts rename, wizard Test Connection SSRF guard

## v1.0.8 — 2026-06-11 (green)

- 34 real checks passed, 0 failed, 20 stubs skipped, 9 skipped.
- git 4227b3c @ release-readiness-wave1 (dirty)
- Notes: Remediate all 8 1.0.7 blockers: erasure replay column, billing rollup row-cap, billing cancel→free recovery, updateDestination SSRF, Stripe per-page checkpoint, schema-qualified PG tables, schema.sql fingerprint drift, r2 connector in delivery-service

## v1.0.7 — 2026-06-11 (green)

- 34 real checks passed, 0 failed, 20 stubs skipped, 9 skipped.
- git c45707b @ release-readiness-wave1 (dirty)
- Notes: Remediation of the 1.0.6 audit findings: ingest /admin/trigger-event now redacts before the R2 write and indexes erasure subjects, matching the public path

## v1.0.6 — 2026-06-11 (green)

- 34 real checks passed, 0 failed, 20 stubs skipped, 9 skipped.
- git 0fd89f2 @ release-readiness-wave1 (dirty)
- Notes: Remediation of all 8 1.0.5 blockers (REST replay gates, erasure index prune + r2-skip-failed, retry backoff, postgres SSRF, muted in-app, replay field selection)

## v1.0.5 — 2026-06-11 (green)

- 34 real checks passed, 0 failed, 20 stubs skipped, 9 skipped.
- git 0a15dbd @ release-readiness-wave1 (dirty)
- Notes: Remediation of all 20 1.0.4 blockers (silent dead-letter loss, connector SSRF/TLS, pull pagination, ingest fail-closed, usage MV, etc.)

## v1.0.4 — 2026-06-11 (green)

- 34 real checks passed, 0 failed, 20 stubs skipped, 9 skipped.
- git 8f88672 @ release-readiness-wave1 (dirty)
- Notes: Remediation of all 1.0.3 audit blockers (2 criticals + 19 highs across 7 clusters); proxy-not-middleware was a verified false positive

## v1.0.3 — 2026-06-10 (green)

- 34 real checks passed, 0 failed, 20 stubs skipped, 9 skipped.
- git 77a76c1 @ release-readiness-wave1 (dirty)
- Notes: Fresh audit after A-F thematic pass + B-b3/D/F (breaker, bulk-mute, GDPR erasure)

## v1.0.2 — 2026-06-10 (green)

- 33 real checks passed, 0 failed, 20 stubs skipped, 10 skipped.
- git 1306825 @ release-readiness-wave1 (dirty)
- Notes: Postgres source-lookup fallback + Wave 4 audit fixes

## v1.0.1 — 2026-06-10 (green)

- 33 real checks passed, 0 failed, 20 stubs skipped, 10 skipped.
- git 80dcf67 @ release-readiness-wave1 (dirty)
- Notes: Post-audit waves 1-3: 29 release-blockers fixed

## v1.0.0 — 2026-06-08 (green)

- 33 real checks passed, 0 failed, 20 stubs skipped, 10 skipped.
- git 7d73ddf @ main (dirty)
