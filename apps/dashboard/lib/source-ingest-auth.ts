import type { SourceProvider } from "@axel/shared";

export function sourceProviderLabel(provider: SourceProvider): string {
  switch (provider) {
    case "stripe":
      return "Stripe";
    case "github":
      return "GitHub";
    case "shopify":
      return "Shopify";
    case "chargebee":
      return "Chargebee";
    case "custom":
      return "Custom";
  }
}

export function sourceUsesAxelToken(provider: SourceProvider): boolean {
  return provider === "custom";
}

export function sourceAuthHeaderExample(provider: SourceProvider): string {
  switch (provider) {
    case "stripe":
      return "Stripe-Signature: <Stripe-generated signature>";
    case "github":
      return "X-Hub-Signature-256: sha256=<GitHub-generated signature>";
    case "shopify":
      return "X-Shopify-Hmac-Sha256: <Shopify-generated signature>";
    case "chargebee":
      return "Authorization: Basic <Chargebee webhook credential>";
    case "custom":
      return "x-axel-token: YOUR_SOURCE_TOKEN";
  }
}

export function sourceAuthenticationCopy(provider: SourceProvider): string {
  if (provider === "custom") {
    return "Send the source token in the x-axel-token header. If your sender cannot set headers, generate a separate authenticated URL in the source's Settings tab.";
  }

  if (provider === "chargebee") {
    return "Chargebee authenticates each request with the HTTP Basic Auth credential configured for the webhook. Use the ingest URL as shown, without an Axel source token.";
  }

  return `${sourceProviderLabel(provider)} authenticates each request with its configured provider signature. Use the ingest URL as shown, without an Axel source token.`;
}

/** Only a separately generated URL token may be embedded, never a header token. */
export function sourceAuthenticatedUrl(ingestUrl: string, urlToken: string): string {
  if (!/^axu_[A-Za-z0-9_-]{43}$/.test(urlToken)) {
    throw new Error("A generated URL credential is required.");
  }
  const url = new URL(ingestUrl);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Use the clean ingest endpoint.");
  }
  url.searchParams.set("url_token", urlToken);
  return url.toString();
}
