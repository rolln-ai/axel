import type { Metadata } from "next";

/**
 * Single source of truth for the marketing site's canonical origin and the
 * per-page metadata Search engines + AI answer engines read. `app/page.tsx`
 * gets its metadata from the root layout; every other route calls
 * {@link pageMetadata} so canonical, Open Graph, and Twitter tags stay
 * consistent. The shared OG image is provided globally by
 * `app/opengraph-image.tsx` (file convention overrides config-based images).
 */
export const SITE_URL = "https://axelapp.ai";
export const SITE_NAME = "Axel";
export const TITLE_SUFFIX = "Axel";
/** X/Twitter handle for card attribution (site + creator). */
export const TWITTER_HANDLE = "@axelappai";

interface PageMeta {
  /** Title WITHOUT the brand suffix — the layout template appends "— Axel". */
  title: string;
  description: string;
  /** Route path, e.g. "/pricing" or "/". Used for the canonical + og:url. */
  path: string;
  /** Optional override for the social-card title (defaults to "<title> — Axel"). */
  ogTitle?: string;
}

/**
 * Path of the global OG image route (app/opengraph-image.tsx). Referenced
 * explicitly because Next shallow-merges metadata per segment: a page that
 * exports its own `openGraph` would otherwise drop the file-convention image.
 */
const OG_IMAGE = {
  url: "/opengraph-image",
  width: 1200,
  height: 630,
  alt: "Axel — open-source webhook delivery, available on Axel Cloud or your infrastructure",
};

export function pageMetadata({ title, description, path, ogTitle }: PageMeta): Metadata {
  const url = path === "/" ? SITE_URL : `${SITE_URL}${path}`;
  const social = ogTitle ?? `${title} — ${TITLE_SUFFIX}`;
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      url,
      siteName: SITE_NAME,
      title: social,
      description,
      locale: "en_US",
      images: [OG_IMAGE],
    },
    twitter: {
      card: "summary_large_image",
      site: TWITTER_HANDLE,
      creator: TWITTER_HANDLE,
      title: social,
      description,
      images: [OG_IMAGE.url],
    },
  };
}
