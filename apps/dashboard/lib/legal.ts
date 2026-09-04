// Clickwrap consent — the single source of truth for which legal documents a
// user agrees to at signup and at what version. The signup form renders links
// from here; signUp() records the accepted version bundle in terms_acceptances
// (migration 0051). Bump CURRENT_TERMS_VERSION + EFFECTIVE_DATE whenever the
// substance of any covered document changes, so re-acceptance can be detected.

// The legal documents are published on the marketing site. Override the base in
// non-prod via NEXT_PUBLIC_AXEL_MARKETING_URL.
const MARKETING_BASE = (process.env.NEXT_PUBLIC_AXEL_MARKETING_URL ?? "https://axelapp.ai").replace(/\/$/, "");

export const CURRENT_TERMS_VERSION = "1.1";
export const TERMS_EFFECTIVE_DATE = "2026-09-03";

/**
 * The documents a user affirmatively agrees to when they check the signup
 * consent box. Keep this list in sync with the checkbox label in SignupForm.
 */
export const CONSENT_DOCUMENTS = [
  { slug: "terms", title: "Terms of Service", version: "1.1", href: `${MARKETING_BASE}/terms` },
  {
    slug: "acceptable-use",
    title: "Acceptable Use Policy",
    version: "1.1",
    href: `${MARKETING_BASE}/acceptable-use`,
  },
  { slug: "privacy", title: "Privacy Policy", version: "1.1", href: `${MARKETING_BASE}/privacy` },
] as const;

/**
 * The { slug: version } map persisted on each acceptance, so we can later prove
 * exactly which document versions a user agreed to even after the docs change.
 */
export function acceptedDocumentVersions(): Record<string, string> {
  return Object.fromEntries(CONSENT_DOCUMENTS.map((doc) => [doc.slug, doc.version]));
}
