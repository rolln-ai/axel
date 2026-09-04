import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter, SiteHeader } from "../_components/SiteChrome";
import { JsonLd } from "../_components/JsonLd";
import { pageMetadata } from "../../lib/seo";
import { breadcrumbLd, type FaqItem, faqPageLd } from "../../lib/structured-data";

const securityFaqs: FaqItem[] = [
  {
    q: "Is Axel secure?",
    a: "Axel uses TLS 1.2 or newer at the edge, encrypts raw R2 objects at rest, stores source ingest tokens as SHA-256 hashes, scopes data access by workspace_id, and evaluates declarative route rules without eval.",
  },
  {
    q: "Is Axel SOC 2 compliant?",
    a: "Axel is in a SOC 2 Type I observation period, with the Type I report planned for Q3 2026 and SOC 2 Type II plus ISO 27001 targeted for 2027. Current product controls include edge TLS, source-token hashing, workspace scoping, and outbound request guards.",
  },
  {
    q: "How does Axel handle and store my data?",
    a: "By default, raw webhook payloads and event traces are retained for 30 days, dead letters for 90 days, replay-request records for 30 days, and audit logs for 365 days. Configurable ranges are 0–30 days for raw payloads, 1–365 for dead letters, 1–90 for replay requests, and 30–3,650 for audit logs.",
  },
  {
    q: "How is one customer's data isolated from another's?",
    a: "Postgres rows, object-storage keys, queue messages, and analytics records carry a workspace identifier. Dashboard and service queries require workspace scope, and authorization checks bind requests to the active workspace.",
  },
  {
    q: "What should my sender do if Axel is unavailable?",
    a: "Treat a missing 202 response as an unaccepted event and retry according to the sender's webhook policy. Axel only returns 202 after it has accepted and stored the original payload.",
  },
];

export const metadata: Metadata = pageMetadata({
  title: "Security",
  description:
    "How Axel handles tokens, payloads, and customer data: encryption, declarative route rules, retention, tenant scoping, and compliance roadmap.",
  path: "/security",
});

const promises: Array<{ title: string; body: string; stat: string }> = [
  {
    title: "Source tokens hashed at rest",
    body: "Axel stores custom-source ingest tokens as SHA-256 hashes and validates them with constant-time comparison. Custom sources require the x-axel-token request header, and Axel rejects source credentials in URL query parameters. Named-provider sources use the provider's signature or webhook Basic Auth instead of an Axel token.",
    stat: "SHA-256",
  },
  {
    title: "Raw payloads encrypted in transit and at rest",
    body: "The edge requires TLS 1.2 or newer. Cloudflare R2 encrypts raw payload objects at rest. Self-host operators remain responsible for encryption of their Docker host, backups, and any optional data stores.",
    stat: "TLS 1.2+",
  },
  {
    title: "Declarative route rules, not customer code",
    body: "Route filters and transforms use an eval-free declarative language. The router does not execute customer JavaScript or expose network, filesystem, or process primitives to route configuration.",
    stat: "no eval",
  },
  {
    title: "Tenant isolation by workspace_id",
    body: "Postgres rows, ClickHouse records, object keys, and queue messages carry workspace scope. Dashboard and service queries require the active workspace identifier.",
    stat: "workspace scoped",
  },
  {
    title: "Bounded payload retention",
    body: "Defaults are 30 days for raw payloads and event traces, 90 days for dead letters, 30 days for replay-request records, and 365 days for audit logs. Configurable ranges are documented below and enforced by scheduled drains.",
    stat: "30 days",
  },
  {
    title: "Audit records for administrative changes",
    body: "Axel records supported administrative changes such as workspace creation, member invitations and role changes, source lifecycle changes, destination changes, and replay requests. Each record includes an actor and timestamp.",
    stat: "actor + time",
  },
];

