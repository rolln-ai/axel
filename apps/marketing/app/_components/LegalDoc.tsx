import Link from "next/link";
import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { SiteFooter, SiteHeader } from "./SiteChrome";
import { JsonLd } from "./JsonLd";
import { getLegalDoc, LEGAL_DOCS, type LegalSlug } from "../../lib/legal";
import { breadcrumbLd, legalArticleLd } from "../../lib/structured-data";

export function LegalDoc({ slug }: { slug: LegalSlug }) {
  const doc = getLegalDoc(slug);
  if (!doc) notFound();

  const updatedDiffers =
    doc.meta.lastUpdated && doc.meta.lastUpdated !== doc.meta.effectiveDate;

  return (
    <main>
      <JsonLd
        data={[
          legalArticleLd({
            title: doc.meta.title,
            description: doc.meta.summary,
            path: `/${slug}`,
            effectiveDate: doc.meta.effectiveDate,
            lastUpdated: doc.meta.lastUpdated,
          }),
          breadcrumbLd([
            { name: "Home", path: "/" },
            { name: "Legal", path: "/legal" },
            { name: doc.meta.title, path: `/${slug}` },
          ]),
        ]}
      />
      <SiteHeader />

      <section className="hero legalHero">
        <div className="container">
          <Link className="legalEyebrow" href="/legal">
            ← All legal documents
          </Link>
          <h1 className="heroTitle legalTitle">{doc.meta.title}</h1>
          {doc.meta.summary ? <p className="heroLede legalSummary">{doc.meta.summary}</p> : null}
          <p className="legalMeta">
            {doc.meta.version ? <>Version {doc.meta.version}</> : null}
            {doc.meta.effectiveDate ? <> · Effective {doc.meta.effectiveDate}</> : null}
            {updatedDiffers ? <> · Last updated {doc.meta.lastUpdated}</> : null}
          </p>
        </div>
      </section>

      <section className="legalBody">
        <div className="container legalLayout">
          <aside className="legalNav" aria-label="Legal documents">
            <span className="legalNavLabel">Legal</span>
            <ul>
              {LEGAL_DOCS.map((d) => (
                <li key={d.slug}>
                  <Link href={`/${d.slug}`} aria-current={d.slug === slug ? "page" : undefined}>
                    {d.nav}
                  </Link>
                </li>
              ))}
            </ul>
          </aside>
          <article className="legalProse">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.body}</ReactMarkdown>
          </article>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
