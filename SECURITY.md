# Security Policy

## Reporting

Use the repository Security tab's **Report a vulnerability** action when it is
available. Otherwise email `security@axelapp.ai`. Do not open public GitHub
issues for vulnerabilities.

Before making this repository public, maintainers must verify the security
mailbox end to end and enable GitHub private vulnerability reporting so both
paths are actionable. The repository remains private until that publication
gate is complete.

Include:

- Affected component or URL.
- Reproduction steps.
- Impact and data exposure risk.
- Suggested mitigation, if known.

## Supported Branches

`main` is the only supported branch until the first public `v0.x` release is
tagged. After that, the latest tagged `v0.x` release and `main` receive security
fixes.

## Handling

Security issues are tracked privately by the maintainers.

High-risk fixes require:

- Pull request review.
- CI passing.
- Explicit deploy and rollback notes.
- Post-deploy smoke check.

## Secrets

Never commit secrets. GitHub Actions runs secret scanning, and production
secrets must live in GitHub, Cloudflare, Vercel, Render, or the chosen secret
manager.
