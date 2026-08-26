import { readFileSync } from "node:fs";
import { join } from "node:path";

export type LegalSlug =
  | "terms"
  | "privacy"
  | "acceptable-use"
  | "dpa"
  | "subprocessors"
  | "cookies";

export interface LegalMeta {
  title: string;
  slug: LegalSlug;
  version: string;
  effectiveDate: string;
  lastUpdated: string;
  summary: string;
}

export interface LegalDocContent {
  meta: LegalMeta;
  body: string;
}

// Drives the legal index, the in-page sidebar nav order, and which routes exist.
export const LEGAL_DOCS: Array<{ slug: LegalSlug; title: string; nav: string }> = [
  { slug: "terms", title: "Terms of Service", nav: "Terms of Service" },
  { slug: "privacy", title: "Privacy Policy", nav: "Privacy Policy" },
  { slug: "acceptable-use", title: "Acceptable Use Policy", nav: "Acceptable Use" },
  { slug: "dpa", title: "Data Processing Addendum", nav: "Data Processing (DPA)" },
  { slug: "subprocessors", title: "Sub-processors", nav: "Sub-processors" },
  { slug: "cookies", title: "Cookie Policy", nav: "Cookie Policy" },
];

const CONTENT_DIR = join(process.cwd(), "content", "legal");

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    meta[key] = val;
  }
  return { meta, body: match[2] ?? raw };
}

export function getLegalDoc(slug: string): LegalDocContent | null {
  const entry = LEGAL_DOCS.find((d) => d.slug === slug);
  if (!entry) return null;
  let raw: string;
  try {
    raw = readFileSync(join(CONTENT_DIR, `${slug}.md`), "utf8");
  } catch {
    return null;
  }
  const { meta, body } = parseFrontmatter(raw);
  // The page renders the title + version line in a styled header, so strip the
  // duplicate leading H1 and the "**Version … — Effective …**" line from the body.
  const trimmed = body
    .replace(/^\s*#\s+.*\r?\n+/, "")
    .replace(/^\s*\*\*Version[^\n]*\*\*\s*\r?\n+/, "");
  return {
    meta: {
      title: meta.title ?? entry.title,
      slug: entry.slug,
      version: meta.version ?? "",
      effectiveDate: meta.effectiveDate ?? "",
      lastUpdated: meta.lastUpdated ?? "",
      summary: meta.summary ?? "",
    },
    body: trimmed,
  };
}
