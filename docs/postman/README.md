# Axel Webhook Tester (Postman)

Two files in this directory:

| File | Purpose |
|---|---|
| `axel-webhooks.postman_collection.json` | The collection — 21 requests across 5 folders |
| `axel-webhooks.postman_environment.json` | Environment with placeholders for `baseUrl`, `sourceId`, `sourceToken`, `adminToken` |

## Setup (90 seconds)

1. **Sign up.** Open <https://app.axelapp.ai/signup>, create your workspace.
2. **Create a source.** Go to <https://app.axelapp.ai/sources> → **Create source** → save the plaintext token shown ONCE (format: `axt_…`).
3. **Import both files into Postman.** File menu → Import → select both JSON files.
4. **Select the environment.** Top-right dropdown → "Axel — production".
5. **Edit the environment.** Click the eye icon next to the dropdown → set:
   - `sourceId` to your new `src_…` id (visible in the dashboard URL or the source row)
   - `sourceToken` to the plaintext token from step 2
6. **Hit Send on `Hello → 202`.** If you see `event_id` and `received_at` in the response, you're wired up.

## What's in each folder

### Hello
The minimum viable request. Use it first to verify your env is filled in correctly.

### Real-world payloads
Exact-shape examples that match what these services would actually POST:
- **Stripe** — `payment_intent.succeeded`, `customer.subscription.created` (with `stripe-signature` header)
- **GitHub** — `push`, `pull_request.opened` (with `x-github-event`, `x-github-delivery`)
- **Twilio** — `MessageStatusCallback` (form-urlencoded — Twilio doesn't use JSON)
- **Slack** — `message.channels` event API
- **Generic** — deeply-nested object

Useful for sanity-checking your routes + transforms against real shapes.

### Batch & throughput

**Important model note:** Axel ingests **one event per POST**. There's no native batch endpoint that splits an array into N events. Two patterns:

1. **One event with array body** (`Single event — array of 10 records`, `Single event — top-level array`)
   Each request sends one event whose body happens to be an array. The destination receives one document/row per webhook with the whole array inside. Right model when you control producer + consumer and want to amortize round-trip cost.

2. **N events via Postman Collection Runner** (`Run-runner sample`)
   Postman's Runner fires this request N times. Each iteration produces a unique event. Right model for stress testing, or when each record is conceptually its own event.

To run the Runner sample:
- Click the **▶** icon next to the collection → **Run collection**
- Select only `Run-runner sample — fire many distinct events`
- Set **Iterations** to whatever you want (100, 1000, …)
- Click **Run**
- Watch the count climb on <https://app.axelapp.ai/usage>

### Edge cases / errors
Each request intentionally violates the ingest contract and asserts the expected non-2xx response:

| Request | Status | Error |
|---|---|---|
| Missing token | 401 | `missing_token` |
| Wrong token | 401 | `invalid_token` |
| Unknown source | 404 | `unknown_source` |
| Wrong method (GET) | 405 | `method_not_allowed` |
| Body too large (1.1 MB) | 413 | `payload_too_large` |
| Body too deep (200-level nesting) | 413 | `payload_too_deep` |

If any of these stop returning the right code, something's broken on the worker.

### Admin
Operator-only endpoints. Set `adminToken` in the env first (same value as the worker's `ADMIN_TOKEN` secret). Two requests:

- **Invalidate source cache** — drops the cached entry at the edge. Useful right after rotating a token in the dashboard.
- **Push source to cache (manual)** — force-write a source into the edge cache without going through the dashboard. Note the `secret_token` field expects the SHA-256 hex of the plaintext token (`echo -n PLAINTEXT | sha256sum`).

### Replay & inspect
Not actual requests — pointers to dashboard pages where the events you POST land:

- <https://app.axelapp.ai/usage> — month-to-date count, top sources, daily volume
- <https://app.axelapp.ai/deliveries> — failed deliveries + replay button
- <https://app.axelapp.ai/sources> — per-source status, rate caps

## Tip: see deliveries instantly

If you want immediate visual feedback without setting up Postgres / Mongo / S3 destinations, create an HTTP destination pointing at <https://webhook.site> (free, gives you a public URL with a live request log) or <https://requestbin.com>. Every webhook you POST through Postman will appear there within ~1 second.

## Tests

Each request has assertions in the **Tests** tab. Successful POSTs all check:
  - response status === 202
  - `event_id` is a valid UUID v7
  - `received_at` is an ISO timestamp
  - environment variable `lastEventId` gets set for downstream use

Run **Run collection** with all requests selected and you should see green checks for every test.
