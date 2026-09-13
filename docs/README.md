# Axel documentation

## Use Axel

- [Cloud quickstart](https://axelapp.ai/docs#quickstart): create a source and send an event.
- [Self-hosting](self-hosting.md): install with Docker and Cloudflare, estimate costs, and upgrade.
- [Webhook authentication](webhook-authentication.md): configure headers, provider authentication, or authenticated URLs.
- [Data flow alerts](incident-alerts.md): understand traffic gaps, failed deliveries, and recovery notices.
- [Warehouse schemas](warehouse-schema-policy.md): choose whether routes may add columns.
- [CLI](../packages/cli/README.md): send, forward, and replay events from a terminal.
- [Postman examples](postman/README.md): test with synthetic payloads.
- [API reference](../apps/dashboard/public/openapi.yaml): endpoint and request schemas.

## Operate an installation

- [Current runtime](adr-0002-current-runtime.md) and [scale targets](production-scale.md).
- [Database roles](database-service-roles.md), [credential rotation](credential-rotation.md), and [admin MFA](admin-mfa-operations.md).
- [Incident response](incident-response.md) and [delivery canary](runbook-delivery-canary.md).
- [BigQuery nested records](runbook-bigquery-nested-records.md) and [ClickHouse migration](runbook-clickhouse-migration.md).
- [Authentication migration](ingest-auth-migration.md) for existing senders.
- [Monitoring configuration](../infra/alerts/README.md).

## Contribute

Read the [contribution guide](../CONTRIBUTING.md), [test instructions](../AGENTS.md),
and [UI conventions](../DESIGN.md). Use [GitHub Discussions](https://github.com/rolln-ai/axel/discussions)
for questions and [private security reporting](../SECURITY.md) for vulnerabilities.

The [original architecture](adr-0001-architecture.md), [sandbox proposal](router-sandbox-spike.md),
and [security review](security-review-2026-08.md) contain historical context.
Use the current runtime guide for deployment decisions.