const roadmap: Array<{ when: string; title: string; status: "shipped" | "in-flight" | "planned" }> = [
  { when: "Shipped", title: "TLS edge, hashed tokens, declarative transforms, audit log", status: "shipped" },
  { when: "Shipped", title: "Per-source rate limits, body & depth caps, stable delivery IDs", status: "shipped" },
  { when: "Shipped", title: "Egress guards on every destination connector — private-network and SSRF targets rejected, including connection tests", status: "shipped" },
  { when: "Shipped", title: "Versioned signing secrets bound to their source, constant-time sign-in, fail-closed ingest", status: "shipped" },
  { when: "Shipped", title: "Automated CI checks and protected production deployment workflows", status: "shipped" },
  { when: "In flight", title: "Self-serve GDPR erasure for data-subject requests", status: "in-flight" },
  { when: "Q3 2026", title: "SOC 2 Type I report (in observation now)", status: "planned" },
  { when: "Q4 2026", title: "BYO-cloud option for regulated workloads", status: "planned" },
  { when: "2027", title: "SOC 2 Type II + ISO 27001", status: "planned" },
];

export default function SecurityPage() {
  return (
    <main>
      <JsonLd data={[faqPageLd(securityFaqs), breadcrumbLd([{ name: "Home", path: "/" }, { name: "Security", path: "/security" }])]} />
      <SiteHeader />

      <section className="hero securityHero">
        <div className="container">
          <span className="kicker">Security</span>
          <h1 className="heroTitle securityTitle">
            Built so the on-call engineer <em>sleeps through</em> the night.
          </h1>
          <p className="heroLede">
            Webhook traffic carries some of the most sensitive data in your stack — payment events, identity changes,
            access grants. Axel is engineered like the systems your security team is already comfortable with.
          </p>
          <div className="heroActions">
            <a className="btn" href="mailto:security@axelapp.ai">
              Request security review <span className="arrow">→</span>
            </a>
            <Link className="btn ghost" href="/docs">
              Read the docs
            </Link>
          </div>
        </div>
      </section>

      <section className="frontier" id="promises">
        <div className="container">
          <div className="sectionHead">
            <span className="kicker">Implemented controls</span>
            <h2>Security controls in the product today.</h2>
            <p className="lede">
              The controls below are implemented in the current product. Planned certifications
              and additional controls are listed separately on the roadmap.
            </p>
          </div>
          <div className="frontierGrid securityGrid">
            {promises.map((card) => (
              <article className="frontierCard" key={card.title}>
                <h3>{card.title}</h3>
                <p>{card.body}</p>
                <span className="stat">{card.stat}</span>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="operate">
        <div className="container">
          <div className="operateGrid">
            <div>
              <span className="kicker">Roadmap</span>
              <h2>The compliance work, sequenced honestly.</h2>
              <p className="lede">
                We&apos;d rather you see the plan than a logo soup. Here&apos;s where the security work sits today, and where
                it&apos;s going next.
              </p>
            </div>
            <ul className="checklist roadmapList">
              {roadmap.map((item) => (
                <li key={item.title} data-status={item.status}>
                  <div>
                    <small className="roadmapWhen">{item.when}</small>
                    <strong>{item.title}</strong>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="operate" id="faq">
        <div className="container">
          <div className="sectionHead">
            <span className="kicker">FAQ</span>
            <h2>Is Axel secure, and how is my data handled?</h2>
          </div>
          <div className="faqGrid">
            {securityFaqs.map((item) => (
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
            <h2>Have a security question?</h2>
            <p>
              We respond to security@axelapp.ai within one business day. Vulnerability reports get a same-day
              acknowledgement and a fix or mitigation timeline within 72 hours.
            </p>
            <div className="heroActions">
              <a className="btn" href="mailto:security@axelapp.ai">
                Email security@axelapp.ai <span className="arrow">→</span>
              </a>
              <Link className="btn ghost" href="/pricing">
                Pricing
              </Link>
            </div>
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
