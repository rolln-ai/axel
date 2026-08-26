# Router Sandbox Spike (historical)

> Archived implementation spike. The production JavaScript sandbox was removed
> in AXE-24 and was never wired into the production edge router. Current routes
> use the eval-free declarative engine described in `apps/router/src/processor.ts`.
> Keep this document only as historical design context; do not use it for product
> or security claims.

## Success condition

Phase 4 cannot ship until we have a sandbox for filter/transform execution that
the SecurityEngineer is willing to sign off on. The spike answers four
questions:

1. Can we get per-execution V8 isolation with strict CPU and memory caps?
2. Can we expose `body`, `headers`, `query` to user code without leaking host
   capabilities (network, filesystem, secrets, prototype chain)?
3. When a route's script breaches a limit or escapes, can we contain the blast
   radius — keep the router process alive, mark the route errored, and never
   block ingest?
4. What's the production path? Is `isolated-vm` still the right target?

## Decision

**Use `node:worker_threads` with strict `resourceLimits` for the spike, plan to
swap the inner sandboxing engine to `isolated-vm` if profiling shows the
worker-bring-up cost dominates throughput in production.** The per-execution
worker-thread design is the load-bearing part; the in-worker sandbox engine is
swappable behind the `evaluateFilter` / `evaluateTransform` interface.

## Architecture

```
ingest worker → Cloudflare Queue (16 shards)
                       │
                       ▼
              router process (Node 20)
                       │
                       ▼
              evaluateRoute({ filter, transform }, { body, headers, query })
                       │
            ┌──────────┴───────────┐
            ▼                      ▼
   spawn Worker thread     resourceLimits:
   (one per evaluation)    - maxOldGenerationSizeMb: 16
   eval=false, env={}      - codeRangeSizeMb: 16
                           - stackSizeMb: 4
                       │
                       ▼
            postMessage { source, input, cpuMs }
                       │
                       ▼
   ┌───────────────────────────────────────────┐
   │ inside worker:                            │
   │   vm.createContext({ body, headers, query },│
   │     { codeGeneration: { strings: false,    │
   │                          wasm: false } })  │
   │   body/headers/query are deeply frozen     │
   │   vm.Script(wrapped).runInContext(ctx,     │
   │     { timeout: cpuMs })                    │
   │   structuredClone(result) before reply     │
   └───────────────────────────────────────────┘
                       │
                       ▼
             postMessage { ok, value } | { breach, reason }
                       │
                       ▼
            worker.terminate() (always)
```

Each evaluation is its own OS thread + V8 isolate. **Workers are never reused
across evaluations — there is no pool.** This is intentional: pooling is the
classic vector for cross-tenant state leaks via `globalThis`, prototype
mutation, and lazy-loaded module state. The 1–3ms cost of spinning a fresh
worker is acceptable in exchange for the strong isolation property.

## What the sandbox actually denies

Verified by the adversarial test suite at
`apps/router/test/sandbox.adversarial.test.ts` — **26/26 tests passing**.

| Attack class            | Concrete attack                                | Outcome                                                |
| ----------------------- | ---------------------------------------------- | ------------------------------------------------------ |
| CPU exhaustion          | `while(true){}`                                | `cpu_timeout` breach at 50ms                           |
| CPU exhaustion          | `for (i<1e12) sum+=i`                          | `cpu_timeout` breach                                   |
| CPU exhaustion          | unbounded recursion                            | `cpu_timeout` or `transform_threw`                     |
| Memory exhaustion       | array push loop                                | `memory_exceeded` / `cpu_timeout` / `worker_crash`     |
| Memory exhaustion       | `s = s + s` doubling                           | breach (CPU fires first)                               |
| Prototype pollution     | `Object.prototype.x = 'pwn'`                   | host prototype unchanged                               |
| Prototype pollution     | mutate frozen `body.hello`                     | mutation no-op (frozen)                                |
| Prototype pollution     | `body.__proto__ = { stolen: true }`            | host `Object.prototype.stolen` unchanged               |
| Network egress          | `typeof fetch`                                 | `undefined`                                            |
| Network egress          | `typeof XMLHttpRequest`                        | `undefined`                                            |
| Network egress          | `typeof require`                               | `undefined`                                            |
| Network egress          | `import('node:http')`                          | unresolvable promise (no host module)                  |
| Network egress          | `typeof process`                               | `undefined`                                            |
| Network egress          | `typeof Buffer`                                | `undefined`                                            |
| Sandbox escape          | `eval('1+1')`                                  | `forbidden_global` (codeGeneration.strings=false)      |
| Sandbox escape          | `new Function('…')`                            | `forbidden_global`                                     |
| Sandbox escape          | classic `(function(){}).constructor('return process')()` | blocked by codeGeneration.strings              |
| Result tampering        | return a function                              | `non_serializable_result`                              |
| Result tampering        | return a Proxy with plain target               | accepted as plain object (Proxy collapses on clone)    |
| Tenant isolation        | `globalThis.shared = secret` then re-evaluate  | second eval sees `undefined`                           |
| Tenant isolation        | parallel evaluations with different bodies     | no cross-talk                                          |
| Breach contract         | CPU breach → route errored + dead-letter       | both happen, ingest never sees an error                |
| Breach contract         | control plane write fails during breach handling | event still reaches dead-letter; error propagates    |

