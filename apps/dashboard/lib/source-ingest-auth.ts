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
    return "Custom sources require the one-time source token in the x-axel-token request header. Axel rejects source credentials in URL query parameters.";
  }

  if (provider === "chargebee") {
    return "Chargebee authenticates each request with the HTTP Basic Auth credential configured for the webhook. Use the ingest URL as shown, without an Axel source token.";
  }

  return `${sourceProviderLabel(provider)} authenticates each request with its configured provider signature. Use the ingest URL as shown, without an Axel source token.`;
}
