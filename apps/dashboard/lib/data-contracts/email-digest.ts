import "server-only";
import { db, type Queryable } from "../db";
import { sendEmail, type SendResult } from "../email";
import { resolveInactiveBillingNotifications } from "../notifications";
import {
  appUrl,
  emailHeading,
  emailLink,
  EMAIL_BRAND,
  emailTextSignature,
  escapeHtml,
  renderBrandedEmail,
} from "../email-layout";
import { failedDeliveriesPath } from "../delivery-stream";

/**
 * Email digest of recent Data Contract notifications. Runs from a cron
 * every 24 hours; collects each workspace's unread notifications from
 * the last day and fans an email per workspace member.
 *
 * Honors a workspace-level opt-out via the notification_preferences
 * row (workspace_id, user_id) — a `{ email_digest_daily: false }`
 * preference suppresses the digest for that user. Absence of a row
 * = opted-in by default.
 *
 * The window is bounded by notifications.created_at. Sending at most
 * once per recipient per UTC day is enforced by a claim row in
 * `digest_sends` (migration 0063) taken before the send — a retried or
 * hand-triggered cron finds the claim held and mails nobody twice.
 * Resend gets the same key as an `Idempotency-Key` header, which covers
 * the narrow case of a send whose response we never saw.
 */
export interface DigestRecipient {
  user_id: string;
  email: string;
  workspace_id: string;
  workspace_name: string;
}

export interface DigestNotification {
  kind: string;
  severity: "info" | "warning" | "high";
  title: string;
  body_md: string | null;
  link_path: string | null;
  created_at: string;
  /** User-facing name resolved from the linked source or destination. */
  context_name?: string | null;
  context_kind?: "source" | "destination" | null;
  /** Live breaker/pause state of the linked destination, so the digest can
   *  say whether a reported pause is history or still in force. */
  context_circuit_state?: string | null;
  context_delivery_paused?: boolean | null;
}

export interface DigestSummary {
  total_workspaces: number;
  recipients_scanned: number;
  recipients_opted_out: number;
  emails_sent: number;
  emails_skipped_empty: number;
  /** Recipients whose digest for today was already claimed by an earlier run. */
  emails_skipped_duplicate: number;
  errors: Array<{
    code:
      | "digest_claim_prune_failed"
      | "digest_recipient_failed"
      | "digest_send_failed";
  }>;
  duration_ms: number;
}

interface DigestRecipientRow {
  user_id: string;
  email: string;
  workspace_id: string;
  workspace_name: string;
  prefs: Record<string, unknown> | null;
}

const DIGEST_WINDOW_HOURS = 24;

async function listRecipientsForDigest(
  client: Queryable = db(),
): Promise<DigestRecipientRow[]> {
  const result = await client.query<DigestRecipientRow>(
    `SELECT u.id::text       AS user_id,
            u.email,
            w.id::text       AS workspace_id,
            w.name           AS workspace_name,
            np.prefs
       FROM workspace_members wm
       JOIN users u       ON u.id = wm.user_id
       JOIN workspaces w  ON w.id = wm.workspace_id
       LEFT JOIN notification_preferences np
         ON np.workspace_id = wm.workspace_id
        AND np.user_id      = wm.user_id
      WHERE w.status = 'active'
        AND u.email IS NOT NULL
      ORDER BY w.id, u.id
      LIMIT 5000`,
  );
  return result.rows;
}

