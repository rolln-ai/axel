"use server";

// Workspace + team server actions: workspace create/switch/settings, members, invites.

import { randomBytes } from "node:crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
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
import { prefixedId, slugifyWorkspaceName } from "./ids";
import { bustWorkspaceTags } from "./repositories";
import { upsertNotificationPreferences } from "./notifications";
import { requireAuthenticatedUser, requireSession, setActiveWorkspaceId } from "./session";
import { withWorkspaceMutation } from "./with-mutation";
import { isSupportedWorkspaceTimezone } from "./timezones";
import { writeAudit } from "./audit";
import { formValue } from "./form";
import { appBaseUrl } from "./app-url";
import { normalizeEmail, tokenHash, detectWorkspaceTimezone } from "./account-shared";
import type { ActionState } from "./action-data";

export async function createWorkspace(_state: ActionState, formData: FormData): Promise<ActionState> {
  // Use requireAuthenticatedUser (not requireSession) so a user with ZERO
  // workspaces — e.g. someone who just deleted their last one and landed on
  // /welcome — can still create their first. requireSession() would bounce
  // them to /login because getCurrentSession() returns null without a
  // workspace membership.
  const auth = await requireAuthenticatedUser();
  const workspaceName = formValue(formData, "workspaceName");
  const timezone = await detectWorkspaceTimezone(formData);

  if (workspaceName.length < 2 || workspaceName.length > 80) {
    return { error: "Workspace name must be between 2 and 80 characters." };
  }

  let workspaceId = "";
  try {
    workspaceId = await withTransaction(async (client) => {
      const nextWorkspaceId = prefixedId("ws");
      await client.query(
        `INSERT INTO workspaces (id, name, slug, timezone)
         VALUES ($1, $2, $3, $4)`,
        [
          nextWorkspaceId,
          workspaceName,
          `${slugifyWorkspaceName(workspaceName)}-${randomBytes(3).toString("hex")}`,
          timezone,
        ],
      );
      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role)
         VALUES ($1, $2, 'owner')`,
        [nextWorkspaceId, auth.user.id],
      );
      await writeAudit(client, {
        workspaceId: nextWorkspaceId,
        actorUserId: auth.user.id,
        action: "workspace.created",
        targetType: "workspace",
        targetId: nextWorkspaceId,
      });
      return nextWorkspaceId;
    });
  } catch {
    console.error("[createWorkspace] transaction failed");
    return { error: "Could not create the workspace. Try again." };
  }

  await setActiveWorkspaceId(workspaceId);
  redirect("/dashboard");
}

export async function switchWorkspace(formData: FormData): Promise<void> {
  const session = await requireSession();
  const workspaceId = formValue(formData, "workspaceId");
  const membership = session.memberships.find((item) => item.workspace_id === workspaceId);

  if (!membership) redirect("/dashboard");

  await setActiveWorkspaceId(membership.workspace_id);
  redirect("/dashboard");
}

export async function updateWorkspaceSettings(_state: ActionState, formData: FormData): Promise<ActionState> {
  return withWorkspaceMutation({ role: "any" }, async ({ session, workspaceId, audit }) => {
    const role = session.activeWorkspace.role;
    if (role !== "owner" && role !== "admin") {
      return { error: "Only owners and admins can update workspace settings." };
    }

    const name = formValue(formData, "workspaceName");
    if (name.length < 2 || name.length > 80) {
      return { error: "Workspace name must be between 2 and 80 characters." };
    }

    const timezone = formValue(formData, "workspaceTimezone");
    if (!isSupportedWorkspaceTimezone(timezone)) {
      return { error: "Choose a supported timezone." };
    }
    const currentName = session.activeWorkspace.workspace_name;
    const currentTimezone = session.activeWorkspace.workspace_timezone;
    const nameChanged = name !== currentName;
    const timezoneChanged = timezone !== currentTimezone;

    if (!nameChanged && !timezoneChanged) {
      return { notice: "Workspace settings are already up to date." };
    }

    const slug = nameChanged ? `${slugifyWorkspaceName(name)}-${randomBytes(3).toString("hex")}` : null;
    try {
      await withTransaction(async (client) => {
        await client.query(
          `UPDATE workspaces
              SET name = $1,
                  slug = COALESCE($2, slug),
                  timezone = $3
            WHERE id = $4`,
          [name, slug, timezone, workspaceId],
        );
        await audit({
          action: "workspace.settings_updated",
          targetType: "workspace",
          targetId: workspaceId,
          metadata: {
            ...(nameChanged ? { name } : {}),
            ...(timezoneChanged ? { timezone } : {}),
          },
        }, client);
      });
    } catch {
      console.error("[updateWorkspaceSettings] failed");
      return { error: "Could not update workspace settings. Try again." };
    }

    bustWorkspaceTags(workspaceId);
    return { notice: "Workspace settings updated." };
  });
}

/**
 * Per-user notification preferences. Any member can set their own — these gate
 * the EMAIL lanes only (in-app notifications always appear). Unchecked
 * checkboxes are absent from FormData, so presence == enabled.
 */
export async function updateNotificationPreferencesAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSession();
  const update = {
    email_digest_daily: formData.has("email_digest_daily"),
    email_immediate: formData.has("email_immediate"),
  };
  try {
    await upsertNotificationPreferences(
      session.activeWorkspace.workspace_id,
      session.user.id,
      update,
    );
    await writeAudit(db(), {
      workspaceId: session.activeWorkspace.workspace_id,
      actorUserId: session.user.id,
      action: "notification_preferences.updated",
      targetType: "user",
      targetId: session.user.id,
      metadata: update,
    });
  } catch {
    console.error("[updateNotificationPreferencesAction] failed");
    return { error: "Could not save notification settings. Try again." };
  }
  return { notice: "Notification settings saved." };
}

export async function inviteMember(_state: ActionState, formData: FormData): Promise<ActionState> {
  return withWorkspaceMutation({ role: "any" }, async ({ session, workspaceId, actorUserId, audit }) => {
    const actorRole = session.activeWorkspace.role;
    if (actorRole !== "owner" && actorRole !== "admin") return { error: "Only owners and admins can invite members." };

    const email = normalizeEmail(formValue(formData, "email"));
    const role = formValue(formData, "role");
    if (!email || (role !== "admin" && role !== "member")) return { error: "Enter an email and role." };

    // Don't stack duplicate pending invites — every token works, so re-inviting
    // produced a confusing pile of live links for the same person.
    const existingInvite = await db().query<{ id: string }>(
      `SELECT id FROM workspace_invites
        WHERE workspace_id = $1 AND lower(email) = lower($2)
          AND accepted_at IS NULL AND expires_at > now()
        LIMIT 1`,
      [workspaceId, email],
    );
    if (existingInvite.rows[0]) {
      return { notice: `${email} already has a pending invite to this workspace.` };
    }

    const token = randomBytes(32).toString("base64url");
    await db().query(
      `INSERT INTO workspace_invites (id, workspace_id, email, role, token_hash, invited_by_user_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + interval '14 days')`,
      [prefixedId("inv"), workspaceId, email, role, tokenHash(token), actorUserId],
    );
    await audit({
      action: "member.invited",
      targetType: "workspace_invite",
      targetId: email,
      metadata: { role },
    });

    // The invite row now exists whether or not the email below sends — refresh
    // the /team invites table like every sibling member mutation does, so the
    // new pending invite is visible without a manual reload.
    revalidatePath("/team");

    // Email the invitee an ABSOLUTE accept link. Previously the action returned a
    // bare relative path ("/signup?invite=…") with no email, so invitees were
    // unreachable unless the inviter knew the deployment URL and forwarded it.
    const link = `${appBaseUrl()}/signup?invite=${encodeURIComponent(token)}`;
    const subject = "You're invited to a workspace on Axel";
    const text = [
      `You've been invited to join a workspace on Axel as ${role}.`,
      "",
      "Accept the invite and create your account (link expires in 14 days):",
      link,
      "",
      "If you weren't expecting this, you can safely ignore this email.",
      emailTextSignature(),
    ].join("\n");
    const html = renderBrandedEmail({
      preheader: `You've been invited to join a workspace on Axel as ${role}.`,
      contentHtml: [
        emailHeading("You're invited to Axel"),
        emailParagraph(`You've been invited to join a workspace on Axel as <strong>${escapeHtml(role)}</strong>.`),
        emailParagraph("Accept the invite and create your account — the link expires in 14 days."),
        emailButton(link, "Accept invite"),
        emailLinkFallback(link),
        emailNote("If you weren't expecting this, you can safely ignore this email."),
      ].join(""),
    });
    const sent = await sendEmail({ to: email, subject, html, text });
    if (!sent.ok) {
      console.error("[inviteMember] invite email failed");
      // Email failed (e.g. RESEND_API_KEY unset) — still surface the absolute link
      // so the inviter can share it manually rather than being stuck.
      return { notice: `Invite created, but the email couldn't be sent. Share this link: ${link}` };
    }
    return { notice: `Invite sent to ${email}.` };
  });
}

