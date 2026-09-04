# Router sandbox spike (archived)

This document records an abandoned design proposal for running tenant-supplied
JavaScript in isolated Node worker threads. The sandbox was never connected to
the production router, and its experimental implementation and tests are not
part of the current repository.

Axel routes now use the eval-free declarative processor in
`apps/router/src/processor.ts`. Treat that implementation and its current tests
as authoritative for product and security behavior.

The original spike write-up remains available in repository history:

```sh
git show d19da91:docs/router-sandbox-spike.md
```
