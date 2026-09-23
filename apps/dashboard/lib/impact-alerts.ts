import "server-only";
import { db, withTransaction, type Queryable } from "./db";
import { prefixedId } from "./ids";
import { sendEmail, type SendArgs, type SendResult } from "./email";
import { appUrl, emailButton, emailHeading, emailParagraph, escapeHtml, renderBrandedEmail } from "./email-layout";
import { listImmediateAlertRecipients, optedInToImmediate } from "./notification-alerts";
import { impactMessage, incidentTransition, type ImpactKind, type ImpactObservation, type ImpactPhase, type ImpactSnapshot } from "./impact-alert-policy";
import { loadImpactObservations } from "./impact-alert-health";

export interface PipelineIncident {
  id: string; workspace_id: string; kind: ImpactKind; snapshot: ImpactSnapshot;
  opened_at: string; observed_at: string; healthy_since: string | null;
  acknowledged_until: string | null; next_reminder_at: string; sequence: number;
  fix_requested_at: string | null;
}

export function renderImpactEmail(workspace: string, workspaceId: string, kind: ImpactKind, snapshot: ImpactSnapshot, phase: ImpactPhase): Omit<SendArgs, "to"> {
  const { title, body } = impactMessage(kind, snapshot, phase);
  const link = `${appUrl()}/workspaces/${encodeURIComponent(workspaceId)}/inbox`;
  const settings = `${appUrl()}/settings?tab=notifications`;
  const sourceLink = `${appUrl()}/sources/${encodeURIComponent(snapshot.sourceId)}`;
  const filters = new URLSearchParams({ status: "failed", source: snapshot.sourceId });
  if (snapshot.destinationId) filters.set("destination", snapshot.destinationId);
  const failuresLink = `${appUrl()}/workspaces/${encodeURIComponent(workspaceId)}/deliveries?${filters}`;
  const diagnostics = [{ label: "Review source", url: sourceLink },
    ...(kind === "delivery_blocked" ? [{ label: "Review failed events", url: failuresLink }] : [])];
  return {
    subject: `[${workspace.replace(/[\r\n\t]/g, " ").slice(0, 120)}] ${title}`,
    text: `${title}\n\n${body}\n\nReview incident: ${link}\n${diagnostics.map(item => `${item.label}: ${item.url}`).join("\n")}\nEmail preferences: ${settings}`,
    html: renderBrandedEmail({ preheader: title,
      contentHtml: emailHeading(title) + body.split("\n\n").map(p => emailParagraph(escapeHtml(p))).join("") + emailButton(link, "Review incident")
        + diagnostics.map(item => emailParagraph(`<a href="${escapeHtml(item.url)}">${item.label}</a>`)).join(""),
      footerNote: `You receive incident alerts for ${escapeHtml(workspace)}. <a href="${escapeHtml(settings)}">Email preferences</a>.`,
    }),
  };
}

async function enqueuePhase(client: Queryable, incident: PipelineIncident, phase: ImpactPhase): Promise<void> {
  const { title, body } = impactMessage(incident.kind, incident.snapshot, phase);
  await client.query(
    `INSERT INTO notifications (id, workspace_id, kind, severity, title, body_md, link_path, dedup_key, metadata)
     VALUES ($1, $2, 'pipeline_incident', $3, $4, $5, $6, $7, $8::jsonb) ON CONFLICT DO NOTHING`,
    [prefixedId("notif"), incident.workspace_id, phase === "recovered" ? "info" : "high", title, body,
      `/workspaces/${encodeURIComponent(incident.workspace_id)}/inbox`, `${incident.id}:${incident.sequence}`,
      JSON.stringify({ incident_id: incident.id, phase })]);
  const recipients = await listImmediateAlertRecipients(incident.workspace_id, client);
  for (const recipient of recipients) {
    if (!optedInToImmediate(recipient.prefs)) continue;
    // Freeze the complete payload. Resend requires identical retry payloads.
    const payload: SendArgs = { to: recipient.email, ...renderImpactEmail(recipient.workspace_name, incident.workspace_id, incident.kind, incident.snapshot, phase) };
    await client.query(
      `INSERT INTO alert_email_outbox (id, workspace_id, incident_id, user_id, sequence, phase, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) ON CONFLICT DO NOTHING`,
      [prefixedId("mail"), incident.workspace_id, incident.id, recipient.user_id, incident.sequence, phase, JSON.stringify(payload)]);
  }
}

