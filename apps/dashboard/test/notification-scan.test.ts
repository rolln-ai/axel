import { describe, expect, it } from "vitest";
import {
  runNotificationScan,
  buildNewErrorNotification,
  listWorkspacesWithUnresolvedDeadLetters,
  publicNotificationScanSummary,
  shouldReportNotificationScanError,
  type NotificationScanDeps,
} from "../lib/notification-scan";
import type { Queryable } from "../lib/db";
import type { InboxGroup } from "../lib/inbox";
import type { CreateNotificationInput, NotificationRow } from "../lib/notifications";
import type { ImmediateAlertNotification, ImmediateAlertSummary } from "../lib/notification-alerts";

function group(over: Partial<InboxGroup> = {}): InboxGroup {
  return {
    fingerprint: "fp1",
    count: 3,
    resolved_24h: 0,
    first_seen: "2026-06-04T00:00:00Z",
    last_seen: "2026-06-04T01:00:00Z",
    last_resolved_at: null,
    exemplar_id: "dl1",
    reason: "http_5xx",
    message_excerpt: "500 from upstream",
    source_id: "src1",
    destination_id: null,
    route_id: "rt1",
    muted_until: null,
    muted_reason: null,
    ...over,
  };
}

const okAlert: ImmediateAlertSummary = {
  recipients_scanned: 1,
  recipients_opted_out: 0,
  emails_sent: 1,
  errors: [],
};

interface Harness {
  deps: NotificationScanDeps;
  emitted: CreateNotificationInput[];
  alerted: Array<{ workspaceId: string; n: ImmediateAlertNotification }>;
  reconciled: Array<{ workspaceId: string; fingerprints: string[] }>;
  claimed: Array<{ workspaceId: string; fingerprint: string }>;
}

function harness(opts: {
  groups: InboxGroup[];
  claim?: (fp: string) => boolean;
  todaysAlerts?: number;
  sendAlertThrows?: boolean;
}): Harness {
  const emitted: CreateNotificationInput[] = [];
  const alerted: Array<{ workspaceId: string; n: ImmediateAlertNotification }> = [];
  const reconciled: Array<{ workspaceId: string; fingerprints: string[] }> = [];
  const claimed: Array<{ workspaceId: string; fingerprint: string }> = [];
  const claimFn = opts.claim ?? (() => true);
  const deps: NotificationScanDeps = {
    listWorkspaceIds: async () => ["ws1"],
    loadGroups: async () => opts.groups,
    reconcile: async (workspaceId, fingerprints) => {
      reconciled.push({ workspaceId, fingerprints });
      return 0;
    },
    claim: async (workspaceId, fingerprint) => {
      claimed.push({ workspaceId, fingerprint });
      return claimFn(fingerprint);
    },
    countTodaysAlerts: async () => opts.todaysAlerts ?? 0,
    emit: async (input) => {
      emitted.push(input);
      return { id: `n${emitted.length}` } as unknown as NotificationRow;
    },
    sendAlert: async (workspaceId, n) => {
      if (opts.sendAlertThrows) throw new Error("listRecipients failed");
      alerted.push({ workspaceId, n });
      return okAlert;
    },
  };
  return { deps, emitted, alerted, reconciled, claimed };
}

