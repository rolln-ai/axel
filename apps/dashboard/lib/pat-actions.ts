"use server";

import { createHash, randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { db } from "./db";
import { prefixedId } from "./ids";
import { requireSession } from "./session";
import { withWorkspaceMutation } from "./with-mutation";
import type { ActionState as ActionStateBase } from "./action-state";

/**
 * Server actions for Personal Access Tokens (AXE-26). PATs power the
 * Axel CLI; the dashboard mints / lists / revokes them on the user's
 * Settings → Tokens page.
 *
 * Storage:
 *   - Plaintext token format: `axe_pat_<48-char base32>` (24 random bytes).
 *   - Postgres stores the SHA-256 hex hash in `personal_access_tokens.token_hash`.
 *   - Plaintext is shown to the user EXACTLY ONCE at mint time. We don't
 *     have a "show me the token again" path — losing it requires rotation.
 */

/** `data` is set on successful mint. The form clears once the user has copied. */
export type ActionState = ActionStateBase<{
  plaintextToken?: string;
  tokenName?: string;
  tokenId?: string;
}>;

const TOKEN_PREFIX = "axe_pat_";

function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

function generateTokenPlaintext(): string {
  // 24 random bytes → 32-char base64url, plus the prefix. Long enough
  // to blow past brute-force, short enough to copy-paste.
  return TOKEN_PREFIX + randomBytes(24).toString("base64url");
}

export async function createPersonalAccessToken(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  // PATs are per-user, so members may mint their own (role: "any") — but a
  // suspended workspace must not hand out fresh API credentials.
  return withWorkspaceMutation<ActionState>({ role: "any" }, async ({ workspaceId, actorUserId, audit }) => {
    const rawName = formData.get("name");
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (!name) return { error: "Token name is required (e.g. 'laptop' or 'ci')." };
    if (name.length > 64) return { error: "Token name must be 64 characters or fewer." };

    const plaintext = generateTokenPlaintext();
    const id = prefixedId("pat");
    await db().query(
      `INSERT INTO personal_access_tokens (id, workspace_id, user_id, token_hash, name)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, workspaceId, actorUserId, hashToken(plaintext), name],
    );
    await audit({
      action: "pat.created",
      targetType: "personal_access_token",
      targetId: id,
      metadata: { name },
  });
  revalidatePath("/settings");

  return {
    notice: `Token "${name}" minted. Copy it now — this is the only time it'll be shown.`,
    data: { plaintextToken: plaintext, tokenName: name, tokenId: id },
  };
  });
}

export async function revokePersonalAccessToken(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return withWorkspaceMutation<ActionState>({ role: "any" }, async ({ workspaceId, actorUserId, audit }) => {
    const rawId = formData.get("token_id");
    const id = typeof rawId === "string" ? rawId.trim() : "";
    if (!id) return { error: "Token id is required." };

    const result = await db().query<{ name: string }>(
      `UPDATE personal_access_tokens
          SET revoked_at = now()
        WHERE id = $1 AND user_id = $2 AND workspace_id = $3 AND revoked_at IS NULL
        RETURNING name`,
      [id, actorUserId, workspaceId],
    );
    if (!result.rowCount) return { error: "Token not found or already revoked." };

    await audit({
      action: "pat.revoked",
      targetType: "personal_access_token",
      targetId: id,
      metadata: { name: result.rows[0]!.name },
  });
  revalidatePath("/settings");
  return { notice: `Token "${result.rows[0]!.name}" revoked. The CLI will lose access immediately.` };
  });
}

export interface PatRow {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export async function listPersonalAccessTokens(): Promise<PatRow[]> {
  const session = await requireSession();
  const result = await db().query<PatRow>(
    `SELECT id, name,
            created_at::text AS created_at,
            last_used_at::text AS last_used_at,
            revoked_at::text AS revoked_at
       FROM personal_access_tokens
      WHERE workspace_id = $1 AND user_id = $2
      ORDER BY created_at DESC
      LIMIT 50`,
    [session.activeWorkspace.workspace_id, session.user.id],
  );
  return result.rows;
}
