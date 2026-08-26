import {
  EMAIL_BRAND,
  appUrl,
  emailButton,
  emailEndpointPanel,
  emailHeading,
  emailLink,
  emailNote,
  emailParagraph,
  emailTextSignature,
  escapeHtml,
  ingestUrl,
  marketingUrl,
  renderBrandedEmail,
} from "./email-layout";

/**
 * The welcome email — sent once, when someone creates an account.
 *
 * Design notes, because email is not the web:
 *
 *  - It opens with the ENDPOINT, not a chart. This email used to lead with a
 *    bar chart of invented traffic (12,481 events, 99.98% success) shown to
 *    someone who had sent zero events. Even captioned as a preview it was
 *    decoration, and the voice guidelines ask for an artifact instead of an
 *    adjective. The request shape is the artifact: it is what the reader gets
 *    on the next screen, and it answers the question they actually have —
 *    "what do I paste into Stripe?"
 *  - The panel is built from a coloured table cell and live text, not an image
 *    and not SVG. Most clients block remote images by default and Gmail strips
 *    <svg>, so a screenshot would be an empty box for a large share of
 *    recipients.
 *  - Espresso appears twice — header bar and endpoint panel — so the brand
 *    carries through the body rather than sitting in a stripe at the top.
 */

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * A numbered step: copper badge, bold lead-in, then the detail. `body` is
 * trusted HTML.
 */
function step(n: number, title: string, body: string): string {
  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px"><tr>`,
    `<td width="30" valign="top" style="padding:2px 0 0">`,
    // Copper on a tint rather than grey-on-grey: the steps are the spine of
    // this email, so they get the brand colour and the CTA keeps the fill.
    `<div style="width:22px;height:22px;background:${EMAIL_BRAND.codeBg};border-radius:11px;text-align:center;font:600 12px/22px ${FONT};color:${EMAIL_BRAND.link}">${n}</div>`,
    `</td>`,
    `<td valign="top" style="font:15px/1.6 ${FONT};color:${EMAIL_BRAND.body}">`,
    `<strong style="color:${EMAIL_BRAND.heading}">${escapeHtml(title)}</strong> ${body}`,
    `</td>`,
    `</tr></table>`,
  ].join("");
}

export interface WelcomeEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * The ingest request a new source produces, with the ID and token left as
 * placeholders — exactly how the product prints it on the source page. Keep in
 * step with `SourceQuickView`.
 */
export function endpointLines(): string[] {
  return [
    `POST ${ingestUrl()}/in/<source-id>`,
    "x-axel-token: <token>",
    "content-type: application/json",
  ];
}

/**
 * Render the welcome email. `name` is optional — a blank or missing name falls
 * back to a greeting that doesn't look broken ("Welcome to Axel" rather than
 * "Hi ,").
 */
export function renderWelcomeEmail({ name }: { name?: string | null }): WelcomeEmail {
  const firstName = (name ?? "").trim().split(/\s+/)[0] ?? "";
  const heading = firstName ? `Hi ${firstName} — welcome to Axel` : "Welcome to Axel";
  const setupUrl = `${appUrl()}/setup`;
  const docsUrl = `${marketingUrl()}/docs`;

  const contentHtml = [
    emailHeading(heading),
    emailParagraph(
      "Axel sits between the services that send you webhooks and the systems you keep your data in. It stores the original payload before returning 202, then routes each event to your database, warehouse, object storage, or an HTTP endpoint.",
    ),
    emailEndpointPanel({
      label: "Your first source",
      lines: endpointLines(),
      caption: "Create a source and you get this endpoint, with the ID and token filled in.",
    }),
    emailParagraph(
      `<strong style="color:${EMAIL_BRAND.heading}">Three steps to your first event</strong>`,
    ),
    step(
      1,
      "Create a source.",
      "Give it a name. You get the URL above to paste into Stripe, GitHub, Shopify — anything that sends webhooks.",
    ),
    step(
      2,
      "Send an event.",
      "Point the provider at that URL, or send a test event from the dashboard. Axel confirms the moment it lands.",
    ),
    step(
      3,
      "Choose where it goes.",
      "Postgres, BigQuery, MongoDB, S3, or an HTTP endpoint. Events that arrived while you were setting up get delivered too.",
    ),
    emailButton(setupUrl, "Create your first source"),
    emailNote(
      `When a destination is down, Axel retries with backoff and keeps the original payload, so you can replay it once the destination is back. The ${emailLink(docsUrl, "docs")} cover the details — or reply to this email, it reaches us.`,
    ),
  ].join("");

  const text = [
    heading,
    "",
    "Axel sits between the services that send you webhooks and the systems you keep your data in. It stores the original payload before returning 202, then routes each event to your database, warehouse, object storage, or an HTTP endpoint.",
    "",
    "Your first source:",
    "",
    ...endpointLines().map((line) => `  ${line}`),
    "",
    "Create a source and you get this endpoint, with the ID and token filled in.",
    "",
    "Three steps to your first event",
    "",
    "1. Create a source. Give it a name. You get the URL above to paste into Stripe, GitHub, Shopify - anything that sends webhooks.",
    "2. Send an event. Point the provider at that URL, or send a test event from the dashboard. Axel confirms the moment it lands.",
    "3. Choose where it goes. Postgres, BigQuery, MongoDB, S3, or an HTTP endpoint. Events that arrived while you were setting up get delivered too.",
    "",
    `Create your first source: ${setupUrl}`,
    "",
    `When a destination is down, Axel retries with backoff and keeps the original payload, so you can replay it once the destination is back. The docs (${docsUrl}) cover the details - or reply to this email, it reaches us.`,
    emailTextSignature(),
  ].join("\n");

  return {
    subject: "Welcome to Axel — your first event in three steps",
    html: renderBrandedEmail({
      preheader: "Create a source, send an event, choose where it lands.",
      contentHtml,
    }),
    text,
  };
}
