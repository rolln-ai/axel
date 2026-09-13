import type { Metadata } from "next";
import Link from "next/link";
import { COMMUNITY_SUPPORT_URL, SUPPORT_HREF } from "../../lib/contact";
import { SiteFooter, SiteHeader } from "../_components/SiteChrome";
import { SOURCE_URL, SELF_HOSTING_URL } from "../../lib/project";
import { JsonLd } from "../_components/JsonLd";
import { DashboardMock, PipelineMock, RouteMock, SourceMock } from "../_components/ProductMocks";
import { pageMetadata } from "../../lib/seo";
import { breadcrumbLd, howToLd } from "../../lib/structured-data";

const quickstartHowTo = howToLd({
  name: "Accept your first webhook with Axel",
  description: "Create a source, send a webhook to its ingest URL, and check that it arrived.",
  path: "/docs#quickstart",
  steps: [
    { name: "Create a source via the API", text: "POST to https://app.axelapp.ai/api/v1/sources with your API key to get a per-source ingest token." },
    { name: "Send an event to the ingest URL", text: "POST your event JSON to https://ingest.axelapp.ai/in/{source_id} with the x-axel-token header. The endpoint returns 202 after the original payload is stored." },
    { name: "Check the dashboard", text: "Open the dashboard to see the event count, source-level usage, and any failed deliveries. Axel Cloud retains searchable event history for 30 days." },
  ],
});

export const metadata: Metadata = pageMetadata({
  title: "Docs",
  description:
    "How Axel ingests, routes, and delivers webhook events. Setup, delivery behavior, and operations guides.",
  path: "/docs",
});

