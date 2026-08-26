/**
 * Shared branded layout for every transactional email Axel sends.
 *
 * Email clients are not browsers: Gmail strips <svg> and <style>, Outlook uses
 * Word's rendering engine, and most clients block remote images by default. So
 * the rules here are deliberately conservative:
 *
 *   - One <table>-based, fixed-max-width shell (560px) — the only layout
 *     primitive that survives Outlook.
 *   - All styling inline; no <style> block, no class selectors.
 *   - The brand reads even with images OFF: the header wordmark "Axel" is LIVE
 *     TEXT on the espresso bar, and the logo glyph is a small <img> enhancement
 *     with empty alt so it never duplicates the wordmark when blocked.
 *   - A hidden preheader controls the inbox preview line instead of leaking the
 *     first body sentence.
 *
 * Every template builds its inner content with the helpers below
 * (`emailHeading`, `emailParagraph`, `emailButton`, …) and wraps it once with
 * `renderBrandedEmail`. `escapeHtml` lives here too so all call sites escape
 * user-controlled values (workspace names, member names, roles) the same way.
 */

/** Brand palette for email — light body, espresso header, copper/orange accents. */
export const EMAIL_BRAND = {
  espresso: "#1a1814",
  headerText: "#f0eee5",
  pageBg: "#f4f2ee",
  cardBg: "#ffffff",
  cardBorder: "#eceae4",
  footerBg: "#faf9f6",
  heading: "#1f1b16",
  body: "#403c35",
  muted: "#8a857c",
  /** Inline link colour — deeper orange for AA contrast on white. */
  link: "#c2410c",
  /**
   * Primary CTA background. This is the marketing site's `--primary-strong`
   * (#f5610f), not the brighter `--primary` (#ff7a3a): white text on #ff7a3a
   * fails AA, and email has no hover state to lean on.
   */
  buttonBg: "#f5610f",
  buttonText: "#ffffff",
  divider: "#eceae4",
  codeBg: "#f1efe9",
  /** Ink and accents for content sitting ON the espresso panel. */
  espressoInk: "#f0eee5",
  espressoMuted: "#a09e96",
  espressoBorder: "#312c24",
  /** The brighter `--primary`; only used on espresso, where it passes AA. */
  espressoAccent: "#ff7a3a",
} as const;

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

/**
 * The approved homepage headline, so an email footer says what the site says.
 * The previous line — "Webhook data sync that never loses an event" — is the
 * claim the product voice guidelines ban outright ("never", "no data loss"), and it
 * shipped at the bottom of all eleven transactional emails.
 */
const TAGLINE = "Capture webhooks and deliver them to your data stack";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

import { appBaseUrl } from "./app-url";

export function marketingUrl(): string {
  return process.env.NEXT_PUBLIC_AXEL_MARKETING_URL ?? "https://axelapp.ai";
}

export function appUrl(): string {
  return appBaseUrl();
}

/**
 * Base URL webhook senders post to. Same env var and default the dashboard and
 * setup flow use, so an endpoint printed in an email matches the one printed on
 * the source page. Trailing slash stripped so callers can append a path.
 */
export function ingestUrl(): string {
  return (process.env.NEXT_PUBLIC_AXEL_INGEST_URL ?? "https://ingest.axelapp.ai").replace(/\/$/, "");
}

/**
 * Hosted PNG of the hub-and-spoke mark (see apps/marketing/app/email-logo/route.tsx).
 * The asset is served immutable and email image proxies cache by URL, so bump
 * `v` whenever the mark's rendering changes (v2 = real wheel, was a plain disc).
 */
export function emailLogoUrl(): string {
  return `${marketingUrl()}/email-logo?v=2`;
}

/** A heading line for the body card. `text` is escaped. */
export function emailHeading(text: string): string {
  return `<h1 style="margin:0 0 12px;font:600 19px/1.35 ${FONT};color:${EMAIL_BRAND.heading};letter-spacing:-0.01em">${escapeHtml(text)}</h1>`;
}

/**
 * A body paragraph. The argument is treated as trusted HTML so callers can pass
 * inline markup (<strong>, <a>, <code>) — escape any user values first.
 */
export function emailParagraph(html: string): string {
  return `<p style="margin:0 0 16px;font:15px/1.6 ${FONT};color:${EMAIL_BRAND.body}">${html}</p>`;
}

/** A subdued note paragraph (e.g. "if you weren't expecting this…"). Trusted HTML. */
export function emailNote(html: string): string {
  return `<p style="margin:0 0 16px;font:14px/1.55 ${FONT};color:${EMAIL_BRAND.muted}">${html}</p>`;
}

/** An inline brand-coloured link. Both args escaped. */
export function emailLink(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}" style="color:${EMAIL_BRAND.link};text-decoration:underline">${escapeHtml(label)}</a>`;
}

/** Inline <code> snippet. `text` is escaped. */
export function emailCode(text: string): string {
  return `<code style="font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:${EMAIL_BRAND.codeBg};color:${EMAIL_BRAND.heading};padding:1px 5px;border-radius:4px">${escapeHtml(text)}</code>`;
}

/**
 * An espresso panel of monospaced lines — the shape of a request, an endpoint,
 * a header block. Use it to show the reader a real artifact from the product
 * instead of describing one.
 *
 * It is TEXT on a coloured table cell, never an image: clients block remote
 * images by default, so a screenshot of a terminal is an empty box for a large
 * share of recipients. The espresso fill is also the one place the brand's
 * bright `--primary` clears AA, so accents live here rather than on white.
 *
 * `label`, `lines`, and `caption` are all escaped — pass raw product strings.
 */
