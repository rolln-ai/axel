# Axel webhook tester for Postman

Two files in this directory:

| File | Purpose |
| --- | --- |
| `axel-webhooks.postman_collection.json` | Ingest examples and negative tests grouped by purpose |
| `axel-webhooks.postman_environment.json` | Environment with placeholders for `baseUrl`, `sourceId`, and `sourceToken` |

This public collection contains no operator endpoints or infrastructure-wide
credentials. Use a disposable source that receives only synthetic data. Do not
reuse a production source, share or export a populated environment, or paste
real webhook bodies into a request.

## Setup (90 seconds)

1. **Sign up.** Open <https://app.axelapp.ai/signup> and create your workspace.
2. **Create a disposable custom source.** Go to <https://app.axelapp.ai/sources> →
   **Create source**, leave the inbound provider set to **Custom / other service**, and save the
   plaintext token shown once. The collection sends that value only in the
   `x-axel-token` request header.
3. **Import both files into Postman.** File menu → Import → select both JSON files.
4. **Select the environment.** Top-right dropdown → "Axel cloud, synthetic tests".
5. **Edit the environment.** Click the eye icon next to the dropdown → set:
   - `sourceId` to your disposable source ID
   - `sourceToken` to the plaintext token from step 2
6. **Hit Send on `Hello → 202`.** A response with `event_id` and `received_at` confirms the setup.

Keep the populated environment private. Rotate the disposable source token and
delete the local value when testing is finished.

Do not switch this synthetic collection to a named-provider source. Stripe,
GitHub, and Shopify require a valid provider signature. Chargebee requires its
configured webhook Basic Auth. Named-provider sources do not use an Axel source token.

## What's in each folder

### Hello

This is the smallest request in the collection. Use it first to check the
environment values.

### Real-world payloads

These synthetic payloads use field shapes from common webhook senders:

- **Stripe:** `payment_intent.succeeded`, `customer.subscription.created` with a fake `stripe-signature` header
- **GitHub:** `push`, `pull_request.opened` with fake event headers
- **Twilio:** a synthetic form-encoded `MessageStatusCallback`
- **Slack:** a synthetic `message.channels` event
- **Generic:** a deeply nested object

The values are synthetic. Use them to check route and transform shapes.

### Batch & throughput

Axel ingests one event per POST. It does not split an array into separate
events. The collection shows two patterns:

1. **One event with an array body.** The requests named `Single event, array of
   10 records` and `Single event, top-level array` each send one event. The
   destination receives the whole array in one delivery.

2. **Many events through Postman Collection Runner.** The `Run-runner sample`
   request sends a distinct synthetic event on each iteration.

To run the Runner sample:

- Click the **▶** icon next to the collection → **Run collection**
- Select only `Run-runner sample — fire many distinct events`
- Set **Iterations** to a small value that stays within your plan limits
- Click **Run**
- Watch the count climb on <https://app.axelapp.ai/usage>

### Edge cases / errors

Each request intentionally violates the ingest contract and asserts the expected non-2xx response:

| Request | Status | Error |
| --- | --- | --- |
| Missing token | 401 | `missing_token` |
| Wrong token | 401 | `invalid_token` |
| Unknown source | 404 | `unknown_source` |
| Wrong method (GET) | 405 | `method_not_allowed` |
| Body too large (1.1 MB) | 413 | `payload_too_large` |
| Body too deep (200-level nesting) | 413 | `payload_too_deep` |

If any of these stop returning the right code, something's broken on the worker.

### Replay & inspect

This folder has pointers to dashboard pages where the events you POST land:

- <https://app.axelapp.ai/usage> for month-to-date count, top sources, and daily volume
- <https://app.axelapp.ai/deliveries> for failed deliveries and replay
- <https://app.axelapp.ai/sources> for per-source status and rate caps

Do not point a route at a public request-bin service. Those services can retain
request bodies and headers. For HTTP delivery tests, use an endpoint you
operate and send synthetic payloads only.

## Tests

Each request has assertions in the **Tests** tab. The `Hello` request checks the
202 status, UUID-shaped `event_id`, and ISO `received_at` value. The other
success examples check the 202 status. Negative tests check their documented
error status and code.

Run **Run collection** with all requests selected. Every assertion should pass.
