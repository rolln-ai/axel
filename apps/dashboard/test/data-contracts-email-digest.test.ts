import { describe, expect, it } from "vitest";
import {
  runDigestJob,
  type DigestDeps,
  type DigestNotification,
} from "../lib/data-contracts/email-digest";

const NOW = "2030-01-15T12:00:00.000Z";
const TODAY = "2030-01-15";

function notification(over: Partial<DigestNotification> = {}): DigestNotification {
  return {
    kind: "data_contract_drift",
    severity: "warning",
    title: "Drift",
    body_md: null,
    link_path: "/data-contracts/em_1",
    created_at: NOW,
    ...over,
  };
}

/**
 * In-memory stand-in for the `digest_sends` claim table. Survives across
 * runDigestJob calls in a test, which is what lets a test assert that a second
 * cron invocation mails nobody.
 */
function claimStore(): Required<Pick<DigestDeps, "claimSend" | "releaseSend" | "pruneClaims">> & {
  held: Set<string>;
} {
  const held = new Set<string>();
  return {
    held,
    claimSend: async (workspaceId, userId) => {
      const key = `${workspaceId}:${userId}:${TODAY}`;
      if (held.has(key)) return null;
      held.add(key);
      return TODAY;
    },
    releaseSend: async (workspaceId, userId, digestDate) => {
      held.delete(`${workspaceId}:${userId}:${digestDate}`);
    },
    pruneClaims: async () => 0,
  };
}

