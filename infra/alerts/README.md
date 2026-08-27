# Alerts

Axel emits operational alerts via a generic webhook. This directory documents
which alert rules exist, what their thresholds are, and how to wire a receiver.

## Status (read this first)

What is live today:

- **Sentry exception reporting** — wired in every deployed service (see "Sentry
  exception reporting" below).
- **Delivery Queue lag** — the delivery service reads Cloudflare's realtime
  backlog count and oldest-message timestamp every minute without leasing a
  message, with pulled-message timestamps as a second signal. Warn/critical
  events go to Sentry. The generic webhook is an optional second sink.
- **Production delivery canary** — the pinned-candidate GitHub workflow proves
  ingest-to-destination delivery every 15 minutes and reports missed, failed,
  and recovered runs through Sentry Cron Monitoring.

The other aggregate threshold evaluators in `apps/router/src/alerts.ts`
(`retry_rate`, `dead_letter_count`, `engine_error_rate`, and
`destination_p95_latency`) remain implemented and unit-tested but do not yet
have deployed window producers. Do not claim those four numeric thresholds as
live alerts. Individual service exceptions, the end-to-end canary, Queue lag,
and operator six-hour snapshots are the current production signals.

No external Slack, PagerDuty, OpsGenie, or generic receiver is part of the
verified production baseline yet. Severity is included in each event, but Axel
does not route `warn` and `critical` events to different destinations. Treat
the receiver recipes below as optional operator configuration until a synthetic
alert proves authentication, payload compatibility, delivery, and paging.

## How it works

The delivery service combines its Sentry sink with the optional sink returned
by `alertSinkFromEnv()`:

- `ALERT_WEBHOOK_URL` — optional receiver URL. When unset, the sink is a no-op
  so the service never fails to start. Setting it sends every severity to the
  same URL; receiver compatibility and downstream routing must be tested.
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

Non-success webhook responses are treated as failed delivery and logged by
status code without reading the receiver body. Alert transport failures remain
non-fatal to the delivery path.

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

### Slack (optional, not production-verified)

1. Create an incoming webhook in your Slack workspace, capture the URL.
2. Set `ALERT_WEBHOOK_URL=https://hooks.slack.com/services/...` on each service.
3. Send synthetic `warn` and `critical` events and verify both arrive. The
   built-in sink does not route them to different channels.

### PagerDuty (optional, not production-verified)

PagerDuty's API v2 expects `routing_key` and an `event_action`. Wrap our
webhook with a tiny relay (e.g. a Cloudflare Worker) that translates our
`event.severity` to PagerDuty `severity`. Test the relay with a synthetic
critical event and confirm an on-call notification before relying on it.

### Sentry webhook receiver (optional, not production-verified)

This is separate from the verified Sentry SDK exception and Queue-lag sink.
Any generic-webhook integration must be configured and tested against the
expected `severity` field before it is treated as an alert route.

### Generic OpsGenie (optional, not production-verified)

Use a relay that authenticates to OpsGenie and maps the Axel payload to the
receiver's current schema. Verify a synthetic critical event reaches the
intended team and escalation policy.

## Testing

```sh
pnpm --filter @axel/router test test/alerts.test.ts
pnpm --filter @axel/observability test
```

The router test suite covers the threshold evaluators end-to-end with a
mocked `fetch` for the webhook sink. The observability tests verify Sentry
envelope formatting and failure swallowing. These tests do not prove external
receiver authentication, payload compatibility, severity routing, or paging.
Operators must test those paths end-to-end before counting them as production
controls.

## Operational notes

- **Alerts must never page the service itself.** The webhook sink swallows
  fetch errors; a noisy alert receiver cannot take down the router.
- **Severity is payload data, not a route.** The built-in sink sends `info`,
  `warn`, and `critical` events to the same optional URL. A tested receiver or
  relay must decide which events notify a channel or page on-call.
- **De-duplication is the receiver's job.** Axel re-emits an alert every
  evaluation tick if the threshold remains breached. Set Slack-side or
  PagerDuty-side suppression to avoid notification storms.
- **There is no default external route.** Slack channels, PagerDuty escalation,
  and other receiver behavior remain optional and unproven until synthetic
  tests confirm them. Sentry exception issues retain `service` and
  `environment` tags for project-side rules.
