# GDPR per-subject erasure — finder + gated executor + lifecycle

> ⚠️ **This path performs REAL deletes when enabled.** As of release 1.0.4 the
> destructive executor is implemented: with `ERASURE_EXECUTE_ENABLED=true`,
> `executeErasure` issues actual ClickHouse `ALTER … DELETE`, R2 object deletes,
> and Postgres deletes. The flag defaults **OFF**, in which case it dry-runs
> (locates + plans, zero mutations). Treat enabling it as a destructive,
> irreversible operation.

It locates a subject's events via the `erasure_subjects` index (now populated at
ingest — see below), builds the per-store erasure plan, and — when the gate is on
— executes it via the super-admin lifecycle (`erasure-lifecycle.ts` →
`runErasureAction`), recording an `erasure_requests` audit row. A cardinality
guard refuses likely shared-value mass erasures without explicit confirmation.

## Modules
- `erasure-subject-id.ts` — `deriveSubjectId` / `deriveSubjectIds`: the hashing
  + normalization the Phase-1 foundation deferred. `sub_<sha256>` over
  `normVersion ␠ workspace_id ␠ kind ␠ normalize(kind, raw)`.
- `erasure-finder.ts` — `findSubjectEvents`: point lookup on `erasure_subjects`,
  de-dupes events indexed under multiple subject_ids, computes coverage +
  honest disclosure. Read-only.
- `erasure-executor.ts` — `buildErasurePlan` (pure) + `executeErasure`
  (dry-run, gated). The plan encodes the design review's required corrections
  (received_at-bounded ClickHouse mutations; `#rpy_` replay expansion; rollup
  deletes; workspace-pinned chunked Postgres; four R2 key families; out-of-scope
  disclosure).

## Flagged defaults (decisions I made — please confirm or override; design §9)

1. **Never report `full_within_window` (§9.1–9.2).** The finder emits only
   `partial` or `unknown`. Proving complete erasure for opaque-payload subjects
   is impossible by construction, so we structurally cannot claim it. → product
   decision: is `partial` + disclosure acceptable as the standing answer, or
   must legal fund a full-history R2 scan?

2. **Shared-value over-erasure is NOT guarded here (§9.3).** Two people sharing
   a configured value collapse to one `subject_id`. Normalization is
   deliberately minimal (email lowercase/trim only) to avoid widening this.
   → decision: where does the cardinality guard / operator confirmation live
   (above a match-count threshold)?

3. **Out-of-scope PII tables are disclosed, not auto-erased (§9.4)**
   (`notifications`, `dead_letter_mutes`, ClickHouse `events_daily`). They have
   no `event_id` linkage. → decision: manual operator process, or add event_id
   linkage?

4. **Delivery-mirror + queue-spill R2 keys are reconstructed at execute time**
   from `delivery_attempts`, not stored in the index. The dry-run plan lists
   them as `derivedAtExecute`. This depends on `delivery_attempts` rows still
   existing (30-day ClickHouse TTL) — disclosed.

5. **`subject_id` is a hash, never plaintext (§9.5).** Even when a subject path
   overlaps a redact path, the index holds only the locator. At-rest encryption
   posture for `erasure_subjects` still needs a call (match signing-secret
   handling?).

## Built (1.0.4)
- The destructive executor — real ClickHouse `ALTER … DELETE` (partition-pruned
  + replay-suffixed-id aware), R2 deletes (events/ + reconstructed queue-spill),
  chunked workspace-pinned Postgres deletes, per-store fault isolation. Gated by
  `ERASURE_EXECUTE_ENABLED` (default OFF → dry-run).
- The ingest write-path index hook: the ingest worker now populates
  `erasure_subjects` for sources with `subject_key_paths` (Web-Crypto subject-id,
  byte-identical to the dashboard read-path; written via `ctx.waitUntil`).
- The `erasure_requests` lifecycle/audit persistence (`erasure-lifecycle.ts`) +
  the super-admin server action (`runErasureAction`).

## Shipped (ROL-319, 2026-07-11) + gate ENABLED in production
- **Subject-key config** (`subject_key_paths`): `validateSubjectKeyPaths`
  (`@axel/shared`), `updateSourceSubjectKeysAction` (owner/admin) that stamps
  `subject_indexing_active_since` on first set, and the `SubjectKeysEditor` on
  the source-detail settings page. Coverage disclosure is now real (was always
  `unknown` because nothing stamped the window).
- **Erasure request UI**: `runWorkspaceErasureAction` (owner-only, workspace
  pinned to the session) + `ErasureRequestPanel` in Settings → Danger. The
  super-admin `runErasureAction` remains for cross-workspace ops.
- **Executor correctness fixes**: the `erasure_subjects` index is deleted only
  after every destructive store deletes cleanly (partial failure retains it so
  the erasure is retryable); RE2 metacharacters in the replay-match regex are
  escaped; a 30-day retention purge for `erasure_subjects` (delivery-service
  `retention.ts`) keeps the index from outliving the data it points to.
- **`ERASURE_EXECUTE_ENABLED=true` is now set in the production dashboard env** —
  erasure requests perform REAL deletes. First real run should be eyeballed.

## Still open
- The optional TTL-bounded backfill of historical `erasure_subjects` (current
  index is forward-only from when a source enables `subject_key_paths`).
- At-rest encryption posture for `erasure_subjects` (it holds only hashed
  locators, never raw PII).
- One live end-to-end erasure run against real ClickHouse/R2/PG (all automated
  tests use fakes) to confirm the destructive path before heavy reliance.
