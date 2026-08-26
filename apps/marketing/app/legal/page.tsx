import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter, SiteHeader } from "../_components/SiteChrome";
import { getLegalDoc, LEGAL_DOCS } from "../../lib/legal";
import { JsonLd } from "../_components/JsonLd";
import { pageMetadata } from "../../lib/seo";
import { breadcrumbLd } from "../../lib/structured-data";

export const metadata: Metadata = pageMetadata({
  title: "Legal",
  description: "Axel's Terms of Service, Privacy Policy, Acceptable Use Policy, Data Processing Addendum, Sub-processors, and Cookie Policy.",
  path: "/legal",
});

export default function LegalIndexPage() {
  const docs = LEGAL_DOCS.map((d) => ({ ...d, meta: getLegalDoc(d.slug)?.meta }));
  return (
    <main>
      <JsonLd data={breadcrumbLd([{ name: "Home", path: "/" }, { name: "Legal", path: "/legal" }])} />
      <SiteHeader />

      <section className="hero legalHero">
        <div className="container">
          <span className="kicker">Legal</span>
          <h1 className="heroTitle legalTitle">Legal & policies</h1>
          <p className="heroLede legalSummary">
            The agreements that govern your use of Axel and how we handle data. Every document is versioned and
            dated.
          </p>
        </div>
      </section>

      <section className="legalBody">
        <div className="container">
          <div className="legalIndexGrid">
            {docs.map((d) => (
              <Link key={d.slug} className="legalIndexCard" href={`/${d.slug}`}>
                <h3>{d.title}</h3>
                {d.meta?.summary ? <p>{d.meta.summary}</p> : null}
                <span className="legalIndexMeta">
                  {d.meta?.version ? `Version ${d.meta.version}` : "Draft"}
                  {d.meta?.effectiveDate ? ` · Effective ${d.meta.effectiveDate}` : ""}
                </span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
