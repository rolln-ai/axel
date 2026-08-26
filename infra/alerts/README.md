# Alerts

Axel emits operational alerts via a generic webhook. This directory documents
which alert rules exist, what their thresholds are, and how to wire a receiver.

## Status (read this first)

What is live today:

- **Sentry exception reporting** — wired in every deployed service (see "Sentry
  exception reporting" below). This is the alerting you actually get right now.
- **The `AlertSink` client + threshold evaluators** in `apps/router/src/alerts.ts`
  are implemented and unit-tested, but **no deployed service currently feeds the
  evaluators a live metrics snapshot**, and `alertSinkFromEnv()` returns a no-op
  sink unless `ALERT_WEBHOOK_URL` is set. So the threshold rules below
  (`retry_rate`, `queue_lag`, `destination_p95_latency`, …) **do not fire in
  production yet.** Treat the rest of this doc as the design for that wiring, not
  a description of running behaviour. Wiring a deployed snapshot producer to
  `alertSinkFromEnv()` is tracked separately.

## How it works

Each long-running Axel service constructs an `AlertSink` from the environment
via `alertSinkFromEnv()`:

- `ALERT_WEBHOOK_URL` — receiver URL (Slack incoming webhook, PagerDuty Events
  API v2, OpsGenie inbound, Sentry webhook, generic Cloudflare Worker, …).
  When unset, the sink is a no-op so the service never fails to start.
- `ALERT_WEBHOOK_TOKEN` — optional shared secret added as `x-axel-alert-token`
  on every POST.

The receiver gets a JSON body of the shape:

```json
{
  "text": "[CRITICAL] router/queue_lag: Oldest unacked message is 600s old (backlog 12000)",
  "event": {
    "severity": "critical",
    "rule": "queue_lag",
    "summary": "Oldest unacked message is 600s old (backlog 12000)",
    "source": "router",
    "details": { "oldest_unacked_age_seconds": 600, "backlog": 12000, "threshold": 300 },
    "occurred_at": "2026-05-15T10:00:00Z"
  }
}
```

The top-level `text` field is Slack-friendly; the structured `event` body is
useful for dashboards / Sentry / PagerDuty-style consumers.

## Rules and default thresholds

See `apps/router/src/alerts.ts` (`DEFAULT_THRESHOLDS`) for the source of truth.
This file is the operator-facing summary.

| Rule | Severity | Default threshold | What's measured |
| --- | --- | --- | --- |
| `retry_rate` | warn | retry rate ≥ 10% over a window | `retries / attempts` from delivery_attempts |
| `retry_rate` | critical | retry rate ≥ 25% over a window | same |
| `dead_letter_count` | warn | ≥ 50 dead letters in the window | count of attempts where status='dead' |
| `dead_letter_count` | critical | ≥ 200 dead letters in the window | same |
| `queue_lag` | warn | oldest unacked age ≥ 60s | from Cloudflare Queues stats |
| `queue_lag` | critical | oldest unacked age ≥ 300s | same |
| `engine_error_rate` | warn | ≥ 5% of route evaluations error | `errors / evaluations` from route_evaluations |
| `engine_error_rate` | critical | ≥ 20% of route evaluations error | same |
| `destination_p95_latency` | warn | destination p95 latency ≥ 2000ms | p95 latency from delivery attempts |
| `destination_p95_latency` | critical | destination p95 latency ≥ 5000ms | same |
| `cleanup_pass_partial_failure` | critical | runCleanupPass threw | router emits this from the periodic cleanup loop |
| `replay_failed` | warn | replay request transitioned to `failed` | router replay processor |
| `periodic_job_failure` | warn | any periodic runner job threw | wraps `processReplayBatch` and `runCleanupPass` failures from `startPeriodicRunner` |

## Wiring receivers

### Sentry exception reporting

Dashboard and service exceptions are reported through `@axel/observability`.
Set these environment variables everywhere code runs:

- `SENTRY_DSN` — project DSN. When unset, reporting is disabled and startup
  still succeeds.
- `SENTRY_ENVIRONMENT` — `production`, `preview`, or `development`.
- `SENTRY_RELEASE` — deploy SHA or release name. Render and Vercel commit envs
  are used as fallback release values.

Current coverage:

- `dashboard` installs Node unhandled exception/rejection handlers through
  `apps/dashboard/instrumentation.ts`.
- `delivery-service` and `pull-worker` install Node process handlers and
  capture caught loop/request failures.
- `ingest-worker`, `router-edge`, and `delivery-edge` capture caught Worker
  fetch/queue failures with `ctx.waitUntil`.

To trigger a non-customer smoke event for Sentry, set `OPS_TEST_TOKEN` on the
dashboard deployment and run:

```sh
curl -fsS -X POST \
  -H "x-axel-ops-token: $OPS_TEST_TOKEN" \
  https://app.axelapp.ai/api/ops/sentry-test
```

The route returns 404 when `OPS_TEST_TOKEN` is unset or wrong.

### Slack

1. Create an incoming webhook in your Slack workspace, capture the URL.
2. Set `ALERT_WEBHOOK_URL=https://hooks.slack.com/services/...` on each service.
3. Done — Slack reads the top-level `text` field directly.

### PagerDuty (Events API v2)

PagerDuty's API v2 expects `routing_key` and an `event_action`. Wrap our
webhook with a tiny relay (e.g. a Cloudflare Worker) that translates our
`event.severity` to PagerDuty `severity`. A 30-line worker is enough.

### Sentry

Sentry webhooks accept arbitrary JSON; configure the integration to fire
internal alerts based on the `severity` field.

### Generic OpsGenie

Set `ALERT_WEBHOOK_URL` to the OpsGenie API endpoint plus an `apikey` query
param; OpsGenie reads the `text` field for the alert message and stores the
structured `event` payload as alert details.

## Testing

```sh
pnpm --filter @axel/router test test/alerts.test.ts
pnpm --filter @axel/observability test
```

The router test suite covers the threshold evaluators end-to-end with a
mocked `fetch` for the webhook sink. The observability tests verify Sentry
envelope formatting and failure swallowing.

## Operational notes

- **Alerts must never page the service itself.** The webhook sink swallows
  fetch errors; a noisy alert receiver cannot take down the router.
- **Severities map to colour, not action.** `info` is for context, `warn`
  goes to a Slack channel, `critical` should page on-call.
- **De-duplication is the receiver's job.** Axel re-emits an alert every
  evaluation tick if the threshold remains breached. Set Slack-side or
  PagerDuty-side suppression to avoid notification storms.
- **Routing:** warning alerts go to the operations Slack channel; critical
  alerts page the on-call rotation through PagerDuty. Sentry exception issues
  route to the owning service project with `service` and `environment` tags.
