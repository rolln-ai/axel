# Security policy

## Reporting a vulnerability

Use the repository Security tab's **Report a vulnerability** action when it is
available. Otherwise email `security@axelapp.ai`. Do not open public GitHub
issues for vulnerabilities.

GitHub makes private vulnerability reporting available only for public
repositories. During the public launch, maintainers first verify the security
mailbox end to end. Immediately after the visibility change, an administrator
enables private vulnerability reporting, secret scanning, push protection,
and validity checks, then verifies the **Report a vulnerability** flow. The
launch is not complete until both reporting paths work.

Include:

- Affected component or URL.
- Reproduction steps.
- Impact and data exposure risk.
- Suggested mitigation, if known.

## Supported branches

`main` is the only supported branch until the first public `v0.x` release is
tagged. After that, the latest tagged `v0.x` release and `main` receive security
fixes.

## Handling

Security issues are tracked privately by the maintainers.

High-risk fixes require:

- A pull request with a documented self-review. An independent review is also
  required when another qualified maintainer is available.
- CI passing.
- Explicit deploy and rollback notes.
- Post-deploy smoke check.

## Secrets

Never commit secrets. CI runs Gitleaks across the repository and its history.
Maintainers also enable GitHub secret scanning and push protection for the
public repository. Production secrets must live in GitHub environments,
Cloudflare, Vercel, Render, or the chosen secret manager.
