# Data flow alerts

Axel checks active sources and destination deliveries every 15 minutes through
`/api/cron/notification-scan`. Both hosted and self-hosted schedulers use this path.
Configure ClickHouse, Postgres and Resend for monitoring and email delivery.
The Inbox shows when a check is unavailable or stale; an unavailable check never
resolves an incident. The cron also reports failure to its Sentry monitor.

Automatic monitoring waits for a source's first week of accepted traffic. During
this learning window it raises no "stopped receiving data" alert, and Source
Settings shows the earliest date the window can end. An explicit maximum
expected gap in Source Settings alerts from the first check and skips the
window, including time to first event.

After the window, the monitor allows the longest completed quiet period in the
source's retained 30-day receipt history plus 25% grace. One long quiet period
is enough: a source that has already gone silent for two days is expected to do
so again, so an alert lands a little after the longest gap the source has
survived. Retained history keeps the first and last receipt in each occupied
15-minute bucket, so busy bursts cannot push normal nights or weekends out of
it. The current unfinished gap never trains the baseline. An outage during the
learning window sets a wide default; tighten it with an explicit gap.

Two other measures can raise the window, never lower it. Recent cadence is
three times the 95th-percentile gap in the latest 2,000 accepted events, with
a 30-minute minimum. Recurring quiet periods are compared around the last
receipt's UTC clock time, allowing 30 minutes of schedule jitter. Weekdays are
compared with weekdays, weekends with weekends, and gaps over 24 hours require
matching weekdays from prior weeks. At least three independent quiet periods
on different dates must support a recurring allowance, which takes the
third-longest comparable allowance plus 25% grace. Every automatic window is
capped at seven days. Alert emails say which measure set the window.

An open incident keeps its original window and requires new accepted traffic
before recovery. An incident opened before a learning window applied recovers
once the source accepts traffic again.

Automatic monitoring needs 20 accepted events. Test events do not establish
traffic health. History describes receipt patterns; it cannot prove that a
sender had nothing to send.

Recent unresolved dead letters, destination pauses and retries older than 30 minutes
open delivery incidents. First detection looks for failures from the last seven days
so deployment does not re-email months of historical failures. Once open, an incident
continues to track all unresolved failures for that route and destination.

Unconditional declarative routes also check for accepted
events with no delivery attempt in the last seven days. Attempt records are
written on a best-effort basis, so an event whose delivery claim settled as
completed in Postgres is not counted; a lost analytics row is not a missing
delivery. Filtered or transformed routes use actual failures and retries,
because a missing delivery may be an intentional filter result. This monitor
is not proof of complete historical delivery.

Incident email is on by default for workspace members. One opening notice is
followed by reminders at most once every 24 hours. Owners and admins can acknowledge
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
