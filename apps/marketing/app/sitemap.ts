import type { MetadataRoute } from "next";
import { SITE_URL } from "../lib/seo";

/**
 * Static list of public routes. Keep in sync with the app/ route folders; the
 * SEO benchmark cross-checks every crawled route against this sitemap.
 */
const ROUTES: Array<{ path: string; priority: number; changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"] }> = [
  { path: "/", priority: 1.0, changeFrequency: "weekly" },
  { path: "/pricing", priority: 0.9, changeFrequency: "weekly" },
  { path: "/docs", priority: 0.9, changeFrequency: "weekly" },
  { path: "/security", priority: 0.7, changeFrequency: "monthly" },
  { path: "/legal", priority: 0.4, changeFrequency: "monthly" },
  { path: "/terms", priority: 0.3, changeFrequency: "yearly" },
  { path: "/privacy", priority: 0.3, changeFrequency: "yearly" },
  { path: "/dpa", priority: 0.3, changeFrequency: "yearly" },
  { path: "/subprocessors", priority: 0.3, changeFrequency: "yearly" },
  { path: "/acceptable-use", priority: 0.3, changeFrequency: "yearly" },
  { path: "/cookies", priority: 0.3, changeFrequency: "yearly" },
];

export default function sitemap(): MetadataRoute.Sitemap {
  return ROUTES.map(({ path, priority, changeFrequency }) => ({
    url: path === "/" ? SITE_URL : `${SITE_URL}${path}`,
    changeFrequency,
    priority,
  }));
}
