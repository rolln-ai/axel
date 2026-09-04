import type { Metadata } from "next";
import Link from "next/link";
import { COMMUNITY_SUPPORT_URL, SUPPORT_HREF } from "../../lib/contact";
import { SiteFooter, SiteHeader } from "../_components/SiteChrome";
import { JsonLd } from "../_components/JsonLd";
import { DashboardMock, PipelineMock, RouteMock, SourceMock } from "../_components/ProductMocks";
import { pageMetadata } from "../../lib/seo";
import { breadcrumbLd, howToLd } from "../../lib/structured-data";

const quickstartHowTo = howToLd({
  name: "Send your first webhook to a destination with Axel",
  description: "Create a source, point your producer at the Axel ingest URL, and watch an accepted event move from stored payload to destination.",
  path: "/docs#quickstart",
  steps: [
    { name: "Create a source via the API", text: "POST to https://app.axelapp.ai/api/v1/sources with your API key to get a per-source ingest token." },
    { name: "Point the producer at the ingest URL", text: "POST your event JSON to https://ingest.axelapp.ai/in/{source_id} with the x-axel-token header. The endpoint returns 202 after the original payload is stored." },
    { name: "Watch it land in the dashboard", text: "Open the dashboard to see the event count, source-level usage, and any failed deliveries. Accepted events stay queryable for 30 days." },
  ],
});

export const metadata: Metadata = pageMetadata({
  title: "Docs",
  description:
    "How Axel ingests, routes, and delivers webhook events. Quickstart, primitives, and operational runbooks.",
  path: "/docs",
});

const sections: Array<{ kicker: string; title: string; body: string; items: Array<{ label: string; href: string; note?: string }> }> = [
  {
    kicker: "Get started",
    title: "Send your first event in 5 minutes",
    body: "The fastest path is: create a workspace, create a source, point your producer at the ingest URL, and watch the event arrive in the dashboard.",
    items: [
      { label: "Quickstart: webhook → destination", href: "#quickstart", note: "5 min" },
      { label: "Custom / generic webhook source", href: "#custom-http", note: "5 min" },
    ],
  },
  {
    kicker: "Primitives",
    title: "How Axel thinks about events",
    body: "Webhook sources accept events. Routes evaluate declarative, eval-free filters and transforms. Destinations are where records land. Stable event IDs let receivers deduplicate retries.",
    items: [
      { label: "Webhook sources: tokens, rate limits, body caps", href: "#sources" },
      { label: "Routes: declarative filters & transforms", href: "#routes" },
      { label: "Destinations: Postgres, Mongo, BigQuery, R2, HTTP", href: "#destinations" },
      { label: "Delivery guarantees & idempotency", href: "#delivery-guarantees" },
    ],
  },
  {
    kicker: "Operate",
    title: "Run Axel in production",
    body: "Everything you need to know when something is on fire: replays, failed deliveries, transform errors, and how to tune queue shards as you grow.",
    items: [
      { label: "Replays: re-running an event safely", href: "#replays" },
      { label: "Failed deliveries: diagnosing terminal failures", href: "#failed-deliveries" },
      { label: "Transform errors: what to do when a route rejects an event", href: "#transform-errors" },
      { label: "Scaling knobs: concurrency, queue shards, retention", href: "#scaling" },
    ],
  },
  {
    kicker: "Reference",
    title: "API & schema reference",
    body: "Canonical event payload, queue message shapes, retry policy defaults, and ClickHouse schemas for log queries.",
    items: [
      { label: "Event payload schema", href: "#event-schema" },
      { label: "Retry policy defaults", href: "#retry-policy" },
      { label: "ClickHouse log tables", href: "#clickhouse" },
      { label: "Status codes & error reasons", href: "#status-codes" },
    ],
  },
];

