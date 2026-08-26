import { NextResponse } from "next/server";

/**
 * Newsletter signup endpoint.
 *
 * Provider-agnostic on purpose: swapping newsletter vendors should be an env
 * var change, not a code change. Configure with:
 *
 *   NEWSLETTER_PROVIDER   "kit" (default) | "buttondown" | "console"
 *   NEWSLETTER_API_KEY    provider API key
 *   NEWSLETTER_FORM_ID    Kit only — subscribes into a specific form so the
 *                         double opt-in confirmation email fires
 *
 * With no env vars set the route runs in "console" mode: it validates and logs
 * but does not persist. That keeps local dev and preview builds from silently
 * writing into the real list.
 */

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

type Provider = "kit" | "buttondown" | "console";

function resolveProvider(): Provider {
  const configured = (process.env.NEWSLETTER_PROVIDER ?? "kit").toLowerCase();
  if (!process.env.NEWSLETTER_API_KEY) return "console";
  if (configured === "buttondown") return "buttondown";
  if (configured === "console") return "console";
  return "kit";
}

async function subscribeKit(email: string): Promise<{ ok: boolean; status: number; detail: string }> {
  const apiKey = process.env.NEWSLETTER_API_KEY as string;
  const formId = process.env.NEWSLETTER_FORM_ID;

  // Subscribing through a form triggers Kit's confirmation email; the bare
  // /subscribers endpoint does not. Prefer the form when we have an id.
  const url = formId
    ? `https://api.kit.com/v4/forms/${encodeURIComponent(formId)}/subscribers`
    : "https://api.kit.com/v4/subscribers";

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Kit-Api-Key": apiKey,
    },
    body: JSON.stringify({ email_address: email }),
  });

  return { ok: res.ok, status: res.status, detail: await res.text() };
}

async function subscribeButtondown(email: string): Promise<{ ok: boolean; status: number; detail: string }> {
  const apiKey = process.env.NEWSLETTER_API_KEY as string;

  const res = await fetch("https://api.buttondown.com/v1/subscribers", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Token ${apiKey}`,
    },
    body: JSON.stringify({ email_address: email, type: "regular" }),
  });

  // Buttondown 400s on an already-subscribed address. Treat that as success so
  // we never leak list membership back to the caller.
  if (res.status === 400) {
    const body = await res.text();
    if (body.includes("already")) return { ok: true, status: 200, detail: "already subscribed" };
    return { ok: false, status: 400, detail: body };
  }

  return { ok: res.ok, status: res.status, detail: await res.text() };
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const { email, company } = (payload ?? {}) as { email?: unknown; company?: unknown };

  // Honeypot. Real users never fill this; bots fill every field they find.
  // Return 200 so the bot believes it succeeded and moves on.
  if (typeof company === "string" && company.trim() !== "") {
    return NextResponse.json({ ok: true });
  }

  if (typeof email !== "string" || !EMAIL_RE.test(email.trim()) || email.length > 320) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  const normalized = email.trim().toLowerCase();
  const provider = resolveProvider();

  if (provider === "console") {
    console.info(`[newsletter] no provider configured; would subscribe ${normalized}`);
    return NextResponse.json({ ok: true });
  }

  try {
    const result =
      provider === "buttondown" ? await subscribeButtondown(normalized) : await subscribeKit(normalized);

    if (!result.ok) {
      // Log the provider's reason, but never surface it — the response body can
      // reveal whether an address is already on the list.
      console.error(`[newsletter] ${provider} rejected signup (${result.status}): ${result.detail}`);
      return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 502 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[newsletter] provider request failed", error);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 502 });
  }
}
