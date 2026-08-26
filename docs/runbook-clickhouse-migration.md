# Runbook — Move ClickHouse from Cloud to self-hosted on Render

Date drafted: 2026-05-26
Owner: CTO
Estimated duration: 60–90 minutes wall clock, ~15 minutes of customer-visible analytics-write blip during the env-var swap. Reads tolerate a longer outage because of cached server-component responses.

Trigger: the internal cost model’s "ClickHouse migration: Cloud → self-hosted on Render" section.

This runbook assumes the repo already contains the supporting code: `render.yaml` has the `axel-clickhouse` service, both ClickHouse workflows exist in `.github/workflows/`, and the schema apply / backup scripts live in `scripts/`. If you don't see those, this runbook is the wrong copy.

---

## 0. Pre-flight

Open in separate tabs:
- Render dashboard for the axel org
- Cloudflare dashboard → R2
- ClickHouse Cloud console (the one billing $125/mo)
- GitHub → repo Settings → Secrets and variables → Actions
- Vercel dashboard → axel-dashboard project → Settings → Environment Variables

Capture the current `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD` values from one of the existing services (Render axel-delivery-native → Environment) into a scratchpad. You'll need them only if rollback becomes necessary.

A 64-hex password was generated on 2026-05-26 and saved locally at `~/.axel-secrets/clickhouse-password` (perms 0600, directory 0700). Read it with:

```sh
cat ~/.axel-secrets/clickhouse-password
# Use this value wherever the runbook says NEW_CH_PASSWORD or $NEW_PW.
```

Once the cutover is done and the password is in 1Password (Engineering / Axel infra → `clickhouse.default`), delete the local copy:

```sh
shred -u ~/.axel-secrets/clickhouse-password 2>/dev/null || rm -P ~/.axel-secrets/clickhouse-password
```

If you need to regenerate (e.g. file deleted before cutover): `openssl rand -hex 32`. The user stays `default`.

---

## 1. Provision the Render service

1. Render dashboard → New → Blueprint.
2. Pick the existing `axel-render` blueprint repo if it auto-detected. Otherwise: Manual → use the existing repo + branch `main`. Render will read `render.yaml` and propose creating the new `axel-clickhouse` service alongside the existing ones (no changes to existing services).
3. When prompted for env vars on `axel-clickhouse`, set:
   - `CLICKHOUSE_USER` = `default`
   - `CLICKHOUSE_PASSWORD` = `<NEW_CH_PASSWORD>` from step 0
4. Leave `autoDeploy: false` as set in `render.yaml`. Future schema changes are deployed via the migration workflow, not by redeploying the container.
5. Confirm. First boot takes ~2 minutes (image pull + persistent-disk attach + ClickHouse self-init).
6. Wait for the service to go green. Note the public URL — usually `https://axel-clickhouse.onrender.com`.

### Smoke-test the new instance

```sh
NEW_URL="https://axel-clickhouse.onrender.com"
NEW_PW="<NEW_CH_PASSWORD>"

curl -fsS "$NEW_URL/ping"
# Expect: Ok.

curl -fsS "$NEW_URL/" \
  -H "X-ClickHouse-User: default" \
  -H "X-ClickHouse-Key: $NEW_PW" \
  --data-binary "SELECT version()"
# Expect: 24.8.x.x
```

If `/ping` returns Ok. but the authenticated SELECT 401s, the image's init script didn't seed the password — most common cause is the persistent disk being pre-populated from a previous boot attempt without the password env var. Tear down + recreate the disk (Render dashboard → Disks → axel-clickhouse → Delete; then redeploy the service).

---

## 2. Set GitHub Actions secrets

Repo Settings → Secrets and variables → Actions → New repository secret. The migration + backup workflows read these from the `Production` environment.

| Secret | Value |
|---|---|
| `CLICKHOUSE_URL` | the new `$NEW_URL` from step 1 |
| `CLICKHOUSE_USER` | `default` |
| `CLICKHOUSE_PASSWORD` | the new `$NEW_PW` |

(If `CLICKHOUSE_URL` already exists pointing at ClickHouse Cloud, overwrite it — the migration workflow needs to point at the *new* instance to apply schema to it.)

---

## 3. Apply the schema

GitHub → Actions → "Migrate ClickHouse" → Run workflow:
- target: production
- confirm: `apply-schema`