/**
 * Remove a member from the active workspace. Owner/admin only; only an owner may
 * remove another owner, and the last owner can never be removed (it would orphan
 * the workspace). Audit-logged.
 */
export async function removeMemberAction(_state: ActionState, formData: FormData): Promise<ActionState> {
  return withWorkspaceMutation({ role: "any" }, async ({ session, workspaceId, audit }) => {
    const actorRole = session.activeWorkspace.role;
    if (actorRole !== "owner" && actorRole !== "admin") return { error: "Only owners and admins can manage members." };

    const userId = formValue(formData, "user_id");
    if (!userId) return { error: "Missing member." };

    const target = await db().query<{ role: string }>(
      "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, userId],
    );
    const targetRole = target.rows[0]?.role;
    if (!targetRole) return { error: "That member isn't in this workspace." };
    if (targetRole === "owner" && actorRole !== "owner") {
      return { error: "Only an owner can remove another owner." };
    }
    if (targetRole === "owner" && (await countWorkspaceOwners(workspaceId)) <= 1) {
      return { error: "Can't remove the last owner. Make someone else an owner first." };
    }

    const res = await db().query(
      "DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, userId],
    );
    if (res.rowCount === 0) return { error: "That member isn't in this workspace." };

    await audit({
      action: "member.removed",
      targetType: "user",
      targetId: userId,
      metadata: { role: targetRole },
    });
    revalidatePath("/team");
    return { notice: "Member removed." };
  });
}

