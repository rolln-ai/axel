# Axel CLI

Send test events, forward incoming webhooks to a local handler, and replay
retained payloads from the terminal. Create a personal access token in the
dashboard under **Settings**, then **Personal access tokens**.

The npm package is not published yet. Build and install it from a source
checkout:

```sh
pnpm --filter @axel/cli build
npm install -g ./packages/cli
axel auth login
```

For a self-hosted installation, include the dashboard URL when signing in:

```sh
axel auth login --api-base https://axel.example.com
```

Without `--api-base`, the CLI connects to Axel Cloud. Use the interactive token
prompt to keep your PAT out of shell history.

## Commands

| Command                                                   | What it does                                                                                              |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `axel auth login`                                         | Validates a PAT entered at the prompt and saves it in `~/.axel/config.json`.               |
| `axel auth status`                                        | Checks the saved PAT and prints workspace and token information.                                            |
| `axel auth logout`                                        | Deletes `~/.axel/config.json`.                                                                            |
| `axel trigger <provider> <event_type> --source <id>`      | Sends a sample event through a source. Use `--payload` for your own JSON.                       |
| `axel send <provider> <event_type> --to <url>`            | Sends a sample payload directly to `<url>` without signing into Axel or creating a source.    |
| `axel listen --source <id> --forward-to <url>`            | Polls for new events on the source once a second and forwards each to your local handler.                        |
| `axel replay <event_id> --forward-to <url>`               | Pulls the raw bytes Axel stored for `event_id` and POSTs them to your local handler.                     |

`listen`, `replay`, and `send` strip supported provider signature headers such
as `Stripe-Signature` by default. `--keep-signature` preserves headers that are
still present; it cannot recover signatures removed at ingestion or make an
expired signature valid. `trigger` uses the authenticated test-event API.

Run `axel <command> --help` for command-specific options.

## Quickstart

```sh
# 1. Sign in (one-time).
axel auth login

# 2. Send a sample Stripe charge.succeeded into your source.
axel trigger stripe charge.succeeded --source src_01H...

# 3. Forward live inbound events to your localhost handler.
axel listen --source src_01H... --forward-to http://localhost:3000/webhooks

# 4. Re-run a real production event against your localhost handler.
axel replay evt_018... --forward-to http://localhost:3000/webhooks

# Send a sample payload directly to a local handler.
axel send stripe charge.succeeded --to http://localhost:3000/webhooks
```

`axel trigger` uses the saved workspace PAT through the control-plane API. It
does not accept a source token or build a credential-bearing ingest URL. A
custom producer that calls ingest directly must send its one-time source token
in the `x-axel-token` request header.

## Polling and local forwarding

`axel listen` polls `/v1/cli/events` once a second. Forwarding includes that
polling delay plus request time; it does not use a WebSocket.

`listen` and `replay` send requests directly from your machine to the forwarding
URL. They do not create a new Axel event or a dashboard delivery record. The
small self-host profile needs ClickHouse for the event lookups these commands use.
