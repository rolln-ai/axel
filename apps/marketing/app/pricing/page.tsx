import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter, SiteHeader } from "../_components/SiteChrome";
import { JsonLd } from "../_components/JsonLd";
import { pageMetadata } from "../../lib/seo";
import { breadcrumbLd, faqPageLd } from "../../lib/structured-data";
import { PricingEstimator } from "./PricingEstimator";

export const metadata: Metadata = pageMetadata({
  title: "Pricing",
  description:
    "Axel Cloud starts free. Pro is $20/month applied as usage credit. Managed infrastructure, delivery monitoring, and searchable history.",
  path: "/pricing",
});

interface Tier {
  name: string;
  price: string;
  cadence?: string;
  blurb: string;
  highlights: string[];
  cta: { label: string; href: string };
  featured?: boolean;
  badge?: string;
}

const tiers: Tier[] = [
  {
    name: "Free",
    price: "$0",
    cadence: "no credit card",
    blurb: "For development, test webhooks, and sources with up to 10,000 events a month.",
    highlights: [
      "10,000 accepted inbound events / month included",
      "Webhook ingest with Postgres, Mongo, BigQuery, R2, S3, and HTTP destinations",
      "Declarative filters & transforms",
      "30-day event search in ClickHouse",
      "Community support",
    ],
    cta: { label: "Sign up free", href: "https://app.axelapp.ai/signup?ref=website" },
    badge: "start here",
  },
  {
    name: "Pro",
    price: "$20",
    cadence: "monthly credit",
    blurb: "Your $20 payment covers the first $20 of usage each month. Pay for additional events at the same rate.",
    highlights: [
      "$20 monthly usage credit included",
      "$0.015 per 1,000 accepted inbound events, or $15 per million",
      "Destination pushes are included",
      "Retries are included",
      "Per-source rate limits, body & depth caps",
      "p95 ingest < 250ms SLO",
    ],
    cta: { label: "Start on Pro", href: "https://app.axelapp.ai/signup?ref=website" },
    featured: true,
    badge: "usage credit",
  },
];

const faqs: Array<{ q: string; a: string }> = [
  {
    q: "Can I self-host Axel?",
    a: `Yes. Axel is Apache-2.0 software, including the connectors, routing, retries, and replay. Self-hosting has no Axel license fee. You run the Docker and Cloudflare infrastructure, backups, and upgrades. The small install omits ClickHouse; add it for event search and analytics. Cloud includes managed infrastructure and 30 days of searchable history.`,
  },
  {
    q: "What counts toward usage?",
    a: "Only accepted inbound events are metered. Rejected requests do not count.",
  },
  {
    q: "Are retries billed?",
    a: "No. Destination pushes and retries are included at no additional cost.",
  },
  {
    q: "Are destination pushes billed?",
    a: "No. You pay only for accepted inbound events, regardless of how many destination pushes they produce.",
  },
  {
    q: "What happens after the $20 credit?",
    a: "Usage continues at $0.015 per 1,000 accepted inbound events, or $15 per million. The dashboard shows received events, delivery activity, metered usage, and the estimated invoice before the month closes.",
  },
  {
    q: "Does unused monthly credit roll over?",
    a: "No. The $20 payment is the Pro plan minimum and monthly usage credit. Any unused credit expires at the end of the billing month.",
  },
];

export default function PricingPage() {
  return (
    <main>
      <JsonLd data={[faqPageLd(faqs), breadcrumbLd([{ name: "Home", path: "/" }, { name: "Pricing", path: "/pricing" }])]} />
      <SiteHeader />

      <section className="hero pricingHero">
        <div className="container">
          <span className="kicker">Axel Cloud pricing</span>
          <h1 className="heroTitle pricingTitle">
            Start free. <em>$20 in monthly usage credit</em> on Pro.
          </h1>
          <p className="heroLede">
            Start with 10,000 accepted inbound events free each month. Upgrade for more traffic. On Pro, your $20 monthly payment becomes usage credit, then accepted
            inbound events are metered at $0.015 per 1,000.
          </p>
        </div>
      </section>

      <section className="band tiersBand">
        <div className="container">
          <div className="tierGrid">
            {tiers.map((tier) => (
              <article className={`tierCard${tier.featured ? " featured" : ""}`} key={tier.name}>
                <div className="tierHead">
                  <h2>{tier.name}</h2>
                  {tier.badge ? <span className="tierBadge">{tier.badge}</span> : null}
                </div>
                <div className="tierPrice">
                  <strong>{tier.price}</strong>
                  {tier.cadence ? <span>{tier.cadence}</span> : null}
                </div>
                <p className="tierBlurb">{tier.blurb}</p>
                <ul className="tierList">
                  {tier.highlights.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                <a className={`btn${tier.featured ? "" : " ghost"} tierCta`} href={tier.cta.href}>
                  {tier.cta.label} <span className="arrow">→</span>
                </a>
              </article>
            ))}
          </div>
        </div>
      </section>

      <PricingEstimator />

      <section className="feature" id="self-hosting">
        <div className="container">
          <div className="sectionHead">
            <span className="kicker">Cloud and self-hosting</span>
            <h2>Pay us to run it. Or run it yourself.</h2>
            <p className="lede">
              Cloud runs the same application code available under Apache-2.0. Your subscription
              covers managed infrastructure, updates, delivery monitoring, and searchable history.
              Self-hosting has no Axel license fee; you operate the stack and pay your providers.
            </p>
            <div className="heroActions">
              <a className="btn" href="https://app.axelapp.ai/signup?ref=website">Start on Axel Cloud <span className="arrow">→</span></a>
              <Link className="btn ghost" href="/docs#self-hosting">Self-hosting guide</Link>
            </div>
          </div>
        </div>
      </section>

      <section className="feature">
        <div className="container">
          <div className="sectionHead">
            <span className="kicker">How metering works</span>
            <h2>One billing unit: accepted inbound events.</h2>
            <p className="lede">
              The dashboard shows events received, events pushed, byte volume, and per-source
              breakdowns. Only accepted inbound events count toward your bill.
            </p>
          </div>

          <div className="featureGrid meterGrid">
            <article className="featureCard">
              <span className="icon" aria-hidden="true">⌁</span>
              <h3>Counted at ingest</h3>
              <p>Each accepted inbound event counts once. Rate-limited and rejected requests do not count.</p>
            </article>
            <article className="featureCard">
              <span className="icon" aria-hidden="true">→</span>
              <h3>Destination pushes included</h3>
              <p>Initial pushes and delivery retries are included at no additional cost.</p>
            </article>
            <article className="featureCard">
              <span className="icon" aria-hidden="true">◐</span>
              <h3>Monthly credit first</h3>
              <p>Your $20 Pro payment covers about 1.33 million inbound events each month before usage charges appear.</p>
            </article>
          </div>
        </div>
      </section>

      <section className="operate">
        <div className="container">
          <div className="sectionHead">
            <span className="kicker">FAQ</span>
            <h2>Pricing questions</h2>
          </div>
          <div className="faqGrid">
            {faqs.map((item) => (
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
            <h2>Ship your first webhook today.</h2>
            <p>
              Start with 10,000 accepted events per month free. Upgrade to Pro when you need more.
            </p>
            <div className="heroActions">
              <a className="btn" href="https://app.axelapp.ai/signup?ref=website">
                Sign up free <span className="arrow">→</span>
              </a>
              <Link className="btn ghost" href="/docs">
                Read the docs
              </Link>
            </div>
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