async function listDigestNotifications(
  workspaceId: string,
  userId: string,
  windowHours: number = DIGEST_WINDOW_HOURS,
  client: Queryable = db(),
): Promise<DigestNotification[]> {
  // Billing alerts describe a live gate, not history. Mark the ones that no
  // longer hold — a quota block after an upgrade, a payment failure after it
  // cleared — read first, so the digest never reports a solved problem.
  await resolveInactiveBillingNotifications(workspaceId, client);
  const result = await client.query<DigestNotification>(
    `SELECT n.kind, n.severity, n.title, n.body_md, n.link_path, n.created_at::text,
            COALESCE(s.name, d.name) AS context_name,
            CASE WHEN s.id IS NOT NULL THEN 'source'
                 WHEN d.id IS NOT NULL THEN 'destination'
                 ELSE NULL END AS context_kind,
            d.circuit_state    AS context_circuit_state,
            d.delivery_paused  AS context_delivery_paused
       FROM notifications n
       LEFT JOIN data_contracts dc
         ON n.link_path = '/data-contracts/' || dc.id::text
        AND dc.workspace_id = n.workspace_id
       LEFT JOIN sources s
         ON s.id = dc.source_id
        AND s.workspace_id = n.workspace_id
       LEFT JOIN destinations d
         ON (n.link_path = '/destinations/' || d.id::text
             OR n.link_path = '/destinations/' || d.id::text || '/controls')
        AND d.workspace_id = n.workspace_id
      WHERE n.workspace_id = $1
        AND (n.user_id = $2 OR n.user_id IS NULL)
        AND n.created_at >= now() - ($3::text || ' hours')::interval
        -- Exclude anything the immediate alert lane already emailed, so a new
        -- error type isn't sent twice (once as an alert, once in the digest).
        AND n.alerted_at IS NULL
        -- Anything already read in the Inbox — or reconciled away because it
        -- is no longer true, like a quota alert after an upgrade — is dropped.
        AND n.read_at IS NULL
      ORDER BY n.created_at DESC
      LIMIT 50`,
    [workspaceId, userId, String(windowHours)],
  );
  return result.rows;
}

/** Days of claim rows kept — long enough to answer "did we mail them?". */
const DIGEST_CLAIM_RETENTION_DAYS = 30;

/**
 * True when the error is Postgres 42P01 (undefined_table) — the dashboard
 * deployed ahead of migration 0063. The digest predates the claim table, so a
 * missing table means "no dedup yet", not "send nothing today": losing a day of
 * digests is worse than the duplicate we're guarding against, and it heals as
 * soon as the migration lands.
 */
function isMissingClaimTable(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "42P01"
  );
}

/**
 * Take the right to send this recipient's digest for the current UTC day.
 * Returns that day when the claim is won and null when another invocation
 * already holds it. The unique PK does the arbitration, so two crons racing
 * on the same recipient still produce one email.
 */
