import { SiteFooter, SiteHeader } from "./_components/SiteChrome";
import { SOURCE_URL, LICENSE_URL, SELF_HOSTING_URL } from "../lib/project";
import { JsonLd } from "./_components/JsonLd";
import { DashboardMock, PipelineMock, RouteMock, SourceMock } from "./_components/ProductMocks";
import { breadcrumbLd, type FaqItem, faqPageLd, softwareApplicationLd } from "../lib/structured-data";

/* ---------- homepage FAQ (answer-first; also emitted as FAQPage JSON-LD) ---------- */

const homeFaqs: FaqItem[] = [
  {
    q: "What is Axel?",
    a: "Axel is an open-source platform that captures third-party webhooks and delivers them to your data stack. It stores the original payload before returning 202, then routes it to your database, warehouse, object storage, or HTTP endpoint. Failed deliveries retry automatically, with searchable history and replay controls for recovery.",
  },
  {
    q: "Is Axel open source?",
    a: "Yes. The application is available on GitHub under Apache-2.0, including the connectors, routing, retries, and replay. You can use, modify, and self-host it without an Axel license fee. Your hosting providers may charge for infrastructure.",
  },
  {
    q: "How is Axel Cloud different from self-hosting?",
    a: "Axel Cloud runs the same application code. We manage the infrastructure, updates, and delivery monitoring, with 30 days of searchable event and delivery history. When you self-host, you operate Docker and Cloudflare in your own accounts. ClickHouse is optional in the small self-host profile and is needed for analytics-backed search and usage views.",
  },
  {
    q: "What does an Axel 202 response mean?",
    a: "It means Axel accepted the event and stored its original payload before acknowledging the request. Axel then routes and delivers the event asynchronously. If the sender does not receive a 202 response, it should retry according to its webhook policy.",
  },
  {
    q: "What happens if a webhook delivery fails?",
    a: "Axel retries failed destination deliveries with backoff. When retries are exhausted, the delivery appears in the failed-deliveries inbox with its history and recovery controls. You can retry it or replay the stored payload while it remains within your retention window.",
  },
  {
    q: "Does Axel deliver each event exactly once?",
    a: "No distributed webhook system can promise exactly-once delivery to an external destination. Axel uses at-least-once delivery with a stable event ID across retries. Signed HTTP receivers should deduplicate on X-Axel-Event-Id. A replay creates a new event ID because it is an intentional new delivery.",
  },
  {
    q: "Is there a free tier?",
    a: "Yes. You can receive 10,000 accepted inbound events per month for free, with no credit card. Paid usage is $20/month applied as a usage credit, then $0.015 per 1,000 accepted inbound events. Destination pushes and retries are included.",
  },
  {
    q: "Is Axel a replacement for Kafka?",
    a: "No. Axel is the webhook intake and delivery layer between third-party senders and the systems your team already runs. Use Kafka or another event bus for internal streaming when you need it; use Axel to accept external webhooks, preserve their payloads, route them, and recover failed deliveries.",
  },
];

/* ---------- copy content ---------- */

const features: Array<{ title: string; body: string; icon: string }> = [
  {
    icon: "↯",
    title: "Store the payload before returning 202",
    body: "Axel persists an accepted event's original payload before acknowledging the sender. Delivery happens asynchronously, so a slow or unavailable destination does not hold the sender open.",
  },
  {
    icon: "↺",
    title: "Replay any event from the dashboard or CLI",
    body: "`axel replay evt_…` pulls the exact bytes we stored and sends them to your dev server. Debug with the real payload, not a made-up test event.",
  },
  {
    icon: "◉",
    title: "Data Contracts from your real traffic",
    body: "Point Axel at a source and it learns the schema for each event type from real events. Drift detection flags new fields, type changes, and sensitive data before they break your database.",
  },
  {
    icon: "↦",
    title: "Filters and transforms with declarative rules",
    body: "Routing is configuration, not code: match event types, pick and reshape fields, or pass the raw payload straight through. The same rules behave the same way everywhere they run.",
  },
  {
    icon: "▤",
    title: "An inbox for failed deliveries",
    body: "Failed deliveries land in an inbox with one-click Retry and Mute. No digging through database tables or juggling extra dashboards during an incident.",
  },
  {
    icon: "◐",
    title: "Search event activity from one timeline",
    body: "Arrivals, routing decisions, transforms, and delivery attempts are searchable for 30 days. Inspect retained payloads, headers, and failure reasons without leaving the event view.",
  },
];

