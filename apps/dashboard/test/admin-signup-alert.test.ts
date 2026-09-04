import { describe, expect, it } from "vitest";
import {
  listSuperAdminRecipients,
  renderAdminSignupAlert,
  sendAdminSignupAlert,
  type AdminSignupAlertInput,
} from "../lib/admin-signup-alert";

const signup: AdminSignupAlertInput = {
  userId: "usr_new",
  userName: "Ada Lovelace",
  userEmail: "ada@example.com",
  workspaceId: "ws_new",
  workspaceName: "Analytical Engines",
  viaInvite: false,
};

describe("admin signup alerts", () => {
  it("selects only super-admin recipients", async () => {
    let sql = "";
    const rows = await listSuperAdminRecipients({
      query: async <T>(query: string) => {
        sql = query;
        return {
          rows: [{ user_id: "usr_admin", email: "admin@example.com" }] as T[],
          rowCount: 1,
        };
      },
    });

    expect(sql).toContain("is_super_admin = true");
    expect(rows).toEqual([{ user_id: "usr_admin", email: "admin@example.com" }]);
  });

  it("renders the user, workspace, signup type, and admin link", () => {
    const message = renderAdminSignupAlert(signup);

    expect(message.subject).toBe("New Axel signup — ada@example.com");
    expect(message.text).toContain("Ada Lovelace (ada@example.com) created the workspace Analytical Engines.");
    expect(message.text).toContain("New workspace owner");
    expect(message.text).toContain("/admin/users/usr_new");
    expect(message.html).toContain("View user →");
  });

  it("distinguishes an invited signup", () => {
    const message = renderAdminSignupAlert({ ...signup, viaInvite: true });

    expect(message.text).toContain("accepted an invitation to Analytical Engines");
    expect(message.text).toContain("Invited member");
  });

  it("escapes user-controlled values in HTML", () => {
    const message = renderAdminSignupAlert({
      ...signup,
      userName: "<Admin>",
      workspaceName: "A&B <script>",
    });

    expect(message.html).toContain("&lt;Admin&gt;");
    expect(message.html).toContain("A&amp;B &lt;script&gt;");
    expect(message.html).not.toContain("<script>");
  });

  it("continues sending and reports individual failures", async () => {
    const sent: string[] = [];
    const summary = await sendAdminSignupAlert(signup, {
      listRecipients: async () => [
        { user_id: "usr_a", email: "a@example.com" },
        { user_id: "usr_b", email: "b@example.com" },
      ],
      send: async (args) => {
        sent.push(args.to);
        return args.to === "a@example.com"
          ? { ok: false, error: "resend unavailable" }
          : { ok: true };
      },
    });

    expect(sent).toEqual(["a@example.com", "b@example.com"]);
    expect(summary).toMatchObject({ recipients_scanned: 2, emails_sent: 1 });
    expect(summary.errors).toEqual([{ code: "email_send_rejected" }]);
    expect(JSON.stringify(summary)).not.toContain("resend unavailable");
    expect(JSON.stringify(summary)).not.toContain("usr_a");
  });

  it("turns recipient lookup failures into a non-throwing summary", async () => {
    const summary = await sendAdminSignupAlert(signup, {
      listRecipients: async () => {
        throw new Error("database unavailable");
      },
      send: async () => {
        throw new Error("should not send");
      },
    });

    expect(summary.emails_sent).toBe(0);
    expect(summary.errors).toEqual([{ code: "recipient_lookup_failed" }]);
    expect(JSON.stringify(summary)).not.toContain("database unavailable");
  });
});