/**
 * Change a member's role. Owner/admin only; only an owner may grant or revoke the
 * owner role, and the last owner can't be demoted. Audit-logged.
 */
export async function changeMemberRoleAction(_state: ActionState, formData: FormData): Promise<ActionState> {
  return withWorkspaceMutation({ role: "any" }, async ({ session, workspaceId, audit }) => {
    const actorRole = session.activeWorkspace.role;
    if (actorRole !== "owner" && actorRole !== "admin") return { error: "Only owners and admins can manage members." };

    const userId = formValue(formData, "user_id");
    const role = formValue(formData, "role");
    if (!userId || (role !== "owner" && role !== "admin" && role !== "member")) {
      return { error: "Pick a valid role." };
    }

    const target = await db().query<{ role: string }>(
      "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, userId],
    );
    const targetRole = target.rows[0]?.role;
    if (!targetRole) return { error: "That member isn't in this workspace." };
    if (targetRole === role) return { notice: `Member is already ${role}.` };
    if ((role === "owner" || targetRole === "owner") && actorRole !== "owner") {
      return { error: "Only an owner can grant or revoke the owner role." };
    }
    if (targetRole === "owner" && role !== "owner" && (await countWorkspaceOwners(workspaceId)) <= 1) {
      return { error: "Can't demote the last owner. Promote someone else first." };
    }

    await db().query(
      "UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, userId, role],
    );
    await audit({
      action: "member.role_changed",
      targetType: "user",
      targetId: userId,
      metadata: { from: targetRole, to: role },
    });
    revalidatePath("/team");
    return { notice: `Role updated to ${role}.` };
  });
}

/**
 * Cancel a pending (un-accepted) invite. Owner/admin only; workspace-scoped.
 */
export async function cancelInviteAction(_state: ActionState, formData: FormData): Promise<ActionState> {
  return withWorkspaceMutation({ role: "any" }, async ({ session, workspaceId, audit }) => {
    const actorRole = session.activeWorkspace.role;
    if (actorRole !== "owner" && actorRole !== "admin") return { error: "Only owners and admins can manage invites." };

    const inviteId = formValue(formData, "invite_id");
    if (!inviteId) return { error: "Missing invite." };

    const res = await db().query(
      "DELETE FROM workspace_invites WHERE id = $1 AND workspace_id = $2 AND accepted_at IS NULL",
      [inviteId, workspaceId],
    );
    if (res.rowCount === 0) return { error: "Invite not found or already accepted." };

    await audit({
      action: "invite.canceled",
      targetType: "workspace_invite",
      targetId: inviteId,
      metadata: {},
    });
    revalidatePath("/team");
    return { notice: "Invite canceled." };
  });
}

async function countWorkspaceOwners(workspaceId: string): Promise<number> {
  const owners = await db().query<{ n: string }>(
    "SELECT count(*)::text AS n FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'",
    [workspaceId],
  );
  return Number(owners.rows[0]?.n ?? "0");
}
