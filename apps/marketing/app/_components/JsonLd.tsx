/**
 * Renders a schema.org JSON-LD block. Search engines and AI answer engines
 * (Perplexity, ChatGPT search, Google AI Overviews) read these to understand
 * the entity, product, and Q&A on a page.
 */
export function JsonLd({ data }: { data: object | object[] }) {
  return (
    <script
      type="application/ld+json"
      // Content is built from trusted, static strings — no user input.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