export function emailEndpointPanel({
  label,
  lines,
  caption,
}: {
  label?: string;
  lines: readonly string[];
  caption?: string;
}): string {
  const b = EMAIL_BRAND;
  const body = lines
    .map(
      (line) =>
        `<div style="font:13px/1.7 ${MONO};color:${b.espressoInk};white-space:nowrap">${escapeHtml(line)}</div>`,
    )
    .join("");
  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${b.espresso};border:1px solid ${b.espressoBorder};border-radius:10px;margin:0 0 20px">`,
    `<tr><td style="padding:16px 18px">`,
    label
      ? `<div style="margin:0 0 10px;font:600 11px/1.2 ${FONT};color:${b.espressoAccent};text-transform:uppercase;letter-spacing:0.06em">${escapeHtml(label)}</div>`
      : "",
    // Horizontal scroll rather than a wrapped line: a broken URL is worse than
    // a clipped one, and Outlook will not scroll but does clip cleanly.
    `<div style="overflow-x:auto">${body}</div>`,
    caption
      ? `<div style="margin:10px 0 0;font:12px/1.5 ${FONT};color:${b.espressoMuted}">${escapeHtml(caption)}</div>`
      : "",
    `</td></tr></table>`,
  ].join("");
}

/**
 * A bulletproof primary CTA button (table-wrapped so Outlook renders the fill).
 * `label` is escaped; `href` is escaped.
 */
export function emailButton(href: string, label: string): string {
  return [
    `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:4px 0 8px"><tr>`,
    `<td align="center" bgcolor="${EMAIL_BRAND.buttonBg}" style="border-radius:8px">`,
    `<a href="${escapeHtml(href)}" style="display:inline-block;padding:11px 22px;font:600 14px ${FONT};color:${EMAIL_BRAND.buttonText};text-decoration:none;border-radius:8px">${escapeHtml(label)}</a>`,
    `</td></tr></table>`,
  ].join("");
}

/**
 * Raw long-URL fallback for clients/users who can't click the button (escaped).
 * Use under a CTA so password-reset / invite links are always reachable.
 */
export function emailLinkFallback(href: string): string {
  return `<p style="margin:0 0 4px;font:12px/1.5 ${FONT};color:${EMAIL_BRAND.muted};word-break:break-all">Or paste this link into your browser:<br><a href="${escapeHtml(href)}" style="color:${EMAIL_BRAND.muted}">${escapeHtml(href)}</a></p>`;
}

export interface BrandedEmailOptions {
  /** Hidden inbox-preview line. Plain text; escaped. */
  preheader: string;
  /** Inner body HTML (already built from the helpers above). */
  contentHtml: string;
  /** Optional footer note above the brand line — trusted HTML (e.g. a manage-settings link). */
  footerNote?: string;
}

/** Wrap inner content in the full branded, client-safe HTML document. */
export function renderBrandedEmail({
  preheader,
  contentHtml,
  footerNote,
}: BrandedEmailOptions): string {
  const b = EMAIL_BRAND;
  const footer = [
    footerNote
      ? `<p style="margin:0 0 10px;font:12px/1.55 ${FONT};color:${b.muted}">${footerNote}</p>`
      : "",
    `<p style="margin:0;font:12px/1.55 ${FONT};color:${b.muted}">`,
    `<a href="${marketingUrl()}" style="color:${b.muted};text-decoration:none;font-weight:600">Axel</a>`,
    ` · ${TAGLINE}</p>`,
  ].join("");

  return [
    `<!doctype html>`,
    `<html lang="en"><head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<meta name="color-scheme" content="light">`,
    `<meta name="supported-color-schemes" content="light">`,
    `</head>`,
    `<body style="margin:0;padding:0;background:${b.pageBg};-webkit-text-size-adjust:100%">`,
    // Hidden preheader (controls the preview line; spacer chars stop the body bleeding in).
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0">${escapeHtml(preheader)}​ ​ ​ ​ ​ ​ ​ ​ </div>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${b.pageBg}"><tr>`,
    `<td align="center" style="padding:32px 16px">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%">`,
    // Header — espresso bar, logo glyph (img) + live-text wordmark.
    `<tr><td style="background:${b.espresso};border-radius:12px 12px 0 0;padding:18px 28px">`,
    `<a href="${marketingUrl()}" style="text-decoration:none;display:inline-block">`,
    `<img src="${emailLogoUrl()}" width="26" height="26" alt="" style="border:0;vertical-align:middle;display:inline-block">`,
    `<span style="vertical-align:middle;margin-left:10px;font:600 18px ${FONT};color:${b.headerText};letter-spacing:-0.01em">Axel</span>`,
    `</a>`,
    `</td></tr>`,
    // Body card.
    `<tr><td style="background:${b.cardBg};border:1px solid ${b.cardBorder};border-top:0;padding:28px">`,
    contentHtml,
    `</td></tr>`,
    // Footer.
    `<tr><td style="background:${b.footerBg};border:1px solid ${b.cardBorder};border-top:0;border-radius:0 0 12px 12px;padding:18px 28px">`,
    footer,
    `</td></tr>`,
    `</table>`,
    `</td></tr></table>`,
    `</body></html>`,
  ].join("");
}

/** Trailing signature block for the plain-text alternative — mirrors the footer. */
export function emailTextSignature(note?: string): string {
  return [
    "",
    "—",
    ...(note ? [note, ""] : []),
    `Axel · ${TAGLINE}`,
    marketingUrl(),
  ].join("\n");
}
