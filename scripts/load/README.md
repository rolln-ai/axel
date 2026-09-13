# Ingest load testing

`ingest-load.js` sends webhooks at a chosen rate with [k6](https://k6.io) and
checks acceptance rate and latency. It measures ingest only; measure destination
delivery separately before reporting end-to-end capacity.

One million events per hour is about 278 accepted requests per second. The
default target is 300 requests per second, or 1.08 million per hour.

This script runs in k6, so it is excluded from the Node build, test, and lint jobs.

## Prerequisites

- Install k6 with `brew install k6` on macOS or follow the
  [k6 installation guide](https://grafana.com/docs/k6/latest/set-up/install-k6/).
- Create a dedicated custom source on staging for the test. Every accepted request is a real event
  that routes, delivers, and (unless the source is `transient_mode`) counts
  toward usage. Mark the source `transient_mode` so payloads aren't retained.
  The script sends its token only in the `x-axel-token` request header.

## Run

Set `SOURCE_TOKEN` in your shell from your secret manager. k6 reads it from the
environment, so you do not need to put it in command arguments.

```sh
k6 run \
  -e INGEST_URL=https://ingest.<your-domain>/in/<source_id> \
  -e RATE=300 \
  -e DURATION=2m \
  scripts/load/ingest-load.js
```

Configuration, supplied through environment variables or k6's `-e KEY=value`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `INGEST_URL` | Required | Full ingest URL including the source path |
| `SOURCE_TOKEN` | Required | One-time token for the dedicated custom source, sent as `x-axel-token` |
| `RATE` | `300` | Target accepted requests/second |
| `DURATION` | `2m` | Hold time at the target rate |

The scenario warms up to `RATE/2`, ramps to `RATE`, holds for `DURATION`, then
ramps down.

## Pass/fail thresholds

The run fails (non-zero exit) if any threshold is breached:

- `http_req_failed` rate ≥ 1% (transport errors)
- `http_req_duration` p95 ≥ 500ms or p99 ≥ 1500ms
- any non-`202` response (`rejected_non_202` ≥ 1)

## Interpreting results

If latency rises with `RATE`, check source lookup, R2 writes, and Queue sends.
Record the rate at which non-202 responses begin, and inspect their response
codes before attributing them to capacity. A 429 indicates rate limiting; a
503 can also indicate an unavailable dependency.

Watch delivery queue depth, queue-lag alerts, and destination completion rates
to check whether delivery keeps up with acceptance.

## Delivery measurements

Measure latency at a test destination to assess the full pipeline. An ingest
load test alone cannot establish a delivery service-level objective.
