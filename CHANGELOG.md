# Changelog

This file records user-visible changes to Axel. The project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) while public APIs
and deployment contracts mature toward 1.0.

## Unreleased

The first public release has not been tagged. These features are available on `main`.

- Automatic "stopped receiving data" alerts now wait for a source's first week
  of traffic, then allow the longest quiet period seen in its retained history
  plus a 25% margin. An explicit maximum gap still alerts from the start.

- License Axel under Apache License 2.0, including its explicit patent grant.
- Ingest webhooks, store raw payloads durably, and route events with declarative
  filters and transforms.
- Deliver to HTTP, Postgres, MongoDB, BigQuery, Databricks, and object storage
  with retries, dead-letter handling, and replay.
- Inspect 30 days of event and delivery history in Axel Cloud.
- Run the small self-host profile with Cloudflare edge resources and a Docker
  host for the control plane and delivery service.