const sections: Array<{ kicker: string; title: string; body: string; items: Array<{ label: string; href: string; note?: string }> }> = [
  {
    kicker: "Get started",
    title: "Accept your first event",
    body: "Create a workspace and a source, then send an event to its ingest URL.",
    items: [
      { label: "Quickstart: accept a webhook", href: "#quickstart" },
      { label: "Custom / generic webhook source", href: "#custom-http" },
    ],
  },
  {
    kicker: "Concepts",
    title: "Sources, routes, and destinations",
    body: "Sources accept events. Routes filter and transform them. Destinations receive the result. Retries keep the same event ID so receivers can deduplicate them.",
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
    body: "Inspect failures, fix route errors, and replay retained events. Self-host operators also manage queue capacity and retention.",
    items: [
      { label: "Replays: send an event again", href: "#replays" },
      { label: "Failed deliveries: diagnosing terminal failures", href: "#failed-deliveries" },
      { label: "Transform errors: what to do when a route rejects an event", href: "#transform-errors" },
      { label: "Capacity and retention", href: "#scaling" },
    ],
  },
  {
    kicker: "Reference",
    title: "Event and delivery reference",
    body: "Event metadata, retry defaults, storage, and response codes.",
    items: [
      { label: "Event payload schema", href: "#event-schema" },
      { label: "Retry policy defaults", href: "#retry-policy" },
      { label: "Event storage and search", href: "#clickhouse" },
      { label: "Repository guides and runbooks", href: `${SOURCE_URL}/blob/main/docs/README.md` },
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
            Set up Axel. <em>Send your first webhook</em>.
          </h1>
          <p className="heroLede">
            Start on Axel Cloud to use the managed service. These guides cover sources,
            routing, delivery, and recovery. You can also self-host the Apache-2.0 application.
          </p>
          <div className="heroActions">
            <a className="btn" href="https://app.axelapp.ai/signup?ref=website">
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
              <a className="btn" href={SELF_HOSTING_URL}>Installation guide <span className="arrow">→</span></a>
              <a className="btn ghost" href={SOURCE_URL}>View source on GitHub</a>
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
              Create an Axel Cloud workspace and a workspace API key with write access.
              Set <code>AXEL_API_KEY</code> in your shell before running the example. For self-hosting,
              use your dashboard and ingest URLs in place of the Cloud URLs below.
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
  -H "content-type: application/json" \\
  -d '{ "name": "my-webhook" }'`}</code></pre>
              <p>The response includes the source ID, ingest URL, and <code>secret_token</code>.
                Axel shows the token only once. Set <code>AXEL_INGEST_URL</code> to the returned
                ingest URL and <code>AXEL_SOURCE_TOKEN</code> to the token before the next command.</p>
            </article>

            <article className="codeCard">
              <header>
                <strong>2.</strong>
                <h3>Send an event to the ingest URL</h3>
              </header>
              <pre><code>{`curl -X POST "$AXEL_INGEST_URL" \\
  -H "x-axel-token: $AXEL_SOURCE_TOKEN" \\
  -H "content-type: application/json" \\
  -d '{ "type": "order.created", "id": "ord_123" }' `}</code></pre>
              <p>Axel returns 202 after storing the payload and queueing it for routing. This confirms acceptance, not destination delivery.</p>
            </article>

            <article className="codeCard">
              <header>
                <strong>3.</strong>
                <h3>Check the dashboard</h3>
              </header>
              <p>
                Open <code>app.axelapp.ai</code>. Check Overview for accepted events and Usage for
                traffic by source. To deliver events onward, create a destination and an active
                route from this source, then send another event and check Deliveries.
              </p>
              <p>Axel Cloud keeps searchable event history for 30 days. Raw payloads expire after 30 days by default, or sooner if you configure shorter retention.</p>
            </article>
          </div>

          <figure className="docsFigure">
            <DashboardMock variant="standalone" />
            <figcaption>
              The dashboard with sample traffic and delivery outcomes.
            </figcaption>
          </figure>

          <p>
            To use the CLI, follow the <a href={`${SOURCE_URL}/blob/main/packages/cli/README.md`}>installation guide</a>.
            Create a source in the dashboard, then run <code>axel auth login</code> and{" "}
            <code>axel listen --source &lt;source_id&gt; --forward-to &lt;url&gt;</code>, or point your webhook producer
            at the ingest URL shown in the dashboard. For self-hosting, sign in with{" "}
            <code>axel auth login --api-base https://axel.example.com</code>, using your own dashboard URL.
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
  -d '{ "type": "order.created", "id": "ord_123" }'`}</code></pre>
            </article>
            <p>
              You can also bring a custom HMAC secret and Axel will verify an{" "}
              <code>X-Axel-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code> header with a five-minute timestamp tolerance.
              See <a href={`${SOURCE_URL}/blob/main/docs/webhook-authentication.md`}>webhook authentication</a>
              {" "}for sender setup and URL authentication.
            </p>
          </div>
        </div>
      </section>

      <section className="feature docsBody">
        <div className="container">
          <div className="sectionHead">
            <span className="kicker">Concepts</span>
            <h2 id="sources">Webhook sources</h2>
            <p className="lede">
              Each source has its own authentication, rate limit, body size limit, and nesting depth limit.
            </p>
          </div>

          <ul>
            <li>Per-source rate limits (events/min, operator-configured) protect downstream systems.</li>
            <li>The default limits reject bodies over 1 MB and nesting deeper than 100 levels.</li>
            <li>An accepted event is written to R2 before the 202 response is sent.</li>
            <li>Axel stores source tokens as SHA-256 hashes. Use headers when your sender supports them; authenticated URLs can appear in sender or proxy logs.</li>
          </ul>

          <figure className="docsFigure">
            <SourceMock />
            <figcaption>
              A source&apos;s detail page: its limits, live traffic, and the payloads it receives.
            </figcaption>
          </figure>

          <h2 id="routes">Routes: declarative filters &amp; transforms</h2>
          <p className="lede">
            Routes choose destinations and define which fields each destination receives.
          </p>
          <ul>
            <li>Filter by event type or payload fields, then preview which events match.</li>
            <li>
              Declarative transforms: select/rename fields by JSON path, drop fields, pass the whole payload through,
              or wrap it as a <code>JSONB</code> column.
            </li>
            <li>The route engine is eval-free and does not execute customer JavaScript.</li>
            <li>Send one source to multiple destinations. Each route and destination pair has its own delivery idempotency key.</li>
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
              compatible object arrays to REPEATED RECORD fields. Axel creates the table when needed.
              Enable <strong>Allow new fields</strong> on the route binding to add fields to an existing table
              automatically. Otherwise, update the schema yourself. Axel does not widen existing column types.
              Legacy flat-column and single-STRING-column modes remain available.
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
            Use the dashboard to replay through your routes. Use the CLI to send stored bytes directly to a local handler:
          </p>
          <pre><code>{`# Dashboard: click any event → Replay
# CLI (exact bytes to your laptop)
axel replay evt_01HZQ8R7XK --forward-to http://localhost:3000/webhook`}</code></pre>

          <ul>
            <li>Replay requires the original payload to remain in storage. Retained metadata excludes authentication and other sensitive headers.</li>
            <li>
              The CLI strips supported provider signature headers by default.
              <code> --keep-signature</code> preserves only headers still present in the retrieved metadata;
              it cannot restore headers removed at ingestion or make an expired signature valid.
            </li>
            <li>Dashboard replays create a new event ID. CLI forwarding goes directly to your handler and does not create an Axel delivery record.</li>
          </ul>

          <figure className="docsFigure">
            <PipelineMock />
            <figcaption>
              An event&apos;s trace: every hop from accept to store to route to deliver, with timings.
            </figcaption>
          </figure>

          <h2 id="failed-deliveries">Failed deliveries &amp; the Inbox</h2>
          <p>
            Terminal failures appear in the Inbox after retries are exhausted or the destination returns a
            non-retryable error. Open the failure to inspect its history, retry after a fix, or mute it.
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

          <h2 id="scaling">Capacity and retention</h2>
          <ul>
            <li>Set per-source rate limits and payload limits to control incoming traffic.</li>
            <li>Router and delivery workers use bounded concurrency and sharded queues (Cloudflare Queues + internal).</li>
            <li>Axel Cloud raw payloads: 30 days by default, configurable from 0 to 30. ClickHouse traces expire after 30 days.</li>
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
            <h2 id="event-schema">Event metadata</h2>
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

          <h2 id="retry-policy">Default retry policy</h2>
          <p>
            Up to 12 delivery attempts with exponential backoff. Retries are included in the inbound event price. The retry policy is fixed
            and not per-source configurable.
          </p>

          <h2 id="clickhouse">Event storage and search</h2>
          <p>
            ClickHouse stores receipt, routing, and delivery metadata for 30 days. The dashboard and CLI
            use it for event search and delivery history. Raw payloads stay in R2. The small self-host
            profile omits ClickHouse, so analytics-backed search and usage views are unavailable.
            Its raw payload retention is fixed at 30 days; see the self-hosting guide before choosing a profile.
          </p>

          <h2 id="status-codes">Response codes and failure reasons</h2>
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
            <h2>Need help with setup?</h2>
            <p>
              Ask setup and usage questions in GitHub Discussions. Contact Axel Cloud support privately
              for account or billing questions.
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
