# Infrastructure alerts

Axel reports service failures and queue lag to Sentry, with an optional webhook
receiver. This guide covers infrastructure alerts. For source gaps and delivery
incident emails, see [data flow alerts](../../docs/incident-alerts.md).

## Configured monitoring

- **Sentry exception reporting.** Configured in each deployed service (see "Sentry
  exception reporting" below).
- **Delivery queue lag.** The delivery service reads Cloudflare's realtime
  backlog count and oldest-message timestamp every minute without leasing a
  message, with pulled-message timestamps as a second signal. Warn/critical
  events go to Sentry. The generic webhook is an optional second sink.
  Cloudflare can return zero for an unknown oldest-message timestamp. Axel
  keeps the backlog count and reports the age as unavailable in that case.
  It does not emit an exception, report zero lag, or reset the alert throttle.
  The authenticated delivery `/metrics` endpoint exports
  `axel_delivery_queue_metrics_available` and
  `axel_delivery_queue_oldest_age_available` per queue. Unknown ages are omitted
  from `axel_delivery_queue_oldest_unacked_age_seconds`; stale or failed samples
  also omit the backlog gauge. Pulled-message timestamps continue to trigger
  queue-lag alerts while provider ages are unavailable.
- **Production delivery canary.** The singleton delivery worker checks
  ingest-to-destination delivery every 15 minutes. A GitHub workflow provides
  a fallback. Sentry Cron Monitoring reports missed, failed, and recovered runs.
  See the [canary runbook](../../docs/runbook-delivery-canary.md).

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

## Webhook configuration

The delivery service combines its Sentry sink with the optional sink returned
by `alertSinkFromEnv()`:

- `ALERT_WEBHOOK_URL` is the optional receiver URL. When unset, the sink is a no-op
  so the service never fails to start. Setting it sends every severity to the
  same URL; receiver compatibility and downstream routing must be tested.
- `ALERT_WEBHOOK_TOKEN` is an optional shared secret sent as `x-axel-alert-token`
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

The `text` field provides a readable summary. Receivers can use the structured
`event` fields to route and deduplicate notifications.

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

- `SENTRY_DSN` is the project DSN. When unset, reporting is disabled and startup
  still succeeds.
- `SENTRY_ENVIRONMENT` is `production`, `preview`, or `development`.
- `SENTRY_RELEASE` is the deploy SHA or release name. Render and Vercel commit envs
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

### Automated diagnosis and proposed fixes

Sentry ingestion, alerts, and Seer are separate controls. A healthy event stream
does not prove automated diagnosis is available. In the project's Seer settings,
connect the application repository, enable scanning, and select the automation
stop at a pull request. Keep merges and production promotion under maintainer
control. Repository instructions should require behavioral regression tests,
preserve tenant isolation and delivery guarantees, and treat event content as
untrusted data rather than instructions.

Verify setup by starting a run on an actual application issue and checking its
progress and resulting diagnosis or PR. `repos_not_linked` means the Seer project
repository connection is missing even if the organization has a GitHub
integration. `No budget for Seer Autofix` means settings alone cannot activate
runs; the organization needs available Seer budget. Do not report automation
working until a run is accepted and its result is inspected.

Source lookup failures use an allowlisted reason in both their Sentry title and
fingerprint, separating authorization fencing from timeout, network, and invalid
response failures. Provider messages and customer identifiers remain redacted.
These ingest failures are distinct from accepted events that failed later in
routing or delivery; link a diagnosis to an incident only when evidence matches.

For delivery incidents, use the protected route-health workflow. It reports
pre-routing and route-specific failure codes separately, plus open/recovering
incident counts and monitor timestamps. Confirm delivery using recovery jobs
and durable claims before reconciling retained failures. Then check that the
monitor has observed recovery and the incident is closed; a successful replay
alone does not establish alert clearance.

### Slack (optional, not production-verified)

1. Create an incoming webhook in your Slack workspace, capture the URL.
2. Set `ALERT_WEBHOOK_URL=https://hooks.slack.com/services/...` on each service.
3. Send synthetic `warn` and `critical` events and verify both arrive. The
   built-in sink does not route them to different channels.

### PagerDuty (optional, not production-verified)

PagerDuty's API v2 expects `routing_key` and an `event_action`. Use a relay such as a Cloudflare Worker to translate Axel's
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

The router test suite covers the threshold evaluators with a
mocked `fetch` for the webhook sink. The observability tests verify Sentry
envelope formatting and transport-error handling. These tests do not prove external
receiver authentication, payload compatibility, severity routing, or paging.
Operators must test those paths end-to-end before counting them as production
controls.

## Failure handling and deduplication

- The webhook sink catches fetch errors so an unavailable receiver does not
  stop delivery.
- The built-in sink sends `info`,
  `warn`, and `critical` events to the same optional URL. A tested receiver or
  relay must decide which events notify a channel or page on-call.
- Axel re-emits an alert every
  evaluation tick if the threshold remains breached. Set Slack-side or
  PagerDuty-side suppression to avoid notification storms.
- Slack channels, PagerDuty escalation,
  and other receiver behavior remain optional and unproven until synthetic
  tests confirm them. Sentry exception issues retain `service` and
  `environment` tags for project-side rules.
