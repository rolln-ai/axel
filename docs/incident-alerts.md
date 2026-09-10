# Data flow alerts

Axel checks active sources and destination deliveries every 15 minutes through
`/api/cron/notification-scan`. Both hosted and self-hosted schedulers use this path.
Configure ClickHouse, Postgres and Resend for monitoring and email delivery.
The Inbox shows when a check is unavailable or stale; an unavailable check never
resolves an incident. The cron also reports failure to its Sentry monitor.

An established source alerts after three times its recent 95th-percentile event
gap, with a 30-minute minimum and seven-day maximum. Automatic monitoring needs
20 accepted events. Set a maximum expected gap in Source Settings for scheduled,
new or infrequent feeds. Test events do not establish traffic health.

Recent unresolved dead letters, destination pauses and retries older than 30 minutes
open delivery incidents. First detection looks for failures from the last seven days
so deployment does not re-email months of historical failures. Once open, an incident
continues to track all unresolved failures for that route and destination. Unconditional declarative routes also check for accepted
events with no delivery attempt in the last seven days. Filtered or transformed
routes use actual failures and retries, because a missing delivery may be an
intentional filter result. This monitor is not proof of complete historical delivery.

Incident email is on by default for workspace members. One opening notice is
followed by reminders at most every six hours. Owners and admins can acknowledge
an incident in the Inbox to pause reminders for 24 hours. Recovery requires healthy
checks spanning at least 15 minutes and, for delivery incidents, a successful
delivery after the incident opened. A recovery notice does not claim backfill is
complete. Requests rejected before ingestion must be recovered from the sender.

Routine schema observations are an optional Monday email, off by default. The
retired daily-digest preference does not opt anyone into the weekly digest.
Schema observations do not assert destination compatibility or current traffic.
Existing transactional account and billing emails continue separately.

Incident transitions and per-recipient outbox entries commit together. Email is
recorded as sent only after the provider returns a message ID. Retries retain the
same payload and idempotency key and exclude recipients who already succeeded.
Removed members and changed email addresses cannot receive queued workspace mail.
Resend retains idempotency keys for 24 hours, so ambiguous attempts older than 23
hours enter `needs_review` rather than risk duplicate sends. They remain visible
in the Inbox and fail the cron heartbeat. Operators should check the provider
history by the outbox message ID or idempotency key before reconciling those rows.
Confirmed-send payloads are cleared immediately; resolved incident receipts remain
for 90 days. No webhook payloads or raw connector diagnostics enter alert emails.
