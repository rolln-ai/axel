# Super-admin MFA operations

Axel encrypts super-admin TOTP seeds with `CREDENTIALS_MASTER_KEY`. Apply the
super-admin MFA migration before deploying dashboard code that reads the new
tables or columns. The reviewed Vercel deployment workflow runs pending
Postgres migrations before it asks Vercel to build the dashboard.

After the deployment, an existing super-admin must confirm their password and
complete TOTP enrollment within 10 minutes in the same browser session before
returning to privileged pages. Pending seeds are not disclosed to other
sessions. Privileged access then requires a fresh TOTP verification every 15
minutes.

Treat the master key as recovery-critical. Losing it makes destination
credentials and enrolled TOTP seeds unreadable. A suspected exposure requires
rotating destination credentials and forcing new super-admin MFA enrollment as
part of the master-key rotation plan.

TOTP reduces the risk from a stolen password. It is not phishing-resistant.
Operators should use a password manager, protect the email account used for
recovery, and avoid entering a code after following an untrusted link.

Keep provider account names, emergency contacts, enrolled administrator
identities, and recovery evidence in the private operations repository.
