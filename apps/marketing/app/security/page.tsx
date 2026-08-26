import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter, SiteHeader } from "../_components/SiteChrome";
import { JsonLd } from "../_components/JsonLd";
import { pageMetadata } from "../../lib/seo";
import { breadcrumbLd, type FaqItem, faqPageLd } from "../../lib/structured-data";

const securityFaqs: FaqItem[] = [
  {
    q: "Is Axel secure?",
    a: "Axel encrypts payloads in transit (TLS 1.2+) and at rest, stores ingest tokens as SHA-256 hashes, scopes data access by workspace_id, evaluates only declarative route rules, and records privileged actions in an append-only audit log.",
  },
  {
    q: "Is Axel SOC 2 compliant?",
    a: "Axel is in a SOC 2 Type I observation period, with the Type I report planned for Q3 2026 and SOC 2 Type II plus ISO 27001 targeted for 2027. The underlying controls — encryption, tenant isolation, audit logging, and egress guards — are already in place.",
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
    title: "Tokens never stored in plaintext",
    body: "Source ingest tokens are stored as SHA-256 hashes. Validation is constant-time. Tokens are never written to logs or audit trails — only their hash prefix.",
    stat: "SHA-256",
  },
  {
    title: "Payloads encrypted in transit & at rest",
    body: "TLS 1.2+ on the edge. Cloudflare R2 encrypts every object at rest. ClickHouse logs are stored in customer-managed encryption keys when self-hosted.",
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
    title: "Audit log on every privileged action",
    body: "Workspace creation, member invites, role changes, source mutations and destination writes are all recorded with actor + timestamp in an append-only audit log.",
    stat: "append-only",
  },
];

const roadmap: Array<{ when: string; title: string; status: "shipped" | "in-flight" | "planned" }> = [
  { when: "Shipped", title: "TLS edge, hashed tokens, declarative transforms, audit log", status: "shipped" },
  { when: "Shipped", title: "Per-source rate limits, body & depth caps, stable delivery IDs", status: "shipped" },
  { when: "Shipped", title: "Egress guards on every destination connector — private-network and SSRF targets rejected, including connection tests", status: "shipped" },
  { when: "Shipped", title: "Versioned signing secrets bound to their source, constant-time sign-in, fail-closed ingest", status: "shipped" },
  { when: "Shipped", title: "Release gate: every version passes a deterministic check suite plus an adversarial audit before deploy", status: "shipped" },
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
