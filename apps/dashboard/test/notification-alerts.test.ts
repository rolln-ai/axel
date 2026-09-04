import { describe, expect, it } from "vitest";
import {
  sendImmediateErrorAlert,
  renderImmediateAlert,
  optedInToImmediate,
  type ImmediateAlertNotification,
  type ImmediateAlertRecipientRow,
} from "../lib/notification-alerts";
import type { SendArgs, SendResult } from "../lib/email";

const notification: ImmediateAlertNotification = {
  kind: "new_error_type",
  severity: "high",
  title: "New delivery error: http_5xx",
  body_md: "3 deliveries are failing — 500 from upstream",
  link_path: "/inbox",
};

function recipient(over: Partial<ImmediateAlertRecipientRow> = {}): ImmediateAlertRecipientRow {
  return {
    workspace_name: "Acme",
    user_id: "u1",
    email: "a@example.com",
    prefs: null,
    ...over,
  };
}

describe("optedInToImmediate", () => {
  it("defaults to opted-in when prefs are absent or unset", () => {
    expect(optedInToImmediate(null)).toBe(true);
    expect(optedInToImmediate({})).toBe(true);
    expect(optedInToImmediate({ email_immediate: true })).toBe(true);
  });
  it("opts out only on an explicit false", () => {
    expect(optedInToImmediate({ email_immediate: false })).toBe(false);
  });
});

describe("sendImmediateErrorAlert", () => {
  it("emails opted-in members and skips opted-out ones", async () => {
    const sent: SendArgs[] = [];
    const summary = await sendImmediateErrorAlert("ws1", notification, {
      listRecipients: async () => [
        recipient({ user_id: "u1", email: "in@example.com" }),
        recipient({ user_id: "u2", email: "out@example.com", prefs: { email_immediate: false } }),
      ],
      send: async (args) => {
        sent.push(args);
        return { ok: true } as SendResult;
      },
    });

    expect(sent.map((s) => s.to)).toEqual(["in@example.com"]);
    expect(summary.emails_sent).toBe(1);
    expect(summary.recipients_opted_out).toBe(1);
    expect(summary.recipients_scanned).toBe(2);
  });

  it("records a send failure without throwing", async () => {
    const summary = await sendImmediateErrorAlert("ws1", notification, {
      listRecipients: async () => [recipient()],
      send: async () => ({ ok: false, error: "provider-private-detail" }) as SendResult,
    });
    expect(summary.emails_sent).toBe(0);
    expect(summary.errors).toEqual([{ code: "email_send_rejected" }]);
    expect(JSON.stringify(summary)).not.toContain("provider-private-detail");
    expect(JSON.stringify(summary)).not.toContain("u1");
  });

  it("does not retain thrown provider diagnostics or recipient identity", async () => {
    const summary = await sendImmediateErrorAlert("ws1", notification, {
      listRecipients: async () => [recipient()],
      send: async () => {
        throw new Error("provider-private-exception");
      },
    });

    expect(summary.errors).toEqual([{ code: "email_send_failed" }]);
    expect(JSON.stringify(summary)).not.toContain("provider-private-exception");
    expect(JSON.stringify(summary)).not.toContain("u1");
  });
});

describe("renderImmediateAlert", () => {
  it("includes the title, an investigate link, and a manage-settings link", () => {
    const { subject, html, text } = renderImmediateAlert("Acme", notification);
    expect(subject).toContain("Acme");
    expect(subject).toContain("operation_failed");
    expect(html).toContain("/inbox");
    expect(html).toContain("/settings?tab=notifications");
    expect(text).toContain("/settings?tab=notifications");
  });

  it("escapes HTML in the title", () => {
    const { html } = renderImmediateAlert("Acme", { ...notification, title: "<script>x</script>" });
    expect(html).not.toContain("<script>x</script>");
    expect(html).not.toContain("&lt;script&gt;");
    expect(html).toContain("operation_failed");
  });

  it("sanitizes payload echoes and secrets at the email boundary", () => {
    const result = renderImmediateAlert("Acme", {
      ...notification,
      body_md:
        'receiver rejected payload={"email":"victim@example.test", "note":"private webhook text"}; authorization: Bearer opaque-token',
    });
    const rendered = `${result.subject}\n${result.html}\n${result.text}`;

    expect(rendered).not.toContain("victim@example.test");
    expect(rendered).not.toContain("private webhook text");
    expect(rendered).not.toContain("opaque-token");
    expect(rendered).toContain("authorization_failed");
  });
});