Watch the run. Each `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN IF NOT EXISTS` / `CREATE MATERIALIZED VIEW IF NOT EXISTS` should succeed. The `INSERT INTO ... WHERE NOT EXISTS` seed statements will no-op (the destination tables are empty so the guard short-circuits — that's the intended behavior on a fresh instance).

Verify from the smoke-test endpoint:

```sh
curl -fsS "$NEW_URL/" \
  -H "X-ClickHouse-User: default" -H "X-ClickHouse-Key: $NEW_PW" \
  --data-binary "SHOW TABLES"
# Expect:
#   delivery_attempts
#   delivery_base_latest_outcomes
#   delivery_base_latest_outcomes_mv
#   delivery_latest_outcomes
#   delivery_latest_outcomes_mv
#   events
#   events_daily
#   events_daily_mv
#   route_evaluations
```

---

## 4. Stand up the R2 backup target

1. Cloudflare dashboard → R2 → Create bucket → name `axel-clickhouse-backups`, same account as the existing webhook-payloads bucket.
2. Bucket → Settings → Object lifecycle rules → Add rule:
   - Name: `expire-clickhouse-backups`
   - Prefix: `clickhouse-backups/`
   - Action: Delete objects 7 days after creation
3. Cloudflare → R2 → Manage R2 API tokens → Create API token:
   - Name: `axel-clickhouse-backup`
   - Permission: Object Read & Write
   - Specify bucket: `axel-clickhouse-backups`
   - TTL: forever
4. Save the Access Key ID + Secret Access Key + jurisdiction-specific S3 endpoint shown.

Add to GitHub Actions secrets:

| Secret | Value |
|---|---|
| `CLICKHOUSE_BACKUP_S3_ENDPOINT` | endpoint from step 4, e.g. `https://<account-id>.r2.cloudflarestorage.com` |
| `CLICKHOUSE_BACKUP_S3_BUCKET` | `axel-clickhouse-backups` |
| `CLICKHOUSE_BACKUP_S3_ACCESS_KEY` | access key from step 4 |
| `CLICKHOUSE_BACKUP_S3_SECRET_KEY` | secret key from step 4 |

Trigger the backup workflow manually to validate: Actions → "Backup ClickHouse to R2" → Run workflow. Expect a short run that creates `clickhouse-backups/<timestamp>/` in the bucket. (The tables are empty, so the backup is tiny — that's fine; the goal is to confirm credentials and connectivity.)

---

## 4.5 Restore from R2

Backups are full daily snapshots written by `scripts/clickhouse-backup.sh` to
`s3://$CLICKHOUSE_BACKUP_S3_BUCKET/clickhouse-backups/YYYY-MM-DD-HHMMSS/` and
retained 7 days by the R2 lifecycle rule (section 4). Restore is manual.

**Prereqs**: a running ClickHouse service (prod `axel-clickhouse`, or a throwaway
second Render service for a drill) with the schema already applied — run the
"Migrate ClickHouse" workflow (section 3) FIRST so the tables and materialized
views exist, because the backup intentionally omits the 3 MVs (they are
triggers, recomputed from schema; see the `scripts/clickhouse-backup.sh` header).

1. List available snapshots in R2 and pick a timestamp prefix (Cloudflare
   dashboard → R2 → `axel-clickhouse-backups` → `clickhouse-backups/`).

2. Set env (same secret values as the backup workflow — the 4
   `CLICKHOUSE_BACKUP_S3_*` secrets + `CLICKHOUSE_PASSWORD`):

   ```sh
   URL="https://axel-clickhouse.onrender.com"   # or the drill service URL
   PW="<CLICKHOUSE_PASSWORD>"
   EP="<CLICKHOUSE_BACKUP_S3_ENDPOINT>"          # https://<acct>.r2.cloudflarestorage.com
   BK="<CLICKHOUSE_BACKUP_S3_BUCKET>"            # axel-clickhouse-backups
   AK="<CLICKHOUSE_BACKUP_S3_ACCESS_KEY>"
   SK="<CLICKHOUSE_BACKUP_S3_SECRET_KEY>"
   TS="2026-06-25-030000"                        # the snapshot chosen in step 1
   ```

3. Restore all six tables (matches `scripts/clickhouse-backup.sh`). Blocking
   (`async = 0`):

   ```sh
   curl -fsS "$URL/" -H "X-ClickHouse-User: default" -H "X-ClickHouse-Key: $PW" \
     --data-binary "RESTORE TABLE events, TABLE route_evaluations, TABLE delivery_attempts, TABLE events_daily, TABLE delivery_latest_outcomes, TABLE delivery_base_latest_outcomes FROM S3('$EP/$BK/clickhouse-backups/$TS', '$AK', '$SK') SETTINGS async = 0"
   ```

   If the tables already exist with data, restore into a FRESH service, or add
   `, allow_non_empty_tables = 1` to the `SETTINGS` clause and accept the merge
   semantics. (That flag is UNVERIFIED until the restore drill — section 9
   follow-ups — is run; validate before trusting it in an incident.)

4. Verify row counts land:

   ```sh
   curl -fsS "$URL/" -H "X-ClickHouse-User: default" -H "X-ClickHouse-Key: $PW" \
     --data-binary "SELECT 'events', count() FROM events UNION ALL SELECT 'delivery_attempts', count() FROM delivery_attempts FORMAT Pretty"
   ```

**RPO/RTO**: snapshots are daily and kept 7 days, so worst-case data loss is
~24h and the restore window is 7 days — shorter than the 30-day data TTL. A
restore older than 7 days is NOT possible from backups; widen the R2 lifecycle
rule (section 4) if a longer window is required. This 7-day horizon is the
current launch SLO.

---

## 5. Cut over the writers and readers

This is the customer-visible window. Order matters: writers first (so new events go to the new instance), then readers (so the dashboard stops querying the dead Cloud instance).

> Each rotation can be done independently; the dashboard's analytics queries already swallow ClickHouse errors and degrade to empty state per `apps/dashboard/lib/usage.ts:108-119`. So a few minutes of mismatch between writers and readers shows as missing chart data, not as a 500.

### 5a. Vercel — axel-dashboard

Project → Settings → Environment Variables. Update `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD` to the new values across **Production, Preview, Development**. Trigger a redeploy from the Deployments tab so the new values take effect.

### 5b. Render — axel-delivery-native + axel-pull-worker

For each service: Environment → update the three `CLICKHOUSE_*` keys → save. Render auto-rolls the service on env-var change.

### 5c. Cloudflare Workers — ingest-worker + delivery-edge

Run the existing sync workflow: GitHub → Actions → "Sync Cloudflare Runtime Secrets" → Run workflow → service: `all`. This uses the GitHub Actions `CLICKHOUSE_URL` / `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` secrets you set in step 2, so updating them there is what propagates to the workers.

Confirm propagation:

```sh
pnpm --dir apps/ingest-worker exec wrangler secret list --name axel-ingest
# Expect CLICKHOUSE_URL / CLICKHOUSE_USER / CLICKHOUSE_PASSWORD with recent updated_at
```

---

## 6. Verify end-to-end

```sh
# 6a. Send a test webhook to the live ingest worker.
curl -fsS -X POST "https://ingest.axelapp.ai/in/<a-known-source-id>" \
  -H 'content-type: application/json' \
  --data '{"runbook":"clickhouse-migration","ts":"'"$(date -u +%FT%TZ)"'"}'
# Expect: 202

# 6b. Within ~5 seconds, the row should land in the new ClickHouse.
curl -fsS "$NEW_URL/" \
  -H "X-ClickHouse-User: default" -H "X-ClickHouse-Key: $NEW_PW" \
  --data-binary "SELECT event_id, source_id, received_at FROM events ORDER BY received_at DESC LIMIT 5 FORMAT Pretty"

# 6c. Hit the dashboard /usage page and confirm the test event shows up.
# (Cached for 60s — wait or force-refresh after the cache window.)
```

If 6b is empty after 60 seconds, the ingest worker is still using the old secrets. Re-run the sync workflow and check wrangler secret list timestamps.

---

## 7. Decommission ClickHouse Cloud

Only after step 6 has been green for **at least 24 hours**:

1. ClickHouse Cloud console → service → Stop. This halts compute billing but preserves the data and the option to restart for 7 days.
2. Wait one more business day.
3. ClickHouse Cloud console → service → Delete.
4. ClickHouse Cloud console → Organization → Billing → confirm next invoice estimate has dropped.
5. Clean up the saved old `CLICKHOUSE_URL` from your scratchpad — once the Cloud service is deleted, the URL is unrecoverable, so make sure step 8 (rollback) isn't in play before you do this.

---

## 8. Rollback

If anything in steps 5–6 goes badly within the first 24h:

1. Revert the three `CLICKHOUSE_*` env vars to the saved old values in Vercel, Render, and the GitHub Actions secrets.
2. Re-run "Sync Cloudflare Runtime Secrets" for `all` to push the old values back to the CF workers.
3. Force a redeploy on the Vercel project so cached server-component data doesn't keep pointing at the new (failing) instance.
4. Leave the Render `axel-clickhouse` service running until you've root-caused; deleting it during an incident drops the only place new events have been landing.

After 24h, the Cloud-side data has a 24h-fresh gap during the cutover; full rollback gets gappy. Past 72h, rollback effectively means re-cutting-over the other direction — at that point, **fix forward** instead.

---

## 9. Follow-ups (not blocking)

- **Custom domain**: point `clickhouse.axelapp.ai` at the Render service for a more stable URL that survives service renames. Use Render → axel-clickhouse → Settings → Custom Domains. Then update the `CLICKHOUSE_URL` everywhere one more time.
- **Per-workspace user**: the `default` user has the full DDL grant. Once the cutover is stable, create a `read_only` user for the dashboard and a `writer` user for the worker fleet. Keeps `default` for migrations only.
- **Backup-failure alerting (DONE — verify routing)**: the backup workflow already reports to Sentry as cron monitor `clickhouse-backup` (schedule `0 3 * * *`, max_runtime 30), auto-provisioned and checked-in by `scripts/sentry-cron-checkin.sh` (see the `clickhouse-backup.yml` "Sentry check-in" steps). A missed or failed nightly run alerts. Action: confirm the Sentry monitor's alert rule routes to the on-call channel.
- **Restore drill**: within the next 30 days, exercise the `RESTORE TABLE ... FROM S3(...)` steps in section 4.5 against a throwaway second Render service to validate the command + the 4 S3 credentials and capture a real RTO. A backup you've never restored isn't really a backup.
