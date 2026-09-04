#!/usr/bin/env node

// This command is intentionally disabled. Re-reading historical raw webhook
// bodies to derive an indexed event type would copy attacker-controlled data
// outside the raw-payload retention boundary. The current ingest path only
// emits bounded metadata and must remain the sole writer for this field.
console.error(
  "[backfill-event-type] disabled: historical raw payloads must not be promoted into indexed metadata",
);
process.exitCode = 1;
