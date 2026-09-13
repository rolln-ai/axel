# Cloud adoption report

Administrators can open **Cloud adoption** to see new workspaces from the last
28 days, grouped by the signup link used: GitHub, Website, or Unknown / direct.
Administrator MFA is required.

The report counts workspaces that received an event in their first seven days,
then those that successfully delivered at least one event in that period.
Second-week usage means another event arrived between days 7 and 14. Its
denominator includes only workspaces at least 14 days old that received and
delivered in week 1. Recent signups still have time to activate.

Test traffic, deleted workspaces, and billing-exempt internal workspaces are
excluded. Missing ClickHouse access shows **Unavailable**, not zero. The report
is limited to the most recent 1,000 matching workspaces and says when it reaches
that limit. Its 28-day window fits inside the analytics log's 30-day retention.

Repository signup links use `?ref=github`; marketing links use `?ref=website`.
Signup validates this fixed label and stores it in the existing
`workspace.created` audit entry. Invites do not create another workspace or
signup attribution. No free-text referral URL, new cookie, or tracking SDK is
stored. The label is a useful comparison, not proof of where someone came from:
links can be copied, edited, or shared, and older accounts remain unknown.