/** Caller supplies a transaction. The workspace row serializes concurrent scans. */
export async function recordImpactObservations(client: Queryable, workspaceId: string, observations: ImpactObservation[], observedAt: Date): Promise<number> {
  const workspace = await client.query(`SELECT id FROM workspaces WHERE id = $1 AND status = 'active' FOR NO KEY UPDATE`, [workspaceId]);
  if (!workspace.rowCount) return 0;
  let changes = 0;
  for (const observation of observations) {
    const existing = (await client.query<PipelineIncident>(
      `SELECT id, workspace_id, kind, snapshot, opened_at::text, observed_at::text, healthy_since::text,
              acknowledged_until::text, next_reminder_at::text, sequence, fix_requested_at::text
         FROM pipeline_incidents WHERE workspace_id = $1 AND incident_key = $2 AND resolved_at IS NULL FOR UPDATE`,
      [workspaceId, observation.key])).rows[0];
    if (existing && Date.parse(existing.observed_at) >= observedAt.getTime()) continue;
    let incident = existing;
    let phase: ImpactPhase | null = null;
    if (!incident) {
      if (!observation.unhealthy) continue;
      incident = (await client.query<PipelineIncident>(
        `INSERT INTO pipeline_incidents (id, workspace_id, source_id, incident_key, kind, snapshot, observed_at, next_reminder_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $7::timestamptz + interval '24 hours') RETURNING *`,
        [prefixedId("inc"), workspaceId, observation.snapshot.sourceId, observation.key, observation.kind, JSON.stringify(observation.snapshot), observedAt])).rows[0]!;
      phase = "opened";
    } else {
      const transition = incidentTransition(incident, observation.unhealthy, observedAt.getTime());
      phase = transition === "recover" ? "recovered" : transition === "remind" ? "reminder" : null;
      incident.snapshot = observation.snapshot;
      if (phase) incident.sequence += 1;
      await client.query(
        `UPDATE pipeline_incidents SET snapshot = $3::jsonb, observed_at = $4,
          healthy_since = CASE WHEN $5 THEN NULL ELSE COALESCE(healthy_since, $4) END,
          resolved_at = CASE WHEN $6 = 'recovered' THEN $4 ELSE NULL END,
          next_reminder_at = CASE WHEN $6 = 'reminder' THEN $4::timestamptz + interval '24 hours' ELSE next_reminder_at END,
          sequence = $7 WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, incident.id, JSON.stringify(observation.snapshot), observedAt, observation.unhealthy, phase, incident.sequence]);
    }
    if (phase) {
      await enqueuePhase(client, incident, phase);
      changes += 1;
    }
  }
  await client.query(`UPDATE workspaces SET impact_monitor_checked_at = GREATEST(impact_monitor_checked_at, $2) WHERE id = $1`, [workspaceId, observedAt]);
  return changes;
}

interface OutboxRow { id: string; workspace_id: string; user_id: string; payload: SendArgs; attempts: number; claim_id: string }
export interface OutboxResult { sent: number; failed: number; needs_review: number }

export async function drainImpactOutbox(client: Queryable = db(), send: typeof sendEmail = sendEmail): Promise<OutboxResult> {
  const result: OutboxResult = { sent: 0, failed: 0, needs_review: 0 };
  // https://resend.com/docs/dashboard/emails/idempotency-keys: keys last 24h.
  // An ambiguous send older than 23h requires review, never a blind resend.
  await client.query(`UPDATE alert_email_outbox SET state = 'needs_review', claim_id = NULL, lease_until = NULL
    WHERE state IN ('pending','sending') AND first_attempt_at < now() - interval '23 hours'
      AND (lease_until IS NULL OR lease_until < now())`);
  const deadline = Date.now() + 120_000;
  for (let n = 0; n < 100 && Date.now() < deadline; n++) {
    const claimId = prefixedId("claim");
    const row = (await client.query<OutboxRow>(
      `WITH candidate AS (
        SELECT o.id FROM alert_email_outbox o
         WHERE (o.state = 'pending' OR (o.state = 'sending' AND o.lease_until < now()))
           AND o.next_attempt_at <= now()
           AND (o.first_attempt_at IS NULL OR o.first_attempt_at >= now() - interval '23 hours')
           AND NOT EXISTS (SELECT 1 FROM alert_email_outbox earlier
             WHERE earlier.incident_id = o.incident_id AND earlier.user_id = o.user_id
               AND earlier.sequence < o.sequence AND earlier.state IN ('pending','sending'))
         ORDER BY o.next_attempt_at, o.created_at FOR UPDATE SKIP LOCKED LIMIT 1
       ) UPDATE alert_email_outbox o SET state = 'sending', claim_id = $1,
          lease_until = now() + interval '10 minutes', first_attempt_at = COALESCE(first_attempt_at, now()), attempts = attempts + 1
         FROM candidate WHERE o.id = candidate.id RETURNING o.*`, [claimId])).rows[0];
    if (!row) break;
    // Membership and address may have changed since enqueue. Do not send old
    // workspace information to a removed member or an obsolete address.
    const eligible = (await listImmediateAlertRecipients(row.workspace_id, client))
      .some(r => r.user_id === row.user_id && r.email === row.payload.to && optedInToImmediate(r.prefs));
    if (!eligible) {
      await client.query(`UPDATE alert_email_outbox SET state = 'cancelled', payload = '{}'::jsonb, claim_id = NULL, lease_until = NULL WHERE id = $1 AND claim_id = $2`, [row.id, claimId]);
      continue;
    }
    let sent: SendResult;
    try { sent = await send(row.payload, { idempotencyKey: `impact:${row.id}` }); }
    catch { sent = { ok: false }; }
    if (sent.ok && sent.messageId) {
      await client.query(`UPDATE alert_email_outbox SET state = 'sent', sent_at = now(), provider_message_id = $3,
        payload = '{}'::jsonb, lease_until = NULL, claim_id = NULL WHERE id = $1 AND claim_id = $2`, [row.id, claimId, sent.messageId]);
      result.sent += 1;
    } else {
      await client.query(`UPDATE alert_email_outbox SET state = 'pending', lease_until = NULL, claim_id = NULL,
        next_attempt_at = now() + ($3::int * interval '1 minute') WHERE id = $1 AND claim_id = $2`,
        [row.id, claimId, Math.min(60, 2 ** Math.min(row.attempts, 6))]);
      result.failed += 1;
    }
  }
  result.needs_review = Number((await client.query<{count: string}>(`SELECT count(*)::text AS count FROM alert_email_outbox WHERE state = 'needs_review'`)).rows[0]?.count ?? 0);
  // Payloads are removed as soon as delivery is confirmed. Audit receipts are
  // retained for 90 days; unresolved incidents are never pruned.
  await client.query(`DELETE FROM pipeline_incidents WHERE resolved_at < now() - interval '90 days'
    AND NOT EXISTS (SELECT 1 FROM alert_email_outbox o WHERE o.incident_id = pipeline_incidents.id AND o.state IN ('pending','sending','needs_review'))`);
  return result;
}

export async function runImpactAlertScan() {
  const workspaces = (await db().query<{id: string}>(`SELECT id FROM workspaces WHERE status = 'active' ORDER BY id`)).rows;
  let incidents = 0;
  let unavailable = 0;
  for (const workspace of workspaces) {
    const observedAt = new Date();
    try {
      const observations = await loadImpactObservations(workspace.id);
      incidents += await withTransaction(client => recordImpactObservations(client, workspace.id, observations, observedAt));
    } catch { unavailable += 1; }
  }
  const emails = await drainImpactOutbox();
  return { workspaces_scanned: workspaces.length, incidents_changed: incidents, monitor_unavailable: unavailable, ...emails };
}