## Egress allowlist on the router process

The sandbox stops user code from making network calls *from inside a route
script*. It does not stop the router *itself* from being misconfigured to talk
to anything on the public internet. The second control is process-level egress
allowlist.

**Plan (Phase 4):**

- The router runs on a Cloudflare Worker for the queue-consumer phase. CF
  Workers' fetch is naturally constrained by `outbound` bindings — declare
  bindings only for R2 (raw payload reads), the destination queues we own, and
  ClickHouse Cloud's HTTPS endpoint.
- Reject any fetch the binding system did not authorize. Fail closed at deploy
  time if a new binding shows up that wasn't in the previous deploy's manifest.
- For destination connectors that need broader network (HTTP webhook delivery,
  customer Postgres/Mongo URIs), put the connectors in a separate worker
  service so the queue-consumer worker can keep its tight allowlist.
- For local Node-process deploys (today's spike + dev), document the same
  contract via `NODE_OPTIONS=--enable-network-family-autoselection=false` and
  a startup-time `dns.lookup` interceptor that rejects anything outside the
  configured allowlist. Spike does not implement this — it's a deployment
  artifact, not an in-process check.

The egress allowlist is **not** a substitute for the sandbox; it is a defense in
depth. If a sandbox escape ever lands user-controlled code in the host
process, the egress allowlist is what stops that code from talking to the
attacker's exfil endpoint.

## Breach contract — ingest never blocks

When the sandbox returns a breach, `handleBreach` must:

1. Mark the offending route `errored` in the control plane (Postgres). Future
   queue messages for that route skip the sandbox path and dead-letter
   immediately.
2. Push a record onto the dead-letter queue with `{ workspace_id, event_id,
   source_id, route_id, r2_key, reason, message, errored_at }`.
3. **The ingest worker has already returned `202` to the customer by this
   point.** Nothing about a breach can reach upstream.

If marking the route errored fails (control plane outage), the dead-letter push
still happens. We re-throw the control-plane error so the caller logs it, but
the event itself is never lost. This is asserted by the
`dead-letter still captures the event when the control plane write throws`
test.

## Why not `isolated-vm` in the spike

`isolated-vm` is the right target for production. We chose worker-threads for
the spike because:

- **Native module risk.** `isolated-vm` requires `node-gyp` and a working C++
  toolchain. Half the value of the spike is letting it run in CI and on every
  contributor's machine without bespoke build steps. Node 20's
  `worker_threads.resourceLimits` gives us the same V8-isolate-per-execution
  guarantee with zero native dependencies.
- **Equivalent guarantees.** Each Worker thread runs in its own V8 isolate.
  `vm.createContext` inside the worker enforces the actual surface area
  (`codeGeneration.strings`, `codeGeneration.wasm`). `Worker.resourceLimits`
  enforces memory; `vm.Script({ timeout })` enforces CPU.
- **Operational footprint.** `isolated-vm`'s sweet spot is sub-millisecond
  per-execution overhead with pooled isolates. Pooling is exactly what we
  *don't* want for tenant safety. Per-execution `isolated-vm` ends up close to
  per-execution worker-threads in cost, and worker-threads gives us the OS
  isolation bonus.

If profiling later shows worker spawn cost dominating per-event latency, the
swap point is exactly `apps/router/src/sandbox/worker.mjs`. The
`evaluator.ts` interface is engine-agnostic.

## What the spike does NOT cover (left for Phase 4)

- Production-grade observability: per-route metrics for breach counts, latency
  histograms, and the breach-reason fanout in ClickHouse. The spike just
  surfaces a `SandboxResult` discriminated union; metrics emission is wiring.
- The `egress_attempted` breach reason is reserved in `BreachReason` for the
  process-level egress allowlist; the spike sandbox cannot trip it because no
  network primitives are reachable from inside the sandbox to begin with.
- Worker reuse with explicit isolate reset. Reserved as an optimization knob
  if cold-start cost becomes a problem; not in scope for the spike.
- Static analysis pass over user-provided scripts (size cap, ban specific
  identifiers up front) — useful for early rejection but not load-bearing for
  the security guarantee.

## Verification

```bash
pnpm --filter @axel/router exec vitest run
# Test Files  1 passed (1)
#      Tests  26 passed (26)
```

Run on Node 20.18.0 (darwin arm64) on `spike/router-sandbox-rol32` at commit
`da950d4` plus the assertion-tightening follow-up commit.

## Hand-off

- Implementation: `apps/router/src/sandbox/{types.ts,evaluator.ts,worker.mjs}`,
  `apps/router/src/breach.ts`.
- Adversarial suite: `apps/router/test/sandbox.adversarial.test.ts`.
- Security review asks:
  1. Add or modify attacks where you think the threat model is thin.
  2. Validate the egress-allowlist plan against the deployment topology.
  3. Sign off on the worker-threads choice or block on a switch to
     `isolated-vm` before Phase 4.
