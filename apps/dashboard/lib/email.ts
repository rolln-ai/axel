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
 * Send a transactional email through Resend. When `RESEND_API_KEY` is unset
 * (typical local dev) we log the message to stdout instead so password-reset
 * and invite flows still work end-to-end without third-party config.
 */
export async function sendEmail(
  args: SendArgs,
  options: SendOptions = {},
): Promise<SendResult> {
  const client = getClient();
  if (!client) {
    console.log("\n[email:dev-fallback] would send →", args.to);
    console.log("[email:dev-fallback] subject:", args.subject);
    console.log("[email:dev-fallback] body:\n" + args.text + "\n");
    return { ok: true };
  }

  const result = await client.emails.send(
    {
      from: getFrom(),
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: args.text,
    },
    options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : undefined,
  );

  if (result.error) {
    console.error("[email] resend send failed:", result.error);
    return { ok: false, error: result.error.message };
  }
  return { ok: true, messageId: result.data?.id };
}
