import { authLogin, authLogout, authStatus } from "./commands/auth.js";
import { triggerCommand } from "./commands/trigger.js";
import { replayCommand } from "./commands/replay.js";
import { sendCommand } from "./commands/send.js";
import { listenCommand } from "./commands/listen.js";

/**
 * Top-level argv parser. Two-level command tree:
 *   axel auth (login|status|logout)
 *   axel trigger <provider> <event_type> --source <id> [...]
 *   axel send <provider> <event_type> --to <url> [...]
 *   axel listen --source <id> --forward-to <url> [...]
 *   axel replay <event_id> --forward-to <url> [...]
 *
 * Hand-rolled (no commander/yargs dependency) to keep the install footprint
 * small. The package is installed from source until its first npm release.
 */
export async function run(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case "-h":
    case "--help":
    case "help":
      printRootHelp();
      return;
    case "--version":
    case "-v":
      console.log("@axel/cli 0.1.1");
      return;
    case "auth": {
      const [sub, ...subRest] = rest;
      switch (sub) {
        case "login": return authLogin(parseFlags(subRest));
        case "status": return authStatus();
        case "logout": return authLogout();
        default:
          printAuthHelp();
          if (sub) process.exitCode = 64;
          return;
      }
    }
    case "trigger": {
      const [provider, eventType, ...flagArgs] = rest;
      if (!provider || !eventType) {
        printTriggerHelp();
        process.exitCode = 64;
        return;
      }
      return triggerCommand(provider, eventType, parseFlags(flagArgs));
    }
    case "replay": {
      const [eventId, ...flagArgs] = rest;
      if (!eventId) {
        printReplayHelp();
        process.exitCode = 64;
        return;
      }
      return replayCommand(eventId, parseFlags(flagArgs));
    }
    case "send": {
      const [provider, eventType, ...flagArgs] = rest;
      if (!provider || !eventType) {
        printSendHelp();
        process.exitCode = 64;
        return;
      }
      return sendCommand(provider, eventType, parseFlags(flagArgs));
    }
    case "listen": {
      return listenCommand(parseFlags(rest));
    }
    default:
      console.error(`unknown command "${command}". Run \`axel --help\` for usage.`);
      process.exitCode = 64;
  }
}

export function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[a.slice(2)] = next;
        i += 1;
      } else {
        out[a.slice(2)] = "true";
      }
    }
  }
  return out;
}

function printRootHelp(): void {
  console.log(`axel — Axel CLI

Usage:
  axel auth login [--token <pat>] [--api-base <url>]
  axel auth status
  axel auth logout
  axel trigger <provider> <event_type> --source <source_id> [--payload <json>]
  axel send    <provider> <event_type> --to <url> [--payload <json>]
  axel listen  --source <source_id> --forward-to <url> [--keep-signature]
  axel replay  <event_id> --forward-to <url> [--method POST]

Run \`axel <command> --help\` for command-specific help.

Mint a Personal Access Token from the dashboard → Settings → CLI tokens.`);
}

function printAuthHelp(): void {
  console.log(`axel auth login   — paste a PAT and save it to ~/.axel/config.json
axel auth status  — verify the saved PAT against /v1/cli/me
axel auth logout  — delete ~/.axel/config.json`);
}

function printTriggerHelp(): void {
  console.log(`axel trigger <provider> <event_type> --source <source_id> [--payload <json>]

Provider/event-type pairs (subset of the dashboard sample inventory):
  stripe charge.succeeded     stripe charge.failed
  github push                 github pull_request
  shopify orders/create

Pass --payload '{"json":"…"}' to override the canned body.`);
}

function printReplayHelp(): void {
  console.log(`axel replay <event_id> --forward-to <url> [--method POST]

Pulls the raw payload Axel received for <event_id> from R2 and POSTs
it to <url>. Useful for re-debugging a failing event against a
locally-running handler.`);
}

function printSendHelp(): void {
  console.log(`axel send <provider> <event_type> --to <url> [--payload <json>]

Offline smoke test: POSTs the canned sample payload directly to <url>.
Bypasses Axel entirely — no signin, no source, no PAT required. Useful
for "is my Stripe handler returning 200?" loops without configuring a
real source/route. Drop-in curl replacement.`);
}
