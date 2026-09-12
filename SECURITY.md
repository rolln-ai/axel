# Security policy

## Reporting a vulnerability

[Report a vulnerability privately on GitHub](https://github.com/rolln-ai/axel/security/advisories/new).
Reports are visible to the maintainers and invited collaborators, not to the
public. Do not open public issues for vulnerabilities or include credentials
and customer payloads in public discussions.

You can also contact `security@axelapp.ai`.

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
