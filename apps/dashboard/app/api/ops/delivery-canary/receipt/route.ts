import { constantTimeEqual } from "../../../../../lib/cron-auth";
import { db } from "../../../../../lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CANARY_TOKEN_HEADER = "x-axel-canary-token";
const MINIMUM_TOKEN_LENGTH = 32;
const PROBE_ID_PATTERN = /^axel_canary_[0-9]{10,16}_[0-9a-f]{12}$/;
const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
};

interface ReceiptRow {
  probe_id: string;
  received_at: Date | string;
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE_HEADERS });
}

function isAuthorized(request: Request): boolean {
  const configuredToken = process.env.DELIVERY_CANARY_RECEIPT_TOKEN;
  const providedToken = request.headers.get(CANARY_TOKEN_HEADER);
  return Boolean(
    configuredToken
      && configuredToken.length >= MINIMUM_TOKEN_LENGTH
      && providedToken
      && constantTimeEqual(providedToken, configuredToken),
  );
}

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    return json({ error: "not_found" }, 404);
  }

  const probeId = new URL(request.url).searchParams.get("probe");
  if (!probeId || !PROBE_ID_PATTERN.test(probeId)) {
    return json({ error: "not_found" }, 404);
  }

  let receipt: ReceiptRow | undefined;
  try {
    const result = await db().query<ReceiptRow>(
      `SELECT
         payload ->> 'axel_canary_probe_id' AS probe_id,
         received_at
       FROM delivery_canary_receipts
       WHERE payload ->> 'axel_canary_probe_id' = $1
       ORDER BY received_at DESC
       LIMIT 1`,
      [probeId],
    );
    receipt = result.rows[0];
  } catch {
    return json({ error: "receipt_lookup_unavailable" }, 503);
  }

  if (!receipt) {
    return json({ error: "not_found" }, 404);
  }

  try {
    await db().query(
      `DELETE FROM delivery_canary_receipts
       WHERE received_at < now() - interval '7 days'`,
    );
  } catch {
    // Retention is best effort here. A later successful canary read retries it.
  }

  const receivedAtValue = receipt.received_at instanceof Date
    ? receipt.received_at
    : new Date(receipt.received_at);
  if (Number.isNaN(receivedAtValue.getTime())) {
    return json({ error: "receipt_lookup_unavailable" }, 503);
  }

  return json({ probe_id: receipt.probe_id, received_at: receivedAtValue.toISOString() }, 200);
}