async function claimDigestSend(
  workspaceId: string,
  userId: string,
  client: Queryable = db(),
): Promise<string | null> {
  try {
    const result = await client.query<{ digest_date: string }>(
      `INSERT INTO digest_sends (workspace_id, user_id, digest_date)
       VALUES ($1, $2, (now() AT TIME ZONE 'utc')::date)
       ON CONFLICT DO NOTHING
       RETURNING digest_date::text AS digest_date`,
      [workspaceId, userId],
    );
    return result.rows[0]?.digest_date ?? null;
  } catch (err) {
    if (!isMissingClaimTable(err)) throw err;
    console.error("[digest] digest_sends missing — sending without a claim");
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * Hand the claim back after a failed send, so the recipient can still get
 * today's digest from a later run rather than losing it until tomorrow.
 */
async function releaseDigestSend(
  workspaceId: string,
  userId: string,
  digestDate: string,
  client: Queryable = db(),
): Promise<void> {
  try {
    await client.query(
      `DELETE FROM digest_sends
        WHERE workspace_id = $1 AND user_id = $2 AND digest_date = $3::date`,
      [workspaceId, userId, digestDate],
    );
  } catch (err) {
    if (!isMissingClaimTable(err)) throw err;
  }
}

/** Drop claim rows past the retention floor. Runs once per digest job. */
async function pruneDigestSends(
  retentionDays: number = DIGEST_CLAIM_RETENTION_DAYS,
  client: Queryable = db(),
): Promise<number> {
  try {
    const result = await client.query(
      `DELETE FROM digest_sends
        WHERE digest_date < (now() AT TIME ZONE 'utc')::date - $1::int`,
      [retentionDays],
    );
    return result.rowCount ?? 0;
  } catch (err) {
    if (!isMissingClaimTable(err)) throw err;
    return 0;
  }
}

function optedIn(prefs: Record<string, unknown> | null): boolean {
  if (!prefs) return true; // default: subscribed
  if (prefs.email_digest_daily === false) return false;
  return true;
}

export interface DigestRenderer {
  (input: {
    workspaceName: string;
    notifications: DigestNotification[];
  }): { subject: string; html: string; text: string };
}

const DIGEST_FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * `attention` is reserved for things that stop data moving — a paused
 * destination, a paused ingest, a failed payment. Everything Axel merely
 * noticed while watching schemas belongs in `watching`, and anything Axel
 * already absorbed belongs in `automatic`. Keeping schema findings out of
 * `attention` matters: they are useful to know, not chores we hand the
 * reader, and the subject line counts `attention` items.
 */
type DigestSectionKey = "attention" | "watching" | "automatic" | "updates";

interface DigestItem {
  section: DigestSectionKey;
  severity: DigestNotification["severity"];
  title: string;
  body: string | null;
  linkPath: string | null;
  linkLabel: string;
  /** Source or destination name, used to keep one entity's items together. */
  groupBy: string;
}

interface DigestSection {
  key: DigestSectionKey;
  heading: string;
  intro: string;
  items: DigestItem[];
}

function inlineCodeValues(value: string | null): string[] {
  return value ? [...value.matchAll(/`([^`]+)`/g)].map((match) => match[1]!) : [];
}

function contextName(n: DigestNotification): string {
  return n.context_name?.trim() || "this source";
}

function pluralList(values: string[], limit = 6): string {
  const visible = values.slice(0, limit).map((value) => `\`${value}\``);
  const remaining = values.length - visible.length;
  return `${visible.join(", ")}${remaining > 0 ? `, and ${remaining} more` : ""}`;
}

/** "2026-08-12 16:21:00.1+00" (PG ::text) → "16:21 UTC"; null when unparseable. */
function formatDigestTime(createdAt: string | null | undefined): string | null {
  if (!createdAt) return null;
  const parsed = Date.parse(createdAt.replace(" ", "T"));
  if (!Number.isFinite(parsed)) return null;
  const d = new Date(parsed);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC`;
}

function cleanBody(n: DigestNotification): string | null {
  if (!n.body_md) return null;
  const name = n.context_name?.trim();
  return n.body_md
    .replace(/\s+on Data Contract\s+`[^`]+`\.?/gi, ".")
    .replace(/Data Contract\s+`[^`]+`\.?/gi, name ? `Schema for ${name}.` : "Schema updated.")
    .replace(/Destination\s+`[^`]+`/gi, name ? `Destination ${name}` : "The destination")
    .replace(/\bData Contract\b/g, "schema")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * One digest line can come from many notification rows: a destination whose
 * breaker opened four times in a day, or six separate sensitive-field rows on
 * the same schema. Group by (what it is, which entity) so the reader sees one
 * line per thing that happened rather than one line per row we stored.
 */
function digestGroupKey(n: DigestNotification): string {
  const scope = n.link_path ?? contextName(n);
  if (n.kind === "data_contract_drift") return `drift:${scope}:${n.title}`;
  return `${n.kind}:${scope}:${n.kind === "destination_circuit_open" ? "" : n.title}`;
}

function groupNotifications(
  notifications: DigestNotification[],
): DigestNotification[][] {
  const groups = new Map<string, DigestNotification[]>();
  for (const n of notifications) {
    const key = digestGroupKey(n);
    const group = groups.get(key) ?? [];
    group.push(n);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * Turn storage-level notifications into a short digest.
 *
 * Two rules shape the copy. First, only a blocked pipeline gets filed under
 * "needs your attention" — schema findings are things Axel spotted for the
 * reader, so they read as a heads-up, not as homework. Second, a generic "new
 * event type" row is dropped when the same schema was already auto-extended.
 */
function buildDigestSections(notifications: DigestNotification[]): DigestSection[] {
  const items: DigestItem[] = [];
  const autoExtendedLinks = new Set(
    notifications
      .filter((n) => n.kind === "data_contract_auto_extended" && n.link_path)
      .map((n) => n.link_path!),
  );

  for (const group of groupNotifications(notifications)) {
    const first = group[0]!;
    const name = contextName(first);
    const count = group.length;

    if (first.kind === "data_contract_drift") {
      if (
        first.title === "New event type detected" &&
        first.link_path &&
        autoExtendedLinks.has(first.link_path)
      ) continue;
      const paths = group.flatMap((n) => inlineCodeValues(n.body_md).slice(0, 1));
      if (first.title === "New sensitive field detected") {
        items.push({
          section: "watching",
          severity: "info",
          groupBy: name,
          title: `${count} new field${count === 1 ? "" : "s"} in ${name} look${count === 1 ? "s" : ""} sensitive`,
          body: paths.length > 0
            ? `${pluralList(paths)}. Redact any of them from the schema if you'd rather Axel didn't store them.`
            : "Redact them from the schema if you'd rather Axel didn't store them.",
          linkPath: first.link_path,
          linkLabel: "View fields →",
        });
      } else if (first.title === "Field type changed") {
        items.push({
          section: "watching",
          severity: "info",
          groupBy: name,
          title: `${count} field type${count === 1 ? "" : "s"} changed in ${name}`,
          body: paths.length > 0
            ? `${pluralList(paths)} now arrive with a different type — worth a look if anything downstream maps them.`
            : "Some fields now arrive with a different type — worth a look if anything downstream maps them.",
          linkPath: first.link_path,
          linkLabel: "View changes →",
        });
      } else if (first.title === "New event type detected") {
        items.push({
          section: "watching",
          severity: "info",
          groupBy: name,
          title: `New event type seen in ${name}`,
          body: "Axel spotted an event shape it hadn't seen on this source before.",
          linkPath: first.link_path,
          linkLabel: "View schema →",
        });
      } else {
        items.push({
          section: "watching",
          severity: "info",
          groupBy: name,
          title: `${first.title}${name === "this source" ? "" : ` in ${name}`}`,
          body: paths.length > 0 ? `Affected: ${pluralList(paths)}` : cleanBody(first),
          linkPath: first.link_path,
          linkLabel: "View schema →",
        });
      }
    } else if (first.kind === "data_contract_auto_drafted") {
      const sampleCount = first.body_md?.match(/from (\d+) sampled events/i)?.[1];
      items.push({
        section: "watching",
        severity: "info",
        groupBy: name,
        title: `New schema drafted for ${name}`,
        body: `Axel built it${sampleCount ? ` from ${sampleCount} sampled events` : ""}. Activate it and Axel will flag anything that arrives unexpectedly.`,
        linkPath: first.link_path,
        linkLabel: "View draft →",
      });
    } else if (first.kind === "data_contract_auto_extended") {
      const eventTypes = [...new Set(group.flatMap((n) => inlineCodeValues(n.body_md)))];
      items.push({
        section: "automatic",
        severity: "info",
        groupBy: name,
        title: `${eventTypes.length || "New"} event type${eventTypes.length === 1 ? "" : "s"} added to ${name}`,
        body: eventTypes.length > 0
          ? `${pluralList(eventTypes)}. Axel folded them into the schema and kept watching for drift.`
          : "Axel folded them into the schema and kept watching for drift.",
        linkPath: first.link_path,
        linkLabel: "View schema →",
      });
    } else if (first.kind === "destination_circuit_open") {
      const failures = group
        .map((n) => Number(n.body_md?.match(/after (\d+) consecutive failures/i)?.[1] ?? 0))
        .reduce((max, value) => Math.max(max, value), 0);
      const destination = first.context_name?.trim() || "a destination";
      // A digest lands hours after the trip, and the breaker usually
      // recovers on its own within minutes — say which one happened, and
      // when, so the reader doesn't land on a healthy dashboard hunting
      // for an outage that is already over.
      const trippedAt = formatDigestTime(first.created_at);
      const recovered =
        first.context_circuit_state === "closed" && !first.context_delivery_paused;
      const stillKnown = first.context_circuit_state != null;
      items.push({
        // A pause that already healed is an FYI, not a chore — file it under
        // "what Axel spotted" so the attention count stays honest.
        section: recovered ? "updates" : "attention",
        severity: recovered ? "info" : "warning",
        groupBy: destination,
        title: recovered
          ? `Delivery paused for ${destination}, then recovered`
          : `Delivery paused for ${destination}`,
        body:
          `${failures ? `${failures} deliveries in a row failed` : "Deliveries failed repeatedly"}` +
          `${trippedAt ? ` around ${trippedAt}` : ""}` +
          `${count > 1 ? `, and this happened ${count} times in the last 24 hours` : ""}. ` +
          (recovered
            ? "Deliveries have since resumed on their own; the delivery log has the failed attempts."
            : stillKnown
              ? "Delivery is still paused. Axel retries after each cooldown; check the destination if it keeps failing."
              : "Axel retries after each cooldown; check the destination if it keeps failing."),
        linkPath: first.link_path,
        linkLabel: "Open delivery controls →",
      });
    } else if (first.kind === "replay_job_complete") {
      const stillFailing = /\bstill failing\b/i.test(first.title);
      items.push({
        section: stillFailing ? "attention" : "updates",
        severity: stillFailing ? "warning" : "info",
        groupBy: "replays",
        title: first.title,
        body: stillFailing
          ? "Those deliveries are still unresolved."
          : cleanBody(first),
        linkPath: stillFailing
          ? failedDeliveriesPath(first.link_path)
          : first.link_path,
        linkLabel: stillFailing ? "Review failed deliveries →" : "View deliveries →",
      });
    } else {
      items.push({
        section: first.severity === "info" ? "updates" : "attention",
        severity: first.severity,
        groupBy: name,
        title: first.title,
        body: cleanBody(first),
        linkPath: first.link_path,
        linkLabel: first.severity === "info" ? "View details →" : "Review →",
      });
    }
  }

  const definitions: Array<Omit<DigestSection, "items">> = [
    {
      key: "attention",
      heading: "Needs your attention",
      intro: "Data isn't moving until these are sorted.",
    },
    {
      key: "watching",
      heading: "What Axel spotted",
      intro: "Found while watching your schemas. Nothing here needs doing — open it if it's useful.",
    },
    {
      key: "automatic",
      heading: "Handled for you",
      intro: "Axel absorbed these changes on its own.",
    },
    { key: "updates", heading: "Other updates", intro: "For your information." },
  ];
  return definitions
    .map((section) => ({
      ...section,
      // Sort by entity so every finding on one source reads as a block.
      items: items
        .filter((item) => item.section === section.key)
        .sort((a, b) => a.groupBy.localeCompare(b.groupBy)),
    }))
    .filter((section) => section.items.length > 0);
}

const defaultRenderer: DigestRenderer = ({ workspaceName, notifications }) => {
  const sections = buildDigestSections(notifications);
  const count = sections.reduce((total, section) => total + section.items.length, 0);
  const attentionCount = sections.find((section) => section.key === "attention")?.items.length ?? 0;
  const subject = attentionCount > 0
    ? `${workspaceName} — ${attentionCount} item${attentionCount === 1 ? " needs" : "s need"} your attention`
    : `${workspaceName} — your Axel daily update`;
  const app = appUrl();
  const settingsUrl = `${app}/settings?tab=notifications`;

  const textLines = [
    `${workspaceName} — daily update`,
    "",
  ];
  const htmlSections: string[] = [];
  for (const section of sections) {
    textLines.push(section.heading.toUpperCase());
    textLines.push(section.intro);
    textLines.push("");
    const htmlItems: string[] = [];
    for (const item of section.items) {
      textLines.push(item.title);
      if (item.body) textLines.push(`   ${item.body}`);
      if (item.linkPath) textLines.push(`   ${item.linkLabel.replace(" →", ":")} ${app}${item.linkPath}`);
      textLines.push("");
      htmlItems.push(
        `<li style="margin:0 0 14px;padding:2px 0 2px 12px;border-left:3px solid ${severityColor(item.severity)};list-style:none">` +
          `<div style="font:600 15px/1.4 ${DIGEST_FONT};color:${EMAIL_BRAND.heading}">${escapeHtml(item.title)}</div>` +
          (item.body
            ? `<div style="font:14px/1.5 ${DIGEST_FONT};color:${EMAIL_BRAND.body};margin:3px 0 0">${escapeHtml(item.body)}</div>`
            : "") +
          (item.linkPath
            ? `<div style="margin:7px 0 0"><a href="${app}${item.linkPath}" style="font:600 13px ${DIGEST_FONT};color:${EMAIL_BRAND.link};text-decoration:none">${escapeHtml(item.linkLabel)}</a></div>`
            : "") +
          "</li>",
      );
    }
    htmlSections.push(
      `<section style="margin:0 0 26px">` +
        `<div style="font:700 13px/1.4 ${DIGEST_FONT};letter-spacing:.04em;text-transform:uppercase;color:${EMAIL_BRAND.heading};margin:0 0 3px">${escapeHtml(section.heading)}</div>` +
        `<div style="font:14px/1.5 ${DIGEST_FONT};color:${EMAIL_BRAND.muted};margin:0 0 12px">${escapeHtml(section.intro)}</div>` +
        `<ul style="padding:0;margin:0;list-style:none">${htmlItems.join("")}</ul>` +
      `</section>`,
    );
  }

  const preheader = attentionCount > 0
    ? `${attentionCount} item${attentionCount === 1 ? " needs" : "s need"} your attention; the rest are grouped below.`
    : `${count} thing${count === 1 ? "" : "s"} Axel spotted in the last 24 hours. Nothing needs doing.`;

  const html = renderBrandedEmail({
    preheader,
    contentHtml:
      emailHeading(`${workspaceName} — daily update`) +
      htmlSections.join(""),
    footerNote: `You're receiving the Axel daily digest for <strong>${escapeHtml(workspaceName)}</strong>. ${emailLink(settingsUrl, "Manage notification settings")}.`,
  });

  textLines.push(emailTextSignature(`Manage notification settings: ${settingsUrl}`));
  return { subject, html, text: textLines.join("\n") };
};

function severityColor(sev: DigestNotification["severity"]): string {
  if (sev === "high") return "#d92d20";
  if (sev === "warning") return "#dd8a00";
  return "#b35f36";
}

export interface DigestDeps {
  listRecipients?: typeof listRecipientsForDigest;
  listNotifications?: typeof listDigestNotifications;
  send?: (
    args: { to: string; subject: string; html: string; text: string },
    options?: { idempotencyKey?: string },
  ) => Promise<SendResult>;
  renderer?: DigestRenderer;
  claimSend?: (workspaceId: string, userId: string) => Promise<string | null>;
  releaseSend?: (workspaceId: string, userId: string, digestDate: string) => Promise<void>;
  pruneClaims?: () => Promise<number>;
}

export async function runDigestJob(deps: DigestDeps = {}): Promise<DigestSummary> {
  const start = Date.now();
  const listRecipients = deps.listRecipients ?? listRecipientsForDigest;
  const listN = deps.listNotifications ?? listDigestNotifications;
  const send = deps.send ?? sendEmail;
  const renderer = deps.renderer ?? defaultRenderer;
  const claimSend = deps.claimSend ?? claimDigestSend;
  const releaseSend = deps.releaseSend ?? releaseDigestSend;
  const pruneClaims = deps.pruneClaims ?? pruneDigestSends;

  const recipients = await listRecipients();
  const summary: DigestSummary = {
    total_workspaces: new Set(recipients.map((r) => r.workspace_id)).size,
    recipients_scanned: 0,
    recipients_opted_out: 0,
    emails_sent: 0,
    emails_skipped_empty: 0,
    emails_skipped_duplicate: 0,
    errors: [],
    duration_ms: 0,
  };

  for (const r of recipients) {
    summary.recipients_scanned += 1;
    if (!optedIn(r.prefs)) {
      summary.recipients_opted_out += 1;
      continue;
    }
    let claimedDate: string | null = null;
    try {
      const notifications = await listN(r.workspace_id, r.user_id);
      if (notifications.length === 0) {
        summary.emails_skipped_empty += 1;
        continue;
      }
      // Claim after we know there's something to say, so a quiet day doesn't
      // burn the day's claim, and before the send, so a second invocation of
      // the cron finds it taken.
      claimedDate = await claimSend(r.workspace_id, r.user_id);
      if (!claimedDate) {
        summary.emails_skipped_duplicate += 1;
        continue;
      }
      const { subject, html, text } = renderer({
        workspaceName: r.workspace_name,
        notifications,
      });
      const result = await send(
        { to: r.email, subject, html, text },
        { idempotencyKey: `digest:${r.workspace_id}:${r.user_id}:${claimedDate}` },
      );
      if (result.ok) summary.emails_sent += 1;
      else {
        await releaseSend(r.workspace_id, r.user_id, claimedDate);
        summary.errors.push({ code: "digest_send_failed" });
      }
    } catch {
      if (claimedDate) {
        await releaseSend(r.workspace_id, r.user_id, claimedDate).catch(() => {});
      }
      summary.errors.push({ code: "digest_recipient_failed" });
    }
  }

  try {
    await pruneClaims();
  } catch {
    summary.errors.push({ code: "digest_claim_prune_failed" });
  }

  summary.duration_ms = Date.now() - start;
  return summary;
}
