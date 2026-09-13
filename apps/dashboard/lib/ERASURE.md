# Subject erasure

Subject erasure finds indexed events and builds a deletion plan for ClickHouse,
R2, and Postgres. `ERASURE_EXECUTE_ENABLED=true` enables deletion. With the flag
unset, the executor returns a dry run and does not delete data. Check the actual
deployment setting before submitting an erasure request.

Workspace owners can request erasure through **Settings**, **Danger**. Super-admins
have a separate action for operations across workspaces. Both use
`processErasureRequest` and record the request in `erasure_requests`.

## Index and coverage

Ingest indexes sources with `subject_key_paths` into `erasure_subjects`.
`subject_indexing_active_since` records when indexing began. Subject IDs are
hashes of normalized identifiers, scoped to the workspace; the index does not
store the raw identifiers.

The finder reports `partial` or `unknown` coverage, never `full_within_window`.
It cannot establish complete erasure for events from before indexing began,
expired index entries, or identifiers hidden in unindexed payload fields.
A successful deletion therefore ends as `partial`, not a claim that every
copy of a person's data has been removed.

Different people can share the same configured identifier. The lifecycle
blocks large match sets until the operator explicitly confirms them. It uses
`ERASURE_MAX_EVENTS` when valid and a built-in limit otherwise. Check matches
before confirming a large set.

## Modules

| Module | Responsibility |
| --- | --- |
| `erasure-subject-id.ts` | Normalize identifiers and derive workspace-scoped hashes |
| `erasure-finder.ts` | Find indexed events, deduplicate matches, and report coverage |
| `erasure-executor.ts` | Build the plan and, when enabled, delete matched data |
| `erasure-lifecycle.ts` | Check match limits and record request progress and failures |
| `erasure-actions.ts` | Authorize workspace-owner and super-admin requests |

The subject hash input is `normVersion`, workspace ID, kind, and normalized
value, separated by spaces. Ingest and dashboard implementations must produce
identical bytes. Email normalization trims and lowercases the value.

## Deletion behavior

ClickHouse mutations are bounded by receipt time and include replay-suffixed
event IDs and delivery rollups. Postgres deletes are chunked and scoped to the
workspace. R2 cleanup covers event payloads and the delivery-mirror and
queue-spill keys reconstructed from retained delivery attempts.

The index is deleted only after all required stores complete their deletes.
A partial failure keeps index entries for retry. The index itself has 30-day
retention so it does not outlive the payload window.

Some tables have no event-ID link, including `notifications`,
`dead_letter_mutes`, and ClickHouse `events_daily`. The plan discloses these
limits; it does not automatically delete those rows. Reconstructed R2 keys
also depend on delivery-attempt metadata still being retained.

## Deployment and verification

The small self-host profile disables indexed erasure. It needs the full
analytics, indexing, and cleanup path before this feature can be used.

Use synthetic subjects to verify matching, large-set confirmation, dry runs,
partial-store failures, and a complete deletion through the deployed stores.
Tests with fake stores do not prove a live ClickHouse, R2, and Postgres deletion.
Store verification records and deployment settings privately.

Historical index backfill and at-rest protection of hashed locators require
separate operational review. Enabling the executor does not fill gaps in the
subject index.
