# Load testing — ingest edge

`ingest-load.js` is a [k6](https://k6.io) harness that drives a target arrival
rate against the public ingest endpoint and asserts the edge stays fast and
near-zero-error under sustained load. It exists to put a number on the
"millions of webhooks per hour" claim, which the function audit flagged as
unbenchmarked.

**1M/hour ≈ 278 accepted requests/second.** The default target is 300 rps
(~1.08M/hr).

> This directory is intentionally excluded from the build/test/lint pipeline —
> the script runs in the k6 runtime, not Node.

## Prerequisites

- Install k6: `brew install k6` (macOS) or see https://k6.io/docs/get-started/installation/
- A source to receive the traffic. **Use a dedicated load-test source on
  staging**, not a production source — every accepted request is a real event
  that routes, delivers, and (unless the source is `transient_mode`) counts
  toward usage. Mark the source `transient_mode` so payloads aren't retained.

## Run

```sh
k6 run \
  -e INGEST_URL=https://ingest.<your-domain>/in/<source_id> \
  -e SOURCE_TOKEN=<source_token> \
  -e RATE=300 \
  -e DURATION=2m \
  scripts/load/ingest-load.js
```

Tunables (all via `-e KEY=value`):

| Var | Default | Meaning |
| --- | --- | --- |
| `INGEST_URL` | _(required)_ | Full ingest URL incl. the source path |
| `SOURCE_TOKEN` | `""` | Source secret token |
| `AUTH_MODE` | `bearer` | How the token is sent: `bearer` header, `query` (`?token=`), or `none` |
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

- **p95/p99 latency** — ingest is just a signature check + R2 write + queue
  enqueue, so it should stay well under the thresholds. Rising latency at higher
  `RATE` points at R2/queue or the source-cache lookup.
- **202 rate** — non-202s under load usually mean rate-limit/backpressure (429)
  or queue-overload 503s. That's the ingest shedding; note the `RATE` at which it
  starts.
- This only exercises **ingest**. Watch the deliver path separately (queue depth,
  the new queue-lag alerts, delivery instance count) to confirm end-to-end
  throughput keeps up rather than just acceptance.

## Next

A companion end-to-end harness (ingest → route → deliver to a sink, measuring
delivery lag at the far end) would close the loop on the full pipeline SLO.
