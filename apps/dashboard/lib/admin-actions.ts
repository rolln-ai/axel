"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { computePlanState, pushPlanStates } from "./billing/plan-state";
import { db, withTransaction } from "./db";
import { sendEmail } from "./email";
import {
  emailButton,
  emailHeading,
  emailLinkFallback,
  emailNote,
  emailParagraph,
  emailTextSignature,
  escapeHtml,
  renderBrandedEmail,
} from "./email-layout";
import {
  requireEdgeSourceAuthoritySyncs,
  requireEdgeSourceFences,
} from "./edge-invalidation";
import { teardownSingleWorkspace } from "./workspace-teardown";
import { issuePasswordResetToken } from "./password-reset";
import { bustWorkspaceTags } from "./repositories";
import { requireSuperAdmin } from "./admin-auth";
import {
  currentSessionTokenHash,
  startImpersonation,
  stopImpersonation,
} from "./impersonation";
import type { ActionState } from "./action-data";
import { writeAudit } from "./audit";
import { appBaseUrl } from "./app-url";
import { formValue } from "./form";

/* ----------------------------- workspaces ------------------------------- */

interface PriorSourceStatus {
  id: string;
  status: string;
}

export async function suspendWorkspaceAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await requireSuperAdmin();
  const workspaceId = formValue(formData, "workspace_id");
  const reason = formValue(formData, "reason") || null;
  const confirmSelf = formValue(formData, "confirm_self") === "yes";

  if (!workspaceId) return { error: "Missing workspace id." };

  try {
    const result = await withTransaction(async (client) => {
      const wsResult = await client.query<{ status: string }>(
        "SELECT COALESCE(status, 'active') AS status FROM workspaces WHERE id = $1 FOR UPDATE",
        [workspaceId],
      );
      if (!wsResult.rows[0]) throw new Error("not_found");
      if (wsResult.rows[0].status === "suspended") {
        const sources = await client.query<{ id: string }>(
          "SELECT id FROM sources WHERE workspace_id = $1",
          [workspaceId],
        );
        const fences = await requireEdgeSourceFences(sources.rows.map((source) => source.id));
        return { kind: "already_suspended" as const, fences, prior: [] as PriorSourceStatus[] };
      }

      const ownsResult = await client.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM workspace_members
          WHERE workspace_id = $1 AND user_id = $2`,
        [workspaceId, auth.user.id],
      );
      if (Number(ownsResult.rows[0]?.c ?? 0) > 0 && !confirmSelf) {
        throw new Error("self_suspend_unconfirmed");
      }

      const sourcesResult = await client.query<{ id: string; status: string }>(
        "SELECT id, status FROM sources WHERE workspace_id = $1",
        [workspaceId],
      );
      const prior: PriorSourceStatus[] = sourcesResult.rows;
      const fences = await requireEdgeSourceFences(prior.map((source) => source.id));

      await client.query(
        `UPDATE workspaces
            SET status = 'suspended',
                suspended_at = now(),
                suspended_by_user_id = $2,
                suspension_reason = $3
          WHERE id = $1`,
        [workspaceId, auth.user.id, reason],
      );

      if (prior.length > 0) {
        await client.query(
          "UPDATE sources SET status = 'disabled', updated_at = now() WHERE workspace_id = $1",
          [workspaceId],
        );
      }

      await writeAudit(client, {
        workspaceId,
        actorUserId: auth.user.id,
        action: "admin.workspace.suspended",
        targetType: "workspace",
        targetId: workspaceId,
        metadata: { reason, prior_source_statuses: prior },
      });

      return { kind: "suspended" as const, fences, prior };
    });

    await requireEdgeSourceAuthoritySyncs(result.fences, workspaceId);
    if (result.kind === "already_suspended") {
      return { error: "Workspace is already suspended." };
    }
  } catch (err) {
    if (err instanceof Error && err.message === "not_found") return { error: "Workspace not found." };
    if (err instanceof Error && err.message === "self_suspend_unconfirmed") {
      return { error: "You belong to this workspace — confirm self-suspension to continue." };
    }
    console.error("[admin] suspendWorkspaceAction failed");
    return { error: "Could not suspend workspace." };
  }

  bustWorkspaceTags(workspaceId);
  revalidatePath(`/admin/workspaces/${workspaceId}`);
  revalidatePath("/admin/workspaces");
  return {
    notice: "Workspace suspended. The edge authority confirms every source is disabled.",
  };
}

export async function unsuspendWorkspaceAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await requireSuperAdmin();
  const workspaceId = formValue(formData, "workspace_id");
  if (!workspaceId) return { error: "Missing workspace id." };

  try {
    const restored = await withTransaction(async (client) => {
      const wsResult = await client.query<{ status: string }>(
        "SELECT COALESCE(status, 'active') AS status FROM workspaces WHERE id = $1 FOR UPDATE",
        [workspaceId],
      );
      if (!wsResult.rows[0]) throw new Error("not_found");
      if (wsResult.rows[0].status !== "suspended") throw new Error("not_suspended");

      // Find the most recent suspension audit row to recover prior source
      // statuses. If we can't find one (manual SQL edits, etc.) we leave
      // sources disabled — admin can re-enable individually.
      const auditResult = await client.query<{
        metadata: { prior_source_statuses?: PriorSourceStatus[] };
      }>(
        `SELECT metadata
           FROM audit_log
          WHERE workspace_id = $1
            AND action = 'admin.workspace.suspended'
          ORDER BY created_at DESC
          LIMIT 1`,
        [workspaceId],
      );
      const priors = auditResult.rows[0]?.metadata?.prior_source_statuses ?? [];
      const restoredSourceIds = priors
        .filter((prior) => prior.status !== "disabled")
        .map((prior) => prior.id);
      const currentSources = await client.query<{ id: string }>(
        "SELECT id FROM sources WHERE workspace_id = $1",
        [workspaceId],
      );
      // Sync disabled sources too. This repairs any fence left by a prior
      // post-commit failure without enabling a source the audit did not list.
      const fences = await requireEdgeSourceFences(
        currentSources.rows.map((source) => source.id),
      );

      await client.query(
        `UPDATE workspaces
            SET status = 'active',
                suspended_at = NULL,
                suspended_by_user_id = NULL,
                suspension_reason = NULL
          WHERE id = $1`,
        [workspaceId],
      );

      for (const prior of priors) {
        if (prior.status !== "disabled") {
          await client.query(
            "UPDATE sources SET status = $2, updated_at = now() WHERE id = $1 AND workspace_id = $3",
            [prior.id, prior.status, workspaceId],
          );
        }
      }

      await writeAudit(client, {
        workspaceId,
        actorUserId: auth.user.id,
        action: "admin.workspace.unsuspended",
        targetType: "workspace",
        targetId: workspaceId,
        metadata: { restored_source_ids: restoredSourceIds },
      });

      return { fences };
    });

    await requireEdgeSourceAuthoritySyncs(restored.fences, workspaceId);
  } catch (err) {
    if (err instanceof Error && err.message === "not_found") return { error: "Workspace not found." };
    if (err instanceof Error && err.message === "not_suspended") return { error: "Workspace is not suspended." };
    console.error("[admin] unsuspendWorkspaceAction failed");
    return { error: "Could not unsuspend workspace." };
  }

  bustWorkspaceTags(workspaceId);
  revalidatePath(`/admin/workspaces/${workspaceId}`);
  revalidatePath("/admin/workspaces");
  return { notice: "Workspace re-activated." };
}

const ALLOWED_PLANS = new Set(["free", "pro", "enterprise"] as const);
type WorkspacePlan = "free" | "pro" | "enterprise";

/**
 * Super-admin override of the workspace's plan tier. Lets ops set a
 * workspace to 'enterprise' (no cap, no Stripe billing — handled
 * off-platform) or back to 'free'/'pro' without going through the
 * Stripe Checkout flow. Used for comp accounts, internal workspaces,
 * and hand-rolled deals.
 *
 * Note: setting plan='pro' here does NOT create a Stripe subscription
 * — it just flips the column. Use this for free→pro comp upgrades;
 * use the Customer Portal for self-serve users.
 */
export async function setWorkspacePlanAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await requireSuperAdmin();
  const workspaceId = formValue(formData, "workspace_id");
  const plan = formValue(formData, "plan") as WorkspacePlan;
  if (!workspaceId) return { error: "Missing workspace id." };
  if (!ALLOWED_PLANS.has(plan)) return { error: "Invalid plan." };

  try {
    await withTransaction(async (client) => {
      const cur = await client.query<{ plan: string }>(
        "SELECT COALESCE(plan, 'free') AS plan FROM workspaces WHERE id = $1 FOR UPDATE",
        [workspaceId],
      );
      if (!cur.rows[0]) throw new Error("not_found");
      if (cur.rows[0].plan === plan) throw new Error("noop");

      await client.query(
        `UPDATE workspaces SET plan = $2 WHERE id = $1`,
        [workspaceId, plan],
      );
      await writeAudit(client, {
        workspaceId,
        actorUserId: auth.user.id,
        action: "admin.workspace.plan_changed",
        targetType: "workspace",
        targetId: workspaceId,
        metadata: { from: cur.rows[0].plan, to: plan },
      });
    });
  } catch (err) {
    if (err instanceof Error && err.message === "not_found") return { error: "Workspace not found." };
    if (err instanceof Error && err.message === "noop") return { notice: "Workspace is already on that plan." };
    console.error("[admin] setWorkspacePlanAction failed");
    return { error: "Could not change plan." };
  }

  // Push fresh gate to the ingest worker so the cap change takes
  // effect within seconds (rather than waiting on the hourly rollup).
  try {
    const planState = await computePlanState(workspaceId);
    if (planState) await pushPlanStates([planState]);
  } catch {
    console.error("[admin] plan-state push failed");
  }

  bustWorkspaceTags(workspaceId);
  revalidatePath(`/admin/workspaces/${workspaceId}`);
  revalidatePath(`/admin/billing/${workspaceId}`);
  revalidatePath("/admin/billing");
  return { notice: `Plan set to ${plan}.` };
}

const ALLOWED_EXEMPT = new Set(["true", "false"]);

export async function setWorkspaceBillingExemptAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await requireSuperAdmin();
  const workspaceId = formValue(formData, "workspace_id");
  const rawExempt = formValue(formData, "exempt");
  if (!workspaceId) return { error: "Missing workspace id." };
  if (!ALLOWED_EXEMPT.has(rawExempt)) return { error: "Invalid exempt value." };
  const exempt = rawExempt === "true";

  try {
    await withTransaction(async (client) => {
      const cur = await client.query<{ billing_exempt: boolean }>(
        "SELECT COALESCE(billing_exempt, false) AS billing_exempt FROM workspaces WHERE id = $1 FOR UPDATE",
        [workspaceId],
      );
      if (!cur.rows[0]) throw new Error("not_found");
      if (cur.rows[0].billing_exempt === exempt) throw new Error("noop");

      await client.query("UPDATE workspaces SET billing_exempt = $2 WHERE id = $1", [workspaceId, exempt]);
      await writeAudit(client, {
        workspaceId,
        actorUserId: auth.user.id,
        action: "admin.workspace.billing_exempt_set",
        targetType: "workspace",
        targetId: workspaceId,
        metadata: { billing_exempt: exempt },
      });
    });
  } catch (err) {
    if (err instanceof Error && err.message === "not_found") return { error: "Workspace not found." };
    if (err instanceof Error && err.message === "noop") {
      return { notice: exempt ? "Workspace is already billing-exempt." : "Workspace is not billing-exempt." };
    }
    console.error("[admin] setWorkspaceBillingExemptAction failed");
    return { error: "Could not update billing exemption." };
  }

  // Push the fresh gate so the ingest worker lifts (or re-applies) enforcement
  // within seconds instead of waiting on the hourly rollup.
  try {
    const planState = await computePlanState(workspaceId);
    if (planState) await pushPlanStates([planState]);
  } catch {
    console.error("[admin] plan-state push failed");
  }

  bustWorkspaceTags(workspaceId);
  revalidatePath(`/admin/workspaces/${workspaceId}`);
  revalidatePath("/admin/workspaces");
  revalidatePath(`/admin/billing/${workspaceId}`);
  return {
    notice: exempt
      ? "Workspace is now billing-exempt — no card required, no quota or suspension limits."
      : "Billing exemption removed — normal plan limits now apply.",
  };
}

/**
 * Delete a workspace as super-admin. Two-phase like the self-serve delete
 * (lib/danger-zone-actions.ts deleteCurrentWorkspace): flip to 'deleting', disable its
 * sources so the edge stops accepting new events, and let the
 * workspace-teardown cron do the full cleanup — Stripe cancellation +
 * ClickHouse/R2 wipe + hard delete. The old inline DELETE skipped the external
 * stores, orphaning analytics + raw payloads.
 */
export async function deleteWorkspaceAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await requireSuperAdmin();
  const workspaceId = formValue(formData, "workspace_id");
  const typedName = formValue(formData, "confirm_name");
  if (!workspaceId) return { error: "Missing workspace id." };
  if (!typedName) return { error: "Type the workspace name to confirm." };

  let sourceFences: Awaited<ReturnType<typeof requireEdgeSourceFences>> = [];
  try {
    sourceFences = await withTransaction(async (client) => {
      const wsResult = await client.query<{ name: string; status: string }>(
        "SELECT name, COALESCE(status, 'active') AS status FROM workspaces WHERE id = $1 FOR UPDATE",
        [workspaceId],
      );
      const ws = wsResult.rows[0];
      if (!ws) throw new Error("not_found");
      if (ws.name !== typedName) throw new Error("name_mismatch");
      if (ws.status === "deleting") {
        // A prior attempt may have committed and then lost its post-delete
        // cache call. Return every source id so an idempotent retry confirms
        // revocation instead of silently redirecting.
        const sources = await client.query<{ id: string }>(
          "SELECT id FROM sources WHERE workspace_id = $1",
          [workspaceId],
        );
        return requireEdgeSourceFences(sources.rows.map((source) => source.id));
      }

      const sourcesResult = await client.query<{ id: string }>(
        "SELECT id FROM sources WHERE workspace_id = $1",
        [workspaceId],
      );
      const ids = sourcesResult.rows.map((source) => source.id);
      const fences = await requireEdgeSourceFences(ids);

      // Audit while workspace_id is still a live FK target (FK is ON DELETE SET
      // NULL, so the row survives the eventual hard delete in teardown).
      await writeAudit(client, {
        workspaceId,
        actorUserId: auth.user.id,
        action: "admin.workspace.deleted",
        targetType: "workspace",
        targetId: workspaceId,
        metadata: { name: ws.name },
      });

      // Stop the edge from accepting NEW webhooks before the async teardown
      // starts wiping, so nothing re-orphans the stores we're about to clear.
      await client.query(
        `UPDATE sources SET status = 'disabled', updated_at = now()
          WHERE workspace_id = $1 AND status <> 'disabled'`,
        [workspaceId],
      );
      await client.query(
        "UPDATE workspaces SET status = 'deleting', deleted_at = now() WHERE id = $1",
        [workspaceId],
      );
      return fences;
    });
  } catch (err) {
    if (err instanceof Error && err.message === "not_found") return { error: "Workspace not found." };
    if (err instanceof Error && err.message === "name_mismatch") return { error: "Typed name does not match." };
    console.error("[admin] deleteWorkspaceAction failed");
    return { error: "Could not delete workspace." };
  }

  try {
    await requireEdgeSourceAuthoritySyncs(sourceFences, workspaceId);
  } catch {
    console.error("[admin] deleteWorkspaceAction post-commit authority sync failed");
    return { error: "Workspace deletion was scheduled, but edge revocation could not be confirmed. Retry immediately." };
  }
  bustWorkspaceTags(workspaceId);

  revalidatePath("/admin/workspaces");
  redirect("/admin/workspaces");
}

/**
 * Run one teardown step now for a workspace stuck in 'deleting', surfacing the
 * error the cron swallows. Idempotent + staged, so a subscription-bearing
 * workspace may need a couple of clicks; a free one wipes + deletes in one.
 */
export async function retryWorkspaceTeardownAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireSuperAdmin();
  const workspaceId = formValue(formData, "workspace_id");
  if (!workspaceId) return { error: "Missing workspace id." };

  const result = await teardownSingleWorkspace(workspaceId);
  revalidatePath(`/admin/workspaces/${workspaceId}`);
  revalidatePath("/admin/workspaces");

  switch (result.stage) {
    case "deleted":
      return { notice: "Teardown complete — workspace fully deleted." };
    case "error":
      return { error: `Teardown failed: ${result.detail ?? "unknown error"}` };
    default:
      return { notice: `Teardown advanced to '${result.stage}'. Run again to continue.` };
  }
}

/* ------------------------------- users --------------------------------- */

export async function impersonateUserAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await requireSuperAdmin();
  const targetUserId = formValue(formData, "user_id");
  if (!targetUserId) return { error: "Missing user id." };

  // Refuse if the admin is already inside an impersonation.
  if (auth.impersonator) return { error: "Already impersonating — stop the current session first." };

  const targetResult = await db().query<{ id: string; is_super_admin: boolean; email: string }>(
    "SELECT id, is_super_admin, email FROM users WHERE id = $1 LIMIT 1",
    [targetUserId],
  );
  const target = targetResult.rows[0];
  if (!target) return { error: "Target user not found." };
  if (target.is_super_admin) return { error: "Cannot impersonate another super-admin." };
  if (target.id === auth.user.id) return { error: "Cannot impersonate yourself." };

  // Look up the admin's current session row id so we can record it as the
  // return target. (We don't strictly need it now — stopImpersonation issues
  // a fresh admin session — but it makes the audit log linkable.)
  const hash = await currentSessionTokenHash();
  if (!hash) return { error: "Session not found." };
  const adminSessionResult = await db().query<{ id: string }>(
    "SELECT id FROM user_sessions WHERE session_token_hash = $1 LIMIT 1",
    [hash],
  );
  const adminSessionId = adminSessionResult.rows[0]?.id ?? "";

  const result = await startImpersonation({
    targetUserId,
    adminUserId: auth.user.id,
    adminSessionId,
  });

  // Impersonation MUST be audited. The session + audit row aren't a single
  // transaction (startImpersonation also sets the cookie), so if the audit write
  // fails we COMPENSATE: delete the session we just created so there's never an
  // unaudited active impersonation. The dangling impersonation cookie then points
  // at nothing → the admin is treated as logged out and simply re-initiates.
  try {
    await writeAudit(db(), {
      workspaceId: null,
      actorUserId: auth.user.id,
      action: "admin.impersonation.started",
      targetType: "user",
      targetId: targetUserId,
      metadata: {
        target_email: target.email,
        new_session_id: result.newSessionId,
        expires_at: result.expiresAt.toISOString(),
      },
    });
  } catch {
    await db()
      .query("DELETE FROM user_sessions WHERE id = $1", [result.newSessionId])
      .catch(() => {});
    console.error("[admin] impersonation audit write failed; rolled back session");
    return { error: "Could not start impersonation — the audit record failed to write, so no session was created. Try again." };
  }

  revalidatePath("/");
  redirect("/dashboard");
}

export async function stopImpersonationAction(): Promise<void> {
  // We do NOT call requireSuperAdmin here — the current cookie belongs to the
  // impersonated user, who may well not be an admin. We allow anyone holding
  // an impersonated session to stop the impersonation. But we DO require the
  // session to actually BE impersonated — otherwise a stray POST to this
  // action (CSRF, accidental form-action wiring) would log a regular user out.
  const hash = await currentSessionTokenHash();
  if (!hash) {
    redirect("/login");
  }

  const sessionResult = await db().query<{
    id: string;
    user_id: string;
    impersonator_user_id: string | null;
  }>(
    "SELECT id, user_id, impersonator_user_id FROM user_sessions WHERE session_token_hash = $1 AND expires_at > now() LIMIT 1",
    [hash!],
  );
  const sess = sessionResult.rows[0];
  if (!sess || !sess.impersonator_user_id) {
    // Nothing to stop. Send the caller back to a safe place; do not touch
    // the session row or cookie.
    redirect("/dashboard");
  }

  // Audit row first so we still know which admin was acting if anything
  // downstream errors.
  await writeAudit(db(), {
    workspaceId: null,
    actorUserId: sess.impersonator_user_id,
    action: "admin.impersonation.stopped",
    targetType: "user",
    targetId: sess.user_id,
    metadata: { session_id: sess.id },
  });

  const result = await stopImpersonation({ currentSessionTokenHash: hash! });
  // Bust client-cached layouts so the StopImpersonationBar disappears
  // and the AppNav re-renders for the admin user.
  revalidatePath("/");
  if (result.restored) {
    redirect("/admin");
  }
  redirect("/login");
}

export async function sendUserPasswordResetAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await requireSuperAdmin();
  const userId = formValue(formData, "user_id");
  if (!userId) return { error: "Missing user id." };

  const userResult = await db().query<{ email: string; name: string }>(
    "SELECT email, name FROM users WHERE id = $1 LIMIT 1",
    [userId],
  );
  const user = userResult.rows[0];
  if (!user) return { error: "User not found." };

  const { token } = await issuePasswordResetToken(userId, null);
  const link = `${appBaseUrl()}/reset?token=${encodeURIComponent(token)}`;

  const subject = "Reset your Axel password";
  const greetingText = user.name ? `Hi ${user.name},` : "Hi,";
  const text = [
    greetingText,
    "",
    "A password reset was initiated for your Axel account by an administrator.",
    "Use this link to choose a new password — it expires in 30 minutes:",
    link,
    "",
    "If you weren't expecting this, ignore this email and your password will stay unchanged.",
    emailTextSignature(),
  ].join("\n");
  const html = renderBrandedEmail({
    preheader: "An administrator started a password reset for your account.",
    contentHtml: [
      emailHeading("Reset your password"),
      emailParagraph(
        `${user.name ? `Hi <strong>${escapeHtml(user.name)}</strong> — a` : "A"} password reset was initiated for your Axel account by an administrator.`,
      ),
      emailParagraph("Choose a new password using the button below — the link expires in 30 minutes."),
      emailButton(link, "Reset password"),
      emailLinkFallback(link),
      emailNote("If you weren't expecting this, ignore this email and your password will stay unchanged."),
    ].join(""),
  });
  const sent = await sendEmail({ to: user.email, subject, html, text });
  if (!sent.ok) {
    console.error("[admin] sendUserPasswordResetAction email failed");
    return { error: "Could not send the reset email." };
  }

  await writeAudit(db(), {
    workspaceId: null,
    actorUserId: auth.user.id,
    action: "admin.user.password_reset_sent",
    targetType: "user",
    targetId: userId,
    metadata: { email_to: user.email },
  });

  return { notice: `Password-reset email sent to ${user.email}.` };
}

export async function forceLogoutUserAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await requireSuperAdmin();
  const userId = formValue(formData, "user_id");
  if (!userId) return { error: "Missing user id." };

  // Kill both directions of involvement:
  //   - user_id = $1  : the user's own normal sessions
  //   - impersonator_user_id = $1 : sessions where this user is acting AS
  //     someone else. Without this, a malicious or compromised admin's
  //     impersonation sessions would survive a "revoke all" — they'd keep
  //     access to whichever user they were impersonating until that 1h TTL.
  const result = await db().query<{ id: string }>(
    `DELETE FROM user_sessions
      WHERE user_id = $1 OR impersonator_user_id = $1
      RETURNING id`,
    [userId],
  );

  await writeAudit(db(), {
    workspaceId: null,
    actorUserId: auth.user.id,
    action: "admin.user.force_logout",
    targetType: "user",
    targetId: userId,
    metadata: { sessions_revoked: result.rowCount ?? 0 },
  });

  revalidatePath(`/admin/users/${userId}`);
  return { notice: `Revoked ${result.rowCount ?? 0} session(s).` };
}