describe("runNotificationScan", () => {
  it("emits a high new_error_type and sends one immediate alert for a new fingerprint", async () => {
    const h = harness({ groups: [group({ fingerprint: "fpA" })] });
    const summary = await runNotificationScan(h.deps);

    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]).toMatchObject({
      kind: "new_error_type",
      severity: "high",
      userId: null,
      dedupKey: "error:fpA",
      linkPath: "/workspaces/ws1/inbox",
      alertedAt: true,
    });
    expect(h.alerted).toHaveLength(1);
    expect(summary.new_errors_detected).toBe(1);
    expect(summary.alerts_emailed).toBe(1);
    expect(summary.recipients_emailed).toBe(1);
  });

  it("does not re-emit or re-email a fingerprint that was already claimed", async () => {
    const h = harness({ groups: [group({ fingerprint: "fpA" })], claim: () => false });
    const summary = await runNotificationScan(h.deps);

    expect(h.claimed).toHaveLength(1); // still attempted the claim
    expect(h.emitted).toHaveLength(0);
    expect(h.alerted).toHaveLength(0);
    expect(summary.new_errors_detected).toBe(0);
  });

  it("muted fingerprints still create the in-app notification but suppress the email", async () => {
    const h = harness({
      groups: [group({ fingerprint: "fpMuted", muted_until: "2026-12-01T00:00:00Z" })],
    });
    await runNotificationScan(h.deps);

    expect(h.claimed.map((c) => c.fingerprint)).toEqual(["fpMuted"]);
    // Muting silences the noisy email channel, but the bell still shows it so
    // operators aren't blind to an ongoing incident they muted in the Inbox.
    expect(h.emitted).toHaveLength(1);
    expect(h.alerted).toHaveLength(0);
  });

  it("reconciles the ledger against only the active (count>0) fingerprints", async () => {
    const h = harness({
      groups: [
        group({ fingerprint: "active1", count: 2 }),
        group({ fingerprint: "active2", count: 1 }),
        group({ fingerprint: "resolved", count: 0, resolved_24h: 4 }),
      ],
    });
    await runNotificationScan(h.deps);

    expect(h.reconciled).toHaveLength(1);
    expect(h.reconciled[0]!.fingerprints.sort()).toEqual(["active1", "active2"]);
  });

  it("caps immediate emails per scan but still creates the in-app notifications", async () => {
    const groups = Array.from({ length: 7 }, (_, i) => group({ fingerprint: `fp${i}` }));
    const h = harness({ groups });
    const summary = await runNotificationScan(h.deps);

    // All 7 become in-app notifications; only the first 5 email immediately.
    expect(h.emitted).toHaveLength(7);
    expect(h.alerted).toHaveLength(5);
    expect(summary.alerts_emailed).toBe(5);
    expect(h.emitted.filter((e) => e.alertedAt === true)).toHaveLength(5);
    expect(h.emitted.filter((e) => e.alertedAt === false)).toHaveLength(2);
  });

  it("respects the rolling daily email budget", async () => {
    const groups = Array.from({ length: 3 }, (_, i) => group({ fingerprint: `fp${i}` }));
    const h = harness({ groups, todaysAlerts: 19 }); // DAILY_EMAIL_CAP is 20
    const summary = await runNotificationScan(h.deps);

    expect(h.emitted).toHaveLength(3); // in-app always
    expect(summary.alerts_emailed).toBe(1); // only one slot left today
  });

  it("a failed immediate send leaves alerted_at=false (digest fallback) and does NOT abort the loop", async () => {
    // The send throws (e.g. a listRecipients DB error). Previously emit() had
    // already stamped alerted_at=true, so the digest lane (alerted_at IS NULL)
    // skipped it too — blackholed from both channels. Now: in-app bell still
    // created with alerted_at=false so the digest lane delivers it, the error is
    // recorded, and the second group is still processed (no loop abort).
    const h = harness({
      groups: [group({ fingerprint: "fpA" }), group({ fingerprint: "fpB" })],
      sendAlertThrows: true,
    });
    const summary = await runNotificationScan(h.deps);

    expect(h.emitted).toHaveLength(2); // both bells created (loop didn't abort)
    expect(h.emitted.every((e) => e.alertedAt === false)).toBe(true); // digest will pick them up
    expect(h.alerted).toHaveLength(0); // no successful email
    expect(summary.alerts_emailed).toBe(0);
    expect(summary.errors).toEqual([
      { code: "alert_send_failed" },
      { code: "alert_send_failed" },
    ]);
    expect(JSON.stringify(summary)).not.toContain("listRecipients failed");
    expect(JSON.stringify(summary)).not.toContain("ws1");
  });

  it("projects only aggregate error counts and fixed codes for the cron response", async () => {
    const h = harness({ groups: [group()] });
    h.deps.loadGroups = async () => {
      throw new Error("private-workspace-provider-detail");
    };

    const summary = await runNotificationScan(h.deps);
    const responseSummary = publicNotificationScanSummary(summary);

    expect(responseSummary.error_count).toBe(1);
    expect(responseSummary.error_counts.workspace_scan_failed).toBe(1);
    expect(JSON.stringify(responseSummary)).not.toContain("private-workspace-provider-detail");
    expect(JSON.stringify(responseSummary)).not.toContain("ws1");
    expect(responseSummary).not.toHaveProperty("errors");
  });
});

describe("shouldReportNotificationScanError", () => {
  it("suppresses transient Postgres connection noise", () => {
    expect(shouldReportNotificationScanError("connect ETIMEDOUT 35.227.164.209:5432")).toBe(false);
    expect(shouldReportNotificationScanError(new Error("timeout exceeded when trying to connect"))).toBe(false);
  });

  it("reports application failures", () => {
    expect(shouldReportNotificationScanError('column "reason" does not exist')).toBe(true);
    expect(shouldReportNotificationScanError("notification ledger insert failed")).toBe(true);
  });
});

describe("listWorkspacesWithUnresolvedDeadLetters", () => {
  it("only returns workspaces that still exist, so orphaned dead_letters can't trip the ledger FK", async () => {
    // dead_letters has no FK to workspaces; a hard-deleted workspace orphans its
    // rows. The query must INNER JOIN workspaces so those orphans never reach
    // claimActiveError (which would violate notification_active_errors_workspace_id_fkey).
    let sql = "";
    const client = {
      query: async (text: string) => {
        sql = text;
        return { rows: [{ workspace_id: "ws_live" }], rowCount: 1 };
      },
    } as unknown as Queryable;

    const ids = await listWorkspacesWithUnresolvedDeadLetters(client);

    expect(ids).toEqual(["ws_live"]);
    expect(sql).toMatch(/join\s+workspaces/i);
    expect(sql).toMatch(/resolved_at\s+is\s+null/i);
  });
});

describe("buildNewErrorNotification", () => {
  it("links to the alert's workspace inbox and summarises the failing count", () => {
    const n = buildNewErrorNotification(
      group({ count: 12, reason: "timeout", message_excerpt: "  upstream   timeout " }),
      "ws_alerted",
    );
    expect(n.link_path).toBe("/workspaces/ws_alerted/inbox");
    expect(n.severity).toBe("high");
    expect(n.title).toContain("timeout");
    expect(n.body_md).toContain("12 deliveries are failing");
    expect(n.body_md).toContain("operation_timeout");
  });

  it("escapes the workspace id when building the handoff path", () => {
    const n = buildNewErrorNotification(group(), "ws/with spaces");
    expect(n.link_path).toBe("/workspaces/ws%2Fwith%20spaces/inbox");
  });

  it("does not copy payload echoes or secrets into notification rows or email input", () => {
    const n = buildNewErrorNotification(
      group({
        message_excerpt:
          'receiver rejected payload={"email":"victim@example.test", "note":"private webhook text"}; password=hunter2',
      }),
      "ws_alerted",
    );

    expect(n.body_md).not.toContain("victim@example.test");
    expect(n.body_md).not.toContain("private webhook text");
    expect(n.body_md).not.toContain("hunter2");
    expect(n.body_md).toContain("operation_failed");
  });
});