describe("runDigestJob", () => {
  it("sends one email per recipient with notifications in window", async () => {
    const sent: Array<{ to: string; subject: string; lines: number }> = [];
    const summary = await runDigestJob({
      ...claimStore(),
      listRecipients: async () => [
        {
          user_id: "u1",
          email: "a@example.com",
          workspace_id: "ws_1",
          workspace_name: "Acme",
          prefs: null,
        },
        {
          user_id: "u2",
          email: "b@example.com",
          workspace_id: "ws_1",
          workspace_name: "Acme",
          prefs: null,
        },
      ],
      listNotifications: async (ws) => {
        if (ws === "ws_1") return [notification({ title: "Drift on src_1" })];
        return [];
      },
      send: async (args) => {
        sent.push({
          to: args.to,
          subject: args.subject,
          lines: args.text.split("\n").length,
        });
        return { ok: true };
      },
    });
    expect(summary.recipients_scanned).toBe(2);
    expect(summary.emails_sent).toBe(2);
    expect(summary.emails_skipped_empty).toBe(0);
    expect(sent.map((s) => s.to).sort()).toEqual(["a@example.com", "b@example.com"]);
    expect(sent[0]!.subject).toMatch(/Acme/);
  });

  it("skips recipients with no notifications in window", async () => {
    const summary = await runDigestJob({
      ...claimStore(),
      listRecipients: async () => [
        {
          user_id: "u1",
          email: "a@example.com",
          workspace_id: "ws_quiet",
          workspace_name: "Quiet",
          prefs: null,
        },
      ],
      listNotifications: async () => [],
      send: async () => {
        throw new Error("should not call");
      },
    });
    expect(summary.emails_skipped_empty).toBe(1);
    expect(summary.emails_sent).toBe(0);
  });

  it("respects the email_digest_daily=false opt-out", async () => {
    const summary = await runDigestJob({
      ...claimStore(),
      listRecipients: async () => [
        {
          user_id: "u_opt_out",
          email: "out@example.com",
          workspace_id: "ws_1",
          workspace_name: "Acme",
          prefs: { email_digest_daily: false },
        },
        {
          user_id: "u_opt_in",
          email: "in@example.com",
          workspace_id: "ws_1",
          workspace_name: "Acme",
          prefs: { email_digest_daily: true },
        },
      ],
      listNotifications: async () => [notification()],
      send: async () => ({ ok: true }),
    });
    expect(summary.recipients_opted_out).toBe(1);
    expect(summary.emails_sent).toBe(1);
  });

  it("collects send errors per-recipient and doesn't abort", async () => {
    const summary = await runDigestJob({
      ...claimStore(),
      listRecipients: async () => [
        {
          user_id: "u1",
          email: "a@example.com",
          workspace_id: "ws_1",
          workspace_name: "Acme",
          prefs: null,
        },
        {
          user_id: "u2",
          email: "b@example.com",
          workspace_id: "ws_1",
          workspace_name: "Acme",
          prefs: null,
        },
      ],
      listNotifications: async () => [notification()],
      send: async (args) => {
        if (args.to === "a@example.com")
          return { ok: false, error: "resend 503" };
        return { ok: true };
      },
    });
    expect(summary.emails_sent).toBe(1);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]!.message).toMatch(/resend 503/);
  });

  it("counts only blocked pipelines in the subject", async () => {
    const subjects: string[] = [];
    await runDigestJob({
      ...claimStore(),
      listRecipients: async () => [
        {
          user_id: "u1",
          email: "a@example.com",
          workspace_id: "ws_acme",
          workspace_name: "Acme Co",
          prefs: null,
        },
      ],
      listNotifications: async () => [
        notification({
          kind: "destination_circuit_open",
          severity: "warning",
          title: "Destination paused: circuit breaker open",
          body_md: "Destination `dst_1` has been temporarily paused after 5 consecutive failures.",
          link_path: "/destinations/dst_1",
          context_name: "Warehouse",
          context_kind: "destination",
        }),
        notification({ severity: "high", title: "New sensitive field detected" }),
        notification({ severity: "info", title: "New event type" }),
      ],
      send: async (args) => {
        subjects.push(args.subject);
        return { ok: true };
      },
    });
    expect(subjects).toHaveLength(1);
    expect(subjects[0]!).toMatch(/Acme Co/);
    expect(subjects[0]!).toMatch(/1 item needs your attention/);
  });

  it("groups related changes by action and hides internal IDs from the copy", async () => {
    let rendered: { subject: string; html: string; text: string } | null = null;
    await runDigestJob({
      ...claimStore(),
      listRecipients: async () => [
        {
          user_id: "u1",
          email: "a@example.com",
          workspace_id: "ws_acme",
          workspace_name: "Demo Workspace",
          prefs: null,
        },
      ],
      listNotifications: async () => [
        notification({
          severity: "high",
          title: "New sensitive field detected",
          body_md: "Path `content.customer.phone` on Data Contract `em_demo_billing`.",
          context_name: "Demo billing source",
        }),
        notification({
          severity: "high",
          title: "New sensitive field detected",
          body_md: "Path `content.invoice.phone` on Data Contract `em_demo_billing`.",
          context_name: "Demo billing source",
        }),
        notification({
          severity: "info",
          title: "New event type detected",
          body_md: "Data Contract `em_demo_billing`.",
          context_name: "Demo billing source",
        }),
        notification({
          kind: "data_contract_auto_extended",
          severity: "info",
          title: "New event type added to Demo billing source — 2030-01-15 12:00",
          body_md: "Axel auto-extended the Data Contract to include: `payment_failed`.",
          context_name: "Demo billing source",
        }),
        notification({
          kind: "destination_circuit_open",
          severity: "warning",
          title: "Destination paused: circuit breaker open",
          body_md: "Destination `dst_internal` has been temporarily paused after 5 consecutive failures.",
          link_path: "/destinations/dst_internal",
          context_name: "Customer warehouse",
          context_kind: "destination",
        }),
      ],
      send: async (args) => {
        rendered = args;
        return { ok: true };
      },
    });

    expect(rendered).not.toBeNull();
    const output = rendered!;
    expect(output.subject).toBe("Demo Workspace — 1 item needs your attention");
    expect(output.text).toContain("NEEDS YOUR ATTENTION");
    expect(output.text).toContain("Delivery paused for Customer warehouse");
    // Schema findings are a heads-up, not a chore: they sit outside the
    // attention section and out of the subject count.
    expect(output.text).toContain("WHAT AXEL SPOTTED");
    expect(output.text).toContain("2 new fields in Demo billing source look sensitive");
    expect(output.text).toContain("HANDLED FOR YOU");
    expect(output.text).toContain("1 event type added to Demo billing source");
    expect(output.text.match(/New event type seen/g)).toBeNull();
    expect(output.html).not.toContain("Data Contract `em_demo_billing`");
    expect(output.html).not.toContain("Destination `dst_internal`");
  });

  it("collapses repeat breaker alerts for one destination into a single line", async () => {
    let rendered: { subject: string; html: string; text: string } | null = null;
    const breaker = (failures: number) =>
      notification({
        kind: "destination_circuit_open",
        severity: "warning",
        title: "Destination paused: circuit breaker open",
        body_md: `Destination \`dst_bq\` has been temporarily paused after ${failures} consecutive failures.`,
        link_path: "/destinations/dst_bq",
        context_name: "demo-google-bigquery",
        context_kind: "destination",
      });
    await runDigestJob({
      ...claimStore(),
      listRecipients: async () => [
        {
          user_id: "u1",
          email: "a@example.com",
          workspace_id: "ws_demo_publishing",
          workspace_name: "Acme Publishing",
          prefs: null,
        },
      ],
      listNotifications: async () => [breaker(3), breaker(3), breaker(10), breaker(3)],
      send: async (args) => {
        rendered = args;
        return { ok: true };
      },
    });

    const output = rendered!;
    expect(output.subject).toBe("Acme Publishing — 1 item needs your attention");
    expect(output.text.match(/Delivery paused for demo-google-bigquery/g)).toHaveLength(1);
    expect(output.text).toContain(
      "10 deliveries in a row failed around 12:00 UTC, and this happened 4 times",
    );
    // No live breaker state in the fixture → the copy must not claim either
    // "still paused" or "recovered".
    expect(output.text).toContain("Axel retries after each cooldown");
    expect(output.text).not.toContain("still paused");
  });

  it("reports a recovered breaker as an FYI instead of an open problem", async () => {
    let rendered: { subject: string; html: string; text: string } | null = null;
    await runDigestJob({
      ...claimStore(),
      listRecipients: async () => [
        {
          user_id: "u1",
          email: "a@example.com",
          workspace_id: "ws_acme",
          workspace_name: "Acme Co",
          prefs: null,
        },
      ],
      listNotifications: async () => [
        notification({
          kind: "destination_circuit_open",
          severity: "warning",
          title: "Destination paused: Demo BigQuery",
          body_md: "Destination `Demo BigQuery` has been temporarily paused after 5 consecutive failures.",
          link_path: "/destinations/dst_bq/controls",
          context_name: "Demo BigQuery",
          context_kind: "destination",
          context_circuit_state: "closed",
          context_delivery_paused: false,
        }),
      ],
      send: async (args) => {
        rendered = args;
        return { ok: true };
      },
    });

    const output = rendered!;
    expect(output.text).toContain("Delivery paused for Demo BigQuery, then recovered");
    expect(output.text).toContain("Deliveries have since resumed on their own");
    expect(output.text).toContain("OTHER UPDATES");
    expect(output.text).not.toContain("NEEDS YOUR ATTENTION");
    expect(output.subject).not.toMatch(/needs your attention/);
  });

  it("reports a still-open pause as unresolved", async () => {
    let rendered: { subject: string; html: string; text: string } | null = null;
    await runDigestJob({
      ...claimStore(),
      listRecipients: async () => [
        {
          user_id: "u1",
          email: "a@example.com",
          workspace_id: "ws_acme",
          workspace_name: "Acme Co",
          prefs: null,
        },
      ],
      listNotifications: async () => [
        notification({
          kind: "destination_circuit_open",
          severity: "warning",
          title: "Destination paused: Demo BigQuery",
          body_md: "Destination `Demo BigQuery` has been temporarily paused after 5 consecutive failures.",
          link_path: "/destinations/dst_bq/controls",
          context_name: "Demo BigQuery",
          context_kind: "destination",
          context_circuit_state: "open",
          context_delivery_paused: false,
        }),
      ],
      send: async (args) => {
        rendered = args;
        return { ok: true };
      },
    });

    const output = rendered!;
    expect(output.text).toContain("Delivery paused for Demo BigQuery");
    expect(output.text).toContain("Delivery is still paused.");
    expect(output.text).toContain("NEEDS YOUR ATTENTION");
    expect(output.text).toContain("Open delivery controls");
  });

  it("deep-links a failed replay-complete notice to the failed deliveries stream", async () => {
    let rendered: { subject: string; html: string; text: string } | null = null;
    await runDigestJob({
      ...claimStore(),
      listRecipients: async () => [
        {
          user_id: "u1",
          email: "a@example.com",
          workspace_id: "ws_demo_publishing",
          workspace_name: "Acme Publishing",
          prefs: null,
        },
      ],
      listNotifications: async () => [
        notification({
          kind: "replay_job_complete",
          severity: "warning",
          title: "Replay finished: 0 succeeded, 100 still failing",
          body_md: null,
          link_path: "/deliveries",
        }),
      ],
      send: async (args) => {
        rendered = args;
        return { ok: true };
      },
    });

    const output = rendered!;
    expect(output.subject).toBe("Acme Publishing — 1 item needs your attention");
    expect(output.text).toContain("NEEDS YOUR ATTENTION");
    expect(output.text).toContain("Replay finished: 0 succeeded, 100 still failing");
    expect(output.text).toContain("Those deliveries are still unresolved.");
    expect(output.text).toContain("/deliveries?status=failed");
    expect(output.html).toContain('href="https://app.axelapp.ai/deliveries?status=failed"');
    expect(output.html).toContain("Review failed deliveries");
  });

  it("mails nobody twice when the cron fires again the same day", async () => {
    const claims = claimStore();
    const keys: Array<string | undefined> = [];
    const deps = {
      ...claims,
      listRecipients: async () => [
        {
          user_id: "u1",
          email: "a@example.com",
          workspace_id: "ws_1",
          workspace_name: "Acme",
          prefs: null,
        },
      ],
      listNotifications: async () => [notification()],
      send: async (_args: { to: string }, options?: { idempotencyKey?: string }) => {
        keys.push(options?.idempotencyKey);
        return { ok: true };
      },
    };

    const first = await runDigestJob(deps);
    const second = await runDigestJob(deps);

    expect(first.emails_sent).toBe(1);
    expect(second.emails_sent).toBe(0);
    expect(second.emails_skipped_duplicate).toBe(1);
    expect(keys).toEqual([`digest:ws_1:u1:${TODAY}`]);
  });

  it("releases the claim on a failed send so a later run can retry", async () => {
    const claims = claimStore();
    let attempt = 0;
    const deps = {
      ...claims,
      listRecipients: async () => [
        {
          user_id: "u1",
          email: "a@example.com",
          workspace_id: "ws_1",
          workspace_name: "Acme",
          prefs: null,
        },
      ],
      listNotifications: async () => [notification()],
      send: async () => {
        attempt += 1;
        return attempt === 1 ? { ok: false, error: "resend 503" } : { ok: true };
      },
    };

    const first = await runDigestJob(deps);
    expect(first.emails_sent).toBe(0);
    expect(claims.held.size).toBe(0);

    const second = await runDigestJob(deps);
    expect(second.emails_sent).toBe(1);
    expect(second.emails_skipped_duplicate).toBe(0);
  });
});
