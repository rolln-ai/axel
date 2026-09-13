import type { Metadata } from "next";
import { SECURITY_REPORT_URL, SOURCE_URL, SELF_HOSTING_URL } from "../../lib/project";
import Link from "next/link";
import { SiteFooter, SiteHeader } from "../_components/SiteChrome";
import { JsonLd } from "../_components/JsonLd";
import { pageMetadata } from "../../lib/seo";
import { breadcrumbLd, type FaqItem, faqPageLd } from "../../lib/structured-data";

const securityFaqs: FaqItem[] = [
  {
    q: "Which security controls does Axel use?",
    a: "Axel uses TLS 1.2 or newer at the edge, encrypts raw R2 objects at rest, stores source ingest tokens as SHA-256 hashes, checks data access against workspace membership, and runs route filters and transforms without executing customer JavaScript.",
  },
  {
    q: "Who can answer a compliance question?",
    a: "Email security@axelapp.ai with the requirements for your review. Ask for the documentation you need before relying on a certification or control. The product controls described here are not a certification report.",
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
    "How Axel handles tokens, payloads, and customer data: encryption, declarative route rules, retention, workspace access, and private vulnerability reporting.",
  path: "/security",
});

const controls: Array<{ title: string; body: string; stat: string }> = [
  {
    title: "Source tokens hashed at rest",
    body: "Axel stores custom-source ingest tokens as SHA-256 hashes and validates them with constant-time comparison. Custom sources use the x-axel-token header by default. Senders without custom headers can use a separately generated URL credential, enabled per source and rotated independently. Treat authenticated URLs as secrets; sender and proxy logs may record them. Named-provider sources use the provider's signature or webhook Basic Auth instead of an Axel token.",
    stat: "SHA-256",
  },
  {
    title: "Raw payloads encrypted in transit and at rest",
    body: "The edge requires TLS 1.2 or newer. Cloudflare R2 encrypts raw payload objects at rest. Self-host operators remain responsible for encryption of their Docker host, backups, and any optional data stores.",
    stat: "TLS 1.2+",
  },
  {
    title: "Route filters and transforms",
    body: "Route filters and transforms use an eval-free declarative language. Routes cannot execute customer JavaScript, read files, or start processes.",
    stat: "no eval",
  },
  {
    title: "Access scoped to your workspace",
    body: "Postgres rows, ClickHouse records, object keys, and queue messages carry workspace scope. Dashboard and service queries require the active workspace identifier.",
    stat: "workspace scoped",
  },
  {
    title: "Bounded payload retention",
    body: "Defaults are 30 days for raw payloads and event traces, 90 days for dead letters, 30 days for replay-request records, and 365 days for audit logs. Configurable ranges are documented below and applied by scheduled cleanup jobs. The small self-host profile uses fixed 30-day raw retention.",
    stat: "30 days",
  },
  {
    title: "Audit records for administrative changes",
    body: "Axel records supported administrative changes such as workspace creation, member invitations and role changes, source lifecycle changes, destination changes, and replay requests. Each record includes an actor and timestamp.",
    stat: "actor + time",
  },
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
            How Axel protects <em>your webhook data</em>.
          </h1>
          <p className="heroLede">
            Review how Axel authenticates senders, limits data access, and retains payloads.
            The implementation and security policy are public. Vulnerability reports stay private.
          </p>
          <div className="heroActions">
            <a className="btn" href={SECURITY_REPORT_URL}>
              Report a vulnerability privately <span className="arrow">→</span>
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
              These controls cover source authentication, storage, route execution, and administrative access.
              Self-host operators also manage the security of their host and provider accounts.
            </p>
          </div>
          <div className="frontierGrid securityGrid">
            {controls.map((card) => (
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
              <span className="kicker">Review the implementation</span>
              <h2>Read the code and operating instructions.</h2>
              <p className="lede">
                Use the security policy to report a vulnerability. The review record documents
                past findings and fixes; the self-hosting guide covers deployment requirements.
              </p>
            </div>
            <ul className="checklist roadmapList">
              <li><a href={`${SOURCE_URL}/blob/main/SECURITY.md`}>Security policy and supported branches</a></li>
              <li><a href={`${SOURCE_URL}/blob/main/docs/security-review-2026-08.md`}>Security review findings and fixes</a></li>
              <li><a href={SELF_HOSTING_URL}>Self-hosting requirements and limitations</a></li>
              <li><a href={`${SOURCE_URL}/blob/main/docs/credential-rotation.md`}>Credential rotation procedures</a></li>
            </ul>
          </div>
        </div>
      </section>

      <section className="operate" id="faq">
        <div className="container">
          <div className="sectionHead">
            <span className="kicker">FAQ</span>
            <h2>Data handling questions</h2>
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
              Report vulnerabilities privately through GitHub or email security@axelapp.ai.
              Include the affected component, reproduction steps, and potential impact.
              Please keep credentials and customer payloads out of public issues.
            </p>
            <div className="heroActions">
              <a className="btn" href={SECURITY_REPORT_URL}>
                Report a vulnerability privately <span className="arrow">→</span>
              </a>
              <a className="btn ghost" href="mailto:security@axelapp.ai">
                Email security@axelapp.ai
              </a>
            </div>
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
