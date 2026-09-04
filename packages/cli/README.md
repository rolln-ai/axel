# Axel CLI

Talk to your Axel webhook pipeline from the terminal. Mint a Personal
Access Token from the dashboard → Settings → Personal access tokens, then
sign in.

The npm package is not published yet. Build and install it from a source
checkout:

```sh
pnpm --filter @axel/cli build
npm install -g ./packages/cli
axel auth login
```

## Commands

| Command                                                   | What it does                                                                                              |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `axel auth login`                                         | Paste a PAT (or pass `--token`), validates via `/v1/cli/me`, writes `~/.axel/config.json`.               |
| `axel auth status`                                        | Re-validates the saved PAT and prints workspace + token info.                                            |
| `axel auth logout`                                        | Deletes `~/.axel/config.json`.                                                                            |
| `axel trigger <provider> <event_type> --source <id>`      | Sends a canned (or `--payload`-overridden) event through the source's ingest path.                       |
| `axel send <provider> <event_type> --to <url>`            | Offline smoke test: POSTs a canned payload straight to `<url>`. Bypasses Axel — no signin/source/PAT.    |
| `axel listen --source <id> --forward-to <url>`            | Polls for new events on the source (~1s) and forwards each to your local handler.                        |
| `axel replay <event_id> --forward-to <url>`               | Pulls the raw bytes Axel stored for `event_id` and POSTs them to your local handler.                     |

`trigger`, `listen`, and `send` strip stale provider signature headers
(e.g. `Stripe-Signature`) by default so your local handler doesn't 401 a
replayed event — pass `--keep-signature` to forward them as-is.

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

# No source set up yet? Smoke-test a handler with a canned payload, offline.
axel send stripe charge.succeeded --to http://localhost:3000/webhooks
```

`axel trigger` uses the saved workspace PAT through the control-plane API. It
does not accept a source token or build a credential-bearing ingest URL. A
custom producer that calls ingest directly must send its one-time source token
in the `x-axel-token` request header.

## Notes

`axel listen` polls `/v1/cli/events` once a second rather than holding a
socket open. At ~1s lag it's indistinguishable from "live" for a terminal
dev loop, and it avoids the ingest-worker → delivery-service WebSocket
fanout the original AXE-26 spec called for. A `--ws` mode can layer on
later as `axel listen --ws` without breaking this path.
