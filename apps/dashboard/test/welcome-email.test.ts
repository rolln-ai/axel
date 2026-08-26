import { describe, expect, it } from "vitest";
import { endpointLines, renderWelcomeEmail } from "../lib/welcome-email";

/**
 * What the recipient actually reads. Inline styles are full of numbers and
 * percent signs (`width:100%`, `line-height:1.35`), so any assertion about
 * copy has to look at the text nodes rather than the raw document.
 */
function visibleText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

describe("endpointLines", () => {
  it("prints the same ingest shape the source page does", () => {
    const lines = endpointLines();
    expect(lines[0]).toBe("POST https://ingest.axelapp.ai/in/<source-id>");
    expect(lines).toContain("x-axel-token: <token>");
  });
});

describe("renderWelcomeEmail", () => {
  it("greets by first name when there is one", () => {
    const email = renderWelcomeEmail({ name: "Jordan Rivers" });
    expect(email.html).toContain("Hi Jordan");
    expect(email.text).toContain("Hi Jordan");
    expect(email.html).not.toContain("Strauss");
  });

  it("falls back cleanly when the name is missing or blank", () => {
    for (const name of [null, undefined, "", "   "]) {
      const email = renderWelcomeEmail({ name });
      expect(email.html).toContain("Welcome to Axel");
      // Never a dangling "Hi ," greeting.
      expect(email.html).not.toMatch(/Hi\s*[,—]/);
      expect(email.text).not.toMatch(/Hi\s*[,—]/);
    }
  });

  it("escapes a name containing HTML", () => {
    const email = renderWelcomeEmail({ name: '<script>alert("x")</script>' });
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
  });

  it("leads with the three steps and a single primary CTA", () => {
    const email = renderWelcomeEmail({ name: "Sam" });
    expect(email.html).toContain("Create a source.");
    expect(email.html).toContain("Send an event.");
    expect(email.html).toContain("Choose where it goes.");
    // One CTA button — competing buttons dilute the action.
    expect(email.html.match(/Create your first source/g)?.length).toBe(1);
    expect(email.html).toContain("/setup");
  });

  it("shows the real endpoint as text, not as an image clients would block", () => {
    const email = renderWelcomeEmail({ name: "Sam" });
    expect(email.html).toContain("ingest.axelapp.ai/in/&lt;source-id&gt;");
    expect(email.html).not.toContain("<svg");
    // The logo glyph in the shared header is the only <img> in the document.
    expect(email.html.match(/<img/g)?.length).toBe(1);
  });

  it("invents no traffic figures — a new account has sent nothing", () => {
    const email = renderWelcomeEmail({ name: "Sam" });
    // A thousands-separated count or a success rate would be fabricated here.
    // 202 is a status code, not a figure, so a bare integer is fine.
    expect(visibleText(email.html)).not.toMatch(/\d{1,3},\d{3}/);
    expect(visibleText(email.html)).not.toMatch(/\d+(\.\d+)?%/);
  });

  it("makes no banned marketing claim", () => {
    const email = renderWelcomeEmail({ name: "Sam" });
    const html = visibleText(email.html);
    const text = email.text;
    const banned = [
      /nothing is lost/i,
      /no data loss/i,
      /nothing dropped/i,
      /exactly once/i,
      /\bseamless\b/i,
      /\beffortless\b/i,
      /enterprise-grade/i,
    ];
    for (const pattern of banned) {
      expect(html).not.toMatch(pattern);
      expect(text).not.toMatch(pattern);
    }
  });

  it("describes recovery as retry-and-replay rather than a guarantee", () => {
    const email = renderWelcomeEmail({ name: "Sam" });
    expect(email.html).toMatch(/retries with backoff/i);
    expect(email.html).toMatch(/replay/i);
  });

  it("uses the brand CTA orange, not the old off-brand one", () => {
    const email = renderWelcomeEmail({ name: "Sam" });
    expect(email.html).toContain("#f5610f");
    expect(email.html).not.toContain("#f54e00");
  });

  it("ships a plain-text alternative carrying the same steps, endpoint and link", () => {
    const email = renderWelcomeEmail({ name: "Sam" });
    expect(email.text).toContain("1. Create a source.");
    expect(email.text).toContain("2. Send an event.");
    expect(email.text).toContain("3. Choose where it goes.");
    expect(email.text).toContain("ingest.axelapp.ai/in/<source-id>");
    expect(email.text).toContain("/setup");
    expect(email.text).not.toContain("<p");
    expect(email.text).not.toContain("<div");
  });

  it("has a subject and a preheader that isn't the first body line", () => {
    const email = renderWelcomeEmail({ name: "Sam" });
    expect(email.subject.length).toBeGreaterThan(10);
    expect(email.subject.length).toBeLessThan(90);
    expect(email.html).toContain("Create a source, send an event, choose where it lands.");
  });
});
