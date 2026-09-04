import "server-only";
import { Resend } from "resend";

export interface SendArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface SendResult {
  ok: boolean;
  error?: string;
  messageId?: string;
}

let cachedClient: Resend | null = null;
function getClient(): Resend | null {
  if (!process.env.RESEND_API_KEY) return null;
  if (!cachedClient) cachedClient = new Resend(process.env.RESEND_API_KEY);
  return cachedClient;
}

function getFrom(): string {
  return process.env.RESEND_FROM_EMAIL ?? "Axel <noreply@axelapp.ai>";
}

export interface SendOptions {
  /**
   * Sent to Resend as the `Idempotency-Key` header. Two calls with the same
   * key deliver one email, which lets a caller retry a send whose response it
   * never saw. Callers that mail on a schedule (the daily digest) key on
   * recipient + day.
   */
  idempotencyKey?: string;
}

/**
 * Send a transactional email through Resend. Local development keeps a
 * console fallback so password-reset and invite flows can be exercised without
 * a provider. Production must fail closed: those messages contain one-shot
 * credentials and must never be copied into hosted or container logs.
 */
export async function sendEmail(
  args: SendArgs,
  options: SendOptions = {},
): Promise<SendResult> {
  const client = getClient();
  if (!client) {
    if (process.env.NODE_ENV === "development") {
      console.log("[email:dev-fallback] message suppressed; email delivery is not configured");
      return { ok: true };
    }
    console.warn("[email] delivery is not configured; message was not sent");
    return { ok: false, error: "Email delivery is not configured." };
  }

  let result: Awaited<ReturnType<typeof client.emails.send>>;
  try {
    result = await client.emails.send(
      {
        from: getFrom(),
        to: args.to,
        subject: args.subject,
        html: args.html,
        text: args.text,
      },
      options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : undefined,
    );
  } catch {
    // Provider/network exceptions can retain request objects. Do not hand the
    // original exception to callers that may log it alongside a one-shot URL.
    console.error("[email] provider request failed");
    return { ok: false, error: "Email provider request failed." };
  }

  if (result.error) {
    console.error("[email] provider rejected the message");
    return { ok: false, error: "Email provider rejected the message." };
  }
  return { ok: true, messageId: result.data?.id };
}