export default function DocsPage() {
  return (
    <main>
      <JsonLd data={[quickstartHowTo, breadcrumbLd([{ name: "Home", path: "/" }, { name: "Docs", path: "/docs" }])]} />
      <SiteHeader />

      <section className="hero docsHero">
        <div className="container">
          <span className="kicker">Documentation</span>
          <h1 className="heroTitle docsTitle">
            Everything you need to <em>run webhooks</em> in production.
          </h1>
          <p className="heroLede">
            Start on Axel Cloud to use the managed service, or self-host the Apache-2.0
            application. These guides cover sources, routing, delivery, and recovery.
          </p>
          <div className="heroActions">
            <a className="btn" href="https://app.axelapp.ai/signup">
              Start on Axel Cloud <span className="arrow">→</span>
            </a>
            <Link className="btn ghost" href="#self-hosting">
              Self-hosting
            </Link>
          </div>
        </div>
      </section>

      <section className="feature" id="self-hosting">
        <div className="container">
          <div className="sectionHead">
            <span className="kicker">Self-hosting</span>
            <h2>Your infrastructure, the same application.</h2>
            <p className="lede">
              The small install runs Postgres, the dashboard, and delivery in Docker, with
              Cloudflare Workers, Queues, and R2 for ingest. You maintain the host, backups,
              and upgrades. Add ClickHouse for searchable event history and usage charts.
              There is no Axel license fee. Provider charges depend on your traffic and setup.
            </p>
            <div className="heroActions">
              <a className="btn" href="https://github.com/rolln-ai/axel/blob/main/docs/self-hosting.md">Installation guide <span className="arrow">→</span></a>
              <a className="btn ghost" href="https://github.com/rolln-ai/axel">Browse the source</a>
            </div>
          </div>
        </div>
      </section>

      <section className="band">
        <div className="container">
          <div className="docsGrid">
            {sections.map((section) => (
              <article className="docsLane" key={section.title}>
                <span className="kicker">{section.kicker}</span>
                <h2>{section.title}</h2>
                <p className="lede">{section.body}</p>
                <ul className="docsList">
                  {section.items.map((item) => (
                    <li key={item.label}>
                      <a href={item.href}>
                        <span>{item.label}</span>
                        {item.note ? <small>{item.note}</small> : <small aria-hidden="true">→</small>}
                      </a>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="feature docsBody">
        <div className="container">
          <div className="sectionHead">
            <span className="kicker">Get started</span>
            <h2 id="quickstart">Quickstart: accept your first webhook</h2>
            <p className="lede">
              CLI or curl. Accept an event, store its payload, and send it to a destination.
            </p>
          </div>

          <div className="codeStack">
            <article className="codeCard">
              <header>
                <strong>1.</strong>
                <h3>Create a source via the API</h3>
              </header>
              <pre><code>{`curl -X POST https://app.axelapp.ai/api/v1/sources \\
  -H "Authorization: Bearer $AXEL_API_KEY" \\
  -d '{ "name": "my-webhook" }'`}</code></pre>
              <p>The response includes a per-source ingest token (<code>secret_token</code>), shown only once. Store it as a secret in your producer&apos;s environment.</p>
            </article>

            <article className="codeCard">
              <header>
                <strong>2.</strong>
                <h3>Point the producer at the ingest URL</h3>
              </header>
              <pre><code>{`POST https://ingest.axelapp.ai/in/{source_id}
  x-axel-token: <token>
  content-type: application/json

  { "type": "order.created", "id": "ord_123", ... }`}</code></pre>
              <p>The endpoint returns 202 on acceptance. Your event is durable in R2 before the response.</p>
            </article>

            <article className="codeCard">
              <header>
                <strong>3.</strong>
                <h3>Watch it land in the dashboard</h3>
              </header>
              <p>
                Open <code>app.axelapp.ai</code>: Overview shows the event count tick up, Usage shows the
                source-level breakdown, and Deliveries shows any failed attempts.
              </p>
              <p>Every event you accept is queryable in ClickHouse for 30 days, including headers and query params. Raw payloads are kept in R2 for 30 days.</p>
            </article>
          </div>

          <figure className="docsFigure">
            <DashboardMock variant="standalone" />
            <figcaption>
              What you&apos;ll see after your first event: live counts, delivery outcomes, and anything that needs attention.
            </figcaption>
          </figure>

          <p>
            Prefer the CLI? Create a source in the dashboard, then <code>axel auth login</code> and{" "}
            <code>axel listen --source &lt;source_id&gt; --forward-to &lt;url&gt;</code>, or point your webhook producer
            at the ingest URL shown in the dashboard.
          </p>
        </div>
      </section>

      <section className="feature docsBody">
        <div className="container">
          <div className="sectionHead">
            <span className="kicker">Sources</span>
            <h2 id="custom-http">Custom / generic webhook sources</h2>
          <p className="lede">Use the generic source for producers that can POST JSON, form data, or bytes.</p>
          </div>

          <div className="codeStack">
            <article className="codeCard">
              <p>
                Create a source with <code>curl</code> or the dashboard, then POST to{" "}
                <code>https://ingest.axelapp.ai/in/{"{source_id}"}</code> with the <code>x-axel-token</code> header
                you received. No signature required.
              </p>
              <pre><code>{`curl -X POST https://ingest.axelapp.ai/in/src_01H... \\
  -H "x-axel-token: $AXEL_SOURCE_TOKEN" \\
  -H "content-type: application/json" \\
  -d '{ "type": "order.created", "id": "ord_123", ... }'`}</code></pre>
            </article>
            <p>
              You can also bring a custom HMAC secret and Axel will verify an{" "}
              <code>X-Axel-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code> header (timestamped, 5-minute tolerance) using
              constant-time comparison.
            </p>
          </div>
        </div>
      </section>

      <section className="feature docsBody">
        <div className="container">
          <div className="sectionHead">
            <span className="kicker">Primitives</span>
            <h2 id="sources">Webhook sources</h2>
            <p className="lede">
              Sources are the entry points. Each source has its own token (or signing secret), rate limit, body size
              cap, and nesting depth guard.
            </p>
          </div>

          <ul>
            <li>Per-source rate limits (events/min, operator-configured) protect downstream systems.</li>
            <li>Body cap (1 MB default) and depth cap (100 levels) reject pathological payloads early.</li>
            <li>An accepted event is written to R2 before the 202 response is sent.</li>
            <li>Token values are stored only as SHA-256 hashes; never in logs.</li>
          </ul>

          <figure className="docsFigure">
            <SourceMock />
            <figcaption>
              A source&apos;s detail page: its limits, live traffic, and the payloads it receives.
            </figcaption>
          </figure>

          <h2 id="routes">Routes: declarative filters &amp; transforms</h2>
          <p className="lede">
            Routes decide where events go and what they look like. Rules are data, not code.
          </p>
          <ul>
            <li>Filter by event type (e.g. <code>payments.live</code> matches <code>invoice.paid</code> etc.).</li>
            <li>
              Declarative transforms: select/rename fields by JSON path, drop fields, pass the whole payload through,
              or wrap it as a <code>JSONB</code> column.
            </li>
            <li>The route engine is eval-free and does not execute customer JavaScript.</li>
            <li>Fan-out to many destinations from one source with per-(route, destination) idempotency keys.</li>
          </ul>

          <figure className="docsFigure">
            <RouteMock />
            <figcaption>
              The Routes view: each source&apos;s filter, its destination, and live p95 delivery latency.
            </figcaption>
          </figure>

          <h2 id="destinations">Destinations</h2>
          <p className="lede">
            Deliver with retries to the systems you already run.
          </p>
          <ul>
            <li>
              <strong>Signed webhook</strong>: POST with HMAC + deterministic idempotency header so receivers can
              dedupe safely.
            </li>
            <li>
              <strong>Postgres</strong>: insert into a JSONB column or auto-flattened columns (column projection).{" "}
              <strong>MongoDB</strong>: insert into native collections.
            </li>
            <li>
              <strong>S3</strong>: write JSON objects with templated keys (<code>{"{date}"}</code>,{" "}
              <code>{"{event_id}"}</code>). <strong>Cloudflare R2</strong>: write JSON objects under a configurable key
              prefix.
            </li>
            <li>
              <strong>Databricks</strong>: drop JSON files into Unity Catalog volumes for Auto Loader ingest into Delta.
            </li>
            <li>
              <strong>BigQuery</strong>: stream each event into a table via insertAll. New routes recursively map JSON
              objects to nested RECORD fields, normalize scalar leaves to STRING for schema-drift tolerance, and map
              compatible object arrays to REPEATED RECORD fields. Axel creates the table when needed and additively
              evolves nested schemas; legacy flat-column and single-STRING-column modes remain available.
            </li>
          </ul>

          <h2 id="delivery-guarantees">Delivery guarantees &amp; idempotency</h2>
          <p>
            Axel provides at-least-once delivery to external destinations. Delivery attempts use a stable key of the
            form <code>workspace:event:route:destination</code>, and retries reuse that key. A signed HTTP receiver should
            deduplicate on <code>X-Axel-Event-Id</code> because a process can fail after the destination accepts a request
            but before Axel records the acknowledgement. Replays use a new event ID and are intentionally delivered again.
          </p>
        </div>
      </section>

      <section className="feature docsBody">
        <div className="container">
          <div className="sectionHead">
            <span className="kicker">Operate</span>
            <h2 id="replays">Replays</h2>
            <p className="lede">Replay an accepted event while its original payload is retained.</p>
          </div>

          <p>
            From the dashboard or CLI:
          </p>
          <pre><code>{`# Dashboard: click any event → Replay
# CLI (exact bytes to your laptop)
axel replay evt_01HZQ8R7XK --forward-to http://localhost:3000/webhook`}</code></pre>

          <ul>
            <li>Replays pull the original payload + headers from R2 (up to 30-day retention).</li>
            <li>
              Provider signature headers (Stripe, GitHub, Shopify, Axel) are stripped by default since their signed
              timestamp is stale; pass <code>--keep-signature</code> to forward them anyway.
            </li>
            <li>Each replay gets a distinct, replay-tagged event id so the re-delivery is recorded separately from the original.</li>
          </ul>

          <figure className="docsFigure">
            <PipelineMock />
            <figcaption>
              An event&apos;s trace: every hop from accept to store to route to deliver, with timings.
            </figcaption>
          </figure>

          <h2 id="failed-deliveries">Failed deliveries &amp; the Inbox</h2>
          <p>
            Every delivery attempt is recorded. Permanent failures (after all retries) land in the Inbox with one-click
            <strong> Retry</strong> and <strong>Mute</strong>. No SQL, no digging through DLQ tables.
          </p>
          <p>
            The event detail page shows the receipt, the stored payload, and a delivery history of every HTTP attempt
            with its status, latency, and the failure reason (TLS error, 503, timeout, etc.).
          </p>

          <h2 id="transform-errors">Transform &amp; route errors</h2>
          <p>
            If a declarative filter excludes an event it is dropped; if a transform or filter errors at runtime the
            event is dead-lettered and shows up in the Inbox. Oversized or too-deep payloads are rejected at ingest with
            a 413 before they are ever stored or routed.
          </p>

          <h2 id="scaling">Scaling knobs</h2>
          <ul>
            <li>Per-source rate limits + body/depth caps are your first line of defense.</li>
            <li>Router and delivery workers use bounded concurrency and sharded queues (Cloudflare Queues + internal).</li>
            <li>Raw payloads: 30 days by default (0–30 configurable). ClickHouse traces: 30-day TTL.</li>
            <li>Dead letters: 90 days by default (1–365 configurable). Replay requests: 30 days by default (1–90 configurable).</li>
            <li>Audit logs: 365 days by default (30–3,650 configurable).</li>
            <li>Dashboard and API give you per-route and per-destination delivery metrics, including p95 delivery latency.</li>
          </ul>
        </div>
      </section>

      <section className="feature docsBody">
        <div className="container">
          <div className="sectionHead">
            <span className="kicker">Reference</span>
            <h2 id="event-schema">Event envelope (what you receive back)</h2>
          </div>

          <p>
            Every stored event carries Axel metadata and a pointer to the raw body in R2 (the body is referenced by{" "}
            <code>r2_key</code> rather than inlined). Example shape:
          </p>

          <pre><code>{`{
  "event_id": "evt_01HZQ8R7XK",
  "workspace_id": "ws_...",
  "source_id": "src_...",
  "received_at": "2026-06-16T14:22:09.123Z",
  "r2_key": "...",
  "size_bytes": 1024,
  "headers": { "x-my-signature": "..." },
  "query": {}
}`}</code></pre>

          <h2 id="retry-policy">Retry policy (defaults)</h2>
          <p>
            Up to 12 delivery attempts with exponential backoff. Retries are included in the inbound event price. The retry policy is fixed
            and not per-source configurable.
          </p>

          <h2 id="clickhouse">ClickHouse observability</h2>
          <p>
            All receipt, routing, and delivery rows are queryable in ClickHouse for 30 days (headers, query params, and
            failure reasons; raw payloads live in R2). The dashboard search and the <code>axel</code> CLI use these tables.
            Export or run your own queries from the usage / deliveries views.
          </p>

          <h2 id="status-codes">Important status &amp; error reasons</h2>
          <ul>
            <li>202: accepted (written to R2, queued for routing)</li>
            <li>429: rate limited at source</li>
            <li>413 / depth errors: body or nesting exceeded caps</li>
            <li>Signature / auth failures: rejected before durable store</li>
            <li>Destination 5xx, timeouts, and connection errors: retried per policy, then DLQ</li>
            <li>Permanent 4xx (e.g. 400/401/403/404/410): dead-lettered immediately</li>
          </ul>
        </div>
      </section>

      <section className="cta">
        <div className="container">
          <div className="ctaInner">
            <h2>Need a question answered?</h2>
            <p>
              Ask in GitHub Discussions. Axel Cloud customers can also use the configured support address for private
              account or billing questions.
            </p>
            <div className="heroActions">
              <a className="btn" href={SUPPORT_HREF ?? COMMUNITY_SUPPORT_URL}>
                {SUPPORT_HREF ? "Email support" : "Ask the community"} <span className="arrow">→</span>
              </a>
              <Link className="btn ghost" href="/security">
                Security
              </Link>
            </div>
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
