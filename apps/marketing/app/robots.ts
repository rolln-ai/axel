import type { MetadataRoute } from "next";
import { SITE_URL } from "../lib/seo";

/**
 * Allow every crawler — including AI answer-engine fetchers (GPTBot,
 * PerplexityBot, ClaudeBot, Google-Extended) which we WANT indexing us for GEO.
 * Only the PostHog reverse-proxy path is disallowed to keep crawl budget on
 * real content.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/ingest/"] }],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
