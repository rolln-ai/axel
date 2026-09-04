import { SITE_NAME, SITE_URL } from "./seo";
import { SUPPORT_EMAIL } from "./contact";

/**
 * schema.org builders. Keep claims factual and consistent with the visible
 * page content — AI answer engines cite these, and Google penalises FAQ schema
 * that doesn't match on-page text.
 */

const ORG_ID = `${SITE_URL}/#organization`;
const WEBSITE_ID = `${SITE_URL}/#website`;

export function organizationLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": ORG_ID,
    name: SITE_NAME,
    url: SITE_URL,
    logo: `${SITE_URL}/icon.svg`,
    description:
      "Axel captures third-party webhooks, stores their original payloads before returning 202, and delivers them to databases, warehouses, object storage, and HTTP endpoints.",
    ...(SUPPORT_EMAIL ? { email: SUPPORT_EMAIL } : {}),
  };
}

export function websiteLd() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": WEBSITE_ID,
    name: SITE_NAME,
    url: SITE_URL,
    publisher: { "@id": ORG_ID },
  };
}

export function softwareApplicationLd() {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: SITE_NAME,
    url: SITE_URL,
    applicationCategory: "DeveloperApplication",
    applicationSubCategory: "Webhook data sync",
    operatingSystem: "Web",
    description:
      "Capture third-party webhooks and deliver them to databases, warehouses, object storage, and HTTP endpoints with retries, delivery history, and replay controls.",
    publisher: { "@id": ORG_ID },
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      description: "Free tier: receive 10,000 accepted inbound events per month.",
    },
    featureList: [
      "Store original webhook payloads before returning 202",
      "Delivery to Postgres, MongoDB, BigQuery, Databricks, S3/R2 object storage, and HTTP endpoints",
      "Replay retained original payloads",
      "Dead-letter inbox with operator-friendly actions",
      "Declarative routing and field transforms",
      "Stable event IDs for receiver-side deduplication",
      "Queryable event timelines",
    ],
  };
}

export interface FaqItem {
  q: string;
  a: string;
}

export function faqPageLd(items: FaqItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map(({ q, a }) => ({
      "@type": "Question",
      name: q,
      acceptedAnswer: { "@type": "Answer", text: a },
    })),
  };
}

export function howToLd(input: {
  name: string;
  description: string;
  path: string;
  steps: Array<{ name: string; text: string }>;
}) {
  return {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: input.name,
    description: input.description,
    url: `${SITE_URL}${input.path}`,
    step: input.steps.map(({ name, text }, i) => ({
      "@type": "HowToStep",
      position: i + 1,
      name,
      text,
    })),
  };
}

export function legalArticleLd(input: {
  title: string;
  description?: string;
  path: string;
  effectiveDate?: string;
  lastUpdated?: string;
}) {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: input.title,
    ...(input.description ? { description: input.description } : {}),
    url: `${SITE_URL}${input.path}`,
    ...(input.effectiveDate ? { datePublished: input.effectiveDate } : {}),
    ...(input.lastUpdated || input.effectiveDate
      ? { dateModified: input.lastUpdated ?? input.effectiveDate }
      : {}),
    publisher: { "@id": ORG_ID },
  };
}

export function breadcrumbLd(crumbs: Array<{ name: string; path: string }>) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map(({ name, path }, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name,
      item: path === "/" ? SITE_URL : `${SITE_URL}${path}`,
    })),
  };
}
