# Security Policy

## Reporting

Report security issues privately to `security@axelapp.ai` or directly to the
maintainer if that mailbox is not yet active. Do not open public GitHub issues
for vulnerabilities.

Include:

- Affected component or URL.
- Reproduction steps.
- Impact and data exposure risk.
- Suggested mitigation, if known.

## Supported Branches

`main` is the only supported branch until versioned releases are introduced.

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