const sourceIntegrations: Array<{ name: string; detail: string; kind: string }> = [
  { name: "Webhook endpoint", detail: "Receive events from any product, verified with a token.", kind: "Realtime" },
  { name: "Custom HMAC", detail: "Verify signatures using a shared secret for any sender.", kind: "Custom" },
];

const destinationIntegrations: Array<{ name: string; detail: string; kind: string }> = [
  { name: "Signed webhook", detail: "Send signed POSTs with stable event IDs for receiver-side deduplication.", kind: "HTTP" },
  { name: "MongoDB", detail: "Write each event into Atlas or self-hosted collections.", kind: "Database" },
  { name: "Postgres", detail: "Insert payloads into JSONB or column-mapped tables.", kind: "Database" },
  { name: "S3", detail: "Write JSON objects or batched Parquet with route-level key templates.", kind: "Storage" },
  { name: "Cloudflare R2", detail: "Land payloads in Axel-managed R2 storage — no credentials needed.", kind: "Storage" },
  { name: "Databricks", detail: "Drop JSON files into Unity Catalog Volumes for Auto Loader.", kind: "Lakehouse" },
  { name: "BigQuery", detail: "Stream events into warehouse-native nested RECORD schemas by default.", kind: "Warehouse" },
];

export default function Page() {
  return (
    <main>
      <JsonLd data={[softwareApplicationLd(), faqPageLd(homeFaqs), breadcrumbLd([{ name: "Home", path: "/" }])]} />
      <SiteHeader />

      <section className="hero">
        <div className="container heroInner">
          <div>
            <a className="heroBadge" href={LICENSE_URL}>
              <strong>Apache-2.0</strong>
              Self-host it or start on Axel Cloud
            </a>
            <h1 className="heroTitle homeHeroTitle">
              Open-source webhook delivery to <em>your data stack</em>.
            </h1>
            <p className="heroLede">
              Capture, route, and replay webhooks with Axel. Read the code and run it on
              your infrastructure, or create an Axel Cloud account and let us operate it.
              Your events land in the databases, warehouses, and services you already use.
            </p>
            <div className="heroActions">
              <a className="btn" href="https://app.axelapp.ai/signup">
                Start on Axel Cloud <span className="arrow">→</span>
              </a>
              <a className="btn ghost" href={SOURCE_URL}>View source <span className="arrow" aria-hidden="true">↗</span></a>
            </div>
            <div className="heroMeta">
              <span className="dot" aria-hidden="true" />
              10,000 accepted events each month free. No credit card.
            </div>
          </div>

          <DashboardMock variant="hero" />
        </div>
      </section>

      <section className="logosBand">
        <div className="container">
          <p>Where your webhooks can land</p>
          <div className="logosRow">
            <span>Postgres</span>
            <span>MongoDB</span>
            <span>Amazon S3</span>
            <span>Cloudflare R2</span>
            <span>Databricks</span>
            <span>BigQuery</span>
            <span>Signed webhook</span>
          </div>
        </div>
      </section>

      <section className="deployment" id="open-source" aria-labelledby="deployment-heading">
        <div className="container">
          <div className="sectionHead">
            <span className="kicker">Open source, with a cloud version</span>
            <h2 id="deployment-heading">Axel Cloud or your infrastructure.</h2>
            <p className="lede">The same application powers both. Choose who runs the infrastructure.</p>
          </div>
          <div className="deploymentGrid">
            <article className="deploymentOption">
              <span className="kicker">Apache-2.0</span>
              <h3>Self-host Axel</h3>
              <p>Run the application in your own accounts. Inspect the code, change it, and contribute improvements.</p>
              <ul>
                <li>Connectors, routing, retries, and replay included</li>
                <li>Docker and Cloudflare installation guide</li>
                <li>You manage hosting, backups, and upgrades</li>
              </ul>
              <div className="heroActions">
                <a className="btn ghost" href={SOURCE_URL}>View source on GitHub <span className="arrow" aria-hidden="true">↗</span></a>
                <a className="textLink" href={SELF_HOSTING_URL}>Self-hosting guide →</a>
              </div>
            </article>
            <article className="deploymentOption deploymentCloud">
              <span className="kicker">Managed by us</span>
              <h3>Axel Cloud</h3>
              <p>Create an account and send your first webhook. We operate the infrastructure, updates, and delivery monitoring.</p>
              <ul>
                <li>10,000 accepted events per month free</li>
                <li>30 days of searchable event and delivery history</li>
                <li>No infrastructure to deploy or maintain</li>
              </ul>
              <div className="heroActions">
                <a className="btn" href="https://app.axelapp.ai/signup">Create a cloud account <span className="arrow">→</span></a>
                <a className="textLink" href="/pricing">Cloud pricing →</a>
              </div>
            </article>
          </div>
        </div>
      </section>

      <section className="screens" id="screens">
        <div className="container">
          <div className="sectionHead">
            <span className="kicker">Product overview</span>
            <h2>See the webhook pipeline in one dashboard.</h2>
            <p className="lede">
              Live stats, delivery attempts, source breakdowns, and replay controls sit in one
              workspace. See when a source starts sending unexpected data, spot retries before
              they become permanent failures, and replay any event without leaving the dashboard.
            </p>
          </div>
          <DashboardMock variant="standalone" />
          <p className="integrationLaneNote">Dashboard shown with sample event data.</p>
        </div>
      </section>

      <section className="deepDive" id="pipeline">
        <div className="container deepDiveGrid">
          <div className="deepDiveCopy">
            <span className="kicker">Event trace</span>
            <h2>Trace an event from acceptance to delivery.</h2>
            <p className="lede">
              Open any event to see when it arrived, how it was stored, routed, and reshaped, and
              every delivery attempt. Then replay it from the dashboard, or pull the same bytes to
              your laptop with <code>axel replay evt_… --forward-to localhost:3000</code>.
            </p>
            <ul>
              <li>Inspect retained raw payloads and headers during the replay window</li>
              <li>See each recorded delivery attempt, retry, and failure reason</li>
              <li>Search 30 days of event activity</li>
              <li>One-command replay against your local dev server</li>
            </ul>
          </div>
          <PipelineMock />
        </div>
      </section>

      <section className="deepDive">
        <div className="container deepDiveGrid flip">
          <RouteMock />
          <div className="deepDiveCopy">
            <span className="kicker">Routes</span>
            <h2>Route and reshape with declarative rules.</h2>
            <p className="lede">
              Match by event type, then reshape each payload with field rules: pick the
              fields you want, pass the body through untouched, or store it as one JSON column.{" "}
              <strong>Retries reuse a stable event ID so destinations have a key for deduplication.</strong>
            </p>
            <ul>
              <li>Filter and reshape with declarative rules — no custom code to run</li>
              <li>The same rules behave the same way everywhere they run</li>
              <li>Fan one accepted event out to multiple configured destinations</li>
              <li>Per-route metrics and failure reasons in the dashboard</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="deepDive">
        <div className="container deepDiveGrid">
          <div className="deepDiveCopy">
            <span className="kicker">Data Contracts</span>
            <h2>Webhook schemas discovered from real traffic.</h2>
            <p className="lede">
              Point Axel at a webhook source and it learns the event types, fields, and data types
              from real traffic — and spots fields that look sensitive. When a provider changes its
              payloads, Axel flags it before your database breaks.
            </p>
            <ul>
              <li>Auto-discovered schemas per source, versioned and exportable</li>
              <li>Drift checks every 5 minutes: new types, missing fields, type changes, new sensitive fields</li>
              <li>Resolve, mute, or refresh a contract without rewriting downstream schemas</li>
              <li>Export to TypeScript types or JSON Schema for your downstream code</li>
            </ul>
          </div>
          <SourceMock />
        </div>
      </section>

      <section className="integrations" id="integrations">
        <div className="container">
          <div className="sectionHead">
            <span className="kicker">Integrations</span>
            <h2>One endpoint in. Your configured destinations out.</h2>
            <p className="lede">
              Send webhooks from any product to a single endpoint. Use token auth or your own HMAC
              signatures, then deliver to the databases, storage, warehouses, and HTTP services your team already runs.
            </p>
          </div>

          <div className="integrationFlow">
            <section className="integrationStage integrationSources" aria-labelledby="source-integrations">
              <div className="integrationLaneHead">
                <span className="integrationLaneIndex" aria-hidden="true">01</span>
                <h3 id="source-integrations">Sources</h3>
                <span className="integrationLaneCount">In</span>
              </div>
              <div className="integrationList">
                {sourceIntegrations.map((item) => (
                  <article className="integrationItem" key={item.name}>
                    <div className="integrationMark" aria-hidden="true">
                      {item.name.slice(0, 1)}
                    </div>
                    <div className="integrationBody">
                      <div className="integrationTitle">
                        <strong>{item.name}</strong>
                        <span>{item.kind}</span>
                      </div>
                      <p>{item.detail}</p>
                    </div>
                  </article>
                ))}
              </div>
              <p className="integrationLaneNote">
                <span aria-hidden="true">+</span>
                Use the generic webhook endpoint with token auth or custom HMAC for any product that sends webhooks.
              </p>
            </section>

            <div className="integrationRail integrationRailIn" aria-hidden="true" />

            <section className="integrationStage integrationProcess" aria-labelledby="process-integrations">
              <div className="integrationLaneHead">
                <span className="integrationLaneIndex" aria-hidden="true">02</span>
                <h3 id="process-integrations">Axel</h3>
                <span className="integrationLaneCount">Route</span>
              </div>
              <div className="integrationProcessBody">
                <p>
                  Axel stores each accepted event and returns 202, then matches it against your
                  routes, reshapes it with field rules, and fans it out to every configured
                  destination.
                </p>
                <ul className="integrationProcessSteps">
                  <li>Store + 202</li>
                  <li>Match routes</li>
                  <li>Transform</li>
                  <li>Fan out</li>
                  <li>Retry</li>
                </ul>
              </div>
            </section>

            <div className="integrationRail integrationRailOut" aria-hidden="true" />

            <section className="integrationStage integrationDestinations" aria-labelledby="destination-integrations">
              <div className="integrationLaneHead">
                <span className="integrationLaneIndex" aria-hidden="true">03</span>
                <h3 id="destination-integrations">Destinations</h3>
                <span className="integrationLaneCount">Out</span>
              </div>
              <div className="integrationList">
                {destinationIntegrations.map((item) => (
                  <article className="integrationItem" key={item.name}>
                    <div className="integrationMark" aria-hidden="true">
                      {item.name.slice(0, 1)}
                    </div>
                    <div className="integrationBody">
                      <div className="integrationTitle">
                        <strong>{item.name}</strong>
                        <span>{item.kind}</span>
                      </div>
                      <p>{item.detail}</p>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </div>
        </div>
      </section>

      <section className="feature" id="why">
        <div className="container">
          <div className="sectionHead">
            <span className="kicker">Why teams build on Axel</span>
            <h2>Webhook intake, routing, and recovery in one product.</h2>
            <p className="lede">
              Axel brings event capture, routing, transforms, monitoring, replay, and failure
              handling into one product for engineering, platform, and data teams.
            </p>
          </div>

          <div className="featureGrid">
            {features.map((f) => (
              <article className="featureCard" key={f.title}>
                <span className="icon" aria-hidden="true">{f.icon}</span>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="operate" id="faq">
        <div className="container">
          <div className="sectionHead">
            <span className="kicker">FAQ</span>
            <h2>What is Axel, and how does it sync webhooks?</h2>
          </div>
          <div className="faqGrid">
            {homeFaqs.map((item) => (
              <article className="faqCard" key={item.q}>
                <h3>{item.q}</h3>
                <p>{item.a}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="cta">
        <div className="container">
          <div className="ctaInner">
            <h2>Send one webhook. Keep its delivery history.</h2>
            <p>
              Use Axel Cloud and leave the infrastructure, updates, and delivery monitoring
              to us. Start free, then upgrade as your traffic grows.
            </p>
            <div className="heroActions">
              <a className="btn" href="https://app.axelapp.ai/signup">
                Start on Axel Cloud <span className="arrow">→</span>
              </a>
              <a className="btn ghost" href={SOURCE_URL}>
                View source on GitHub
              </a>
            </div>
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
